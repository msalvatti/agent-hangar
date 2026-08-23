/**
 * Creating one workspace container for a turn to run in.
 *
 * Layer: service.
 *
 * Shared by chat turns and scheduled runs so that "how a workspace is born" has one description:
 * a row first, then the container, then the row again. Writing the row
 * before the container is what makes an interrupted create discoverable — the garbage collector
 * reconciles both directions, by workspace id rather than by container reference, because the id
 * is the only identifier both sides have before the container exists.
 *
 * That reconciliation has one blind spot, and this file is where it has to be closed. A `CREATING`
 * row is deliberately exempt from being closed out: it means a create is in flight and will write
 * its own next status. When the write that would have done so is the thing that fails, the row and
 * its container agree with each other — same id on both sides — so neither the orphan sweep nor
 * the gone sweep touches either, and nothing reclaims them. The reference exists only in this
 * call, so the container is destroyed here rather than left to a collector that will never see it.
 *
 * Security: nothing here is decrypted. A credential belongs to one execution and reaches the
 * container as a file placed immediately before the runtime starts — see `workspace-credentials.ts`
 * — because a workspace outlives the turn that built it, and anything handed over at create time
 * would stay readable inside it for as long as it stands. What this function asks of the secrets
 * service is only whether the two are configured at all, so an operator who has set neither is told
 * before a container is built rather than after.
 *
 * The forge allow-list is applied again here for the reason it always was: the write routes check a
 * repository URL when a chat or a job is created, but the URL is then stored and cloned by every
 * later turn, so a forge the operator has since removed from `ALLOWED_REPO_HOSTS` would keep
 * receiving the PAT through rows that were legitimate when they were written. It runs before the
 * container exists, so a repository that is no longer allowed never gets one.
 *
 * That same check is what the container is bound to. It yields one origin, and the container is
 * told that origin and nothing else: the askpass helper releases the PAT only for it, and the
 * agent runtime clones only from it. Handing the container the allow-list instead would be a wider
 * grant than the workspace needs, because both readers decide from a URL the agent can influence,
 * so a list would let a crafted URL pick any entry on it.
 *
 * It travels as a file rather than as an environment entry. The workspace runs shell commands a
 * model chose, and a command sets whatever variables it likes for the process it starts, so a
 * policy read from the environment is a policy the workspace can rewrite — for the credential
 * helper, that would mean choosing which origin the PAT is released to. The runner places the file
 * root-owned before the container starts; see `WorkspaceSpec.files`.
 */
import {
  describeClientFailure,
  parseAllowedRepoHosts,
  repoUrlForHosts,
  WorkspaceImageMissing,
} from '@agent-hangar/core';
import type { Workspace, WorkspaceHandle, WorkspaceKind } from '@agent-hangar/core';

import { isTransportError } from '../errors.js';

import {
  ALLOWED_ORIGIN_PATH,
  ASKPASS_PATH,
  LABELS,
  SECRETS_MISSING_CODE,
  SECRETS_MISSING_MESSAGE,
  SECRETS_MISSING_REASON,
  WORKSPACE_LIMITS,
} from './constants.js';
import type { ProcessorDeps } from './types.js';

/** Why a workspace could not be provisioned. */
export type ProvisionFailureReason =
  | 'repo_url_not_allowed'
  | typeof SECRETS_MISSING_CODE
  | 'workspace_image_missing'
  | 'workspace_create_failed';

/** `Workspace.failureReason` written when the container could not be recorded on its row. */
export const UNRECORDED_WORKSPACE_REASON = 'container reference was never recorded';

/** `Workspace.failureReason` written when the repository is not on the configured forge list. */
export const REPO_URL_NOT_ALLOWED_REASON = 'repository host is not allowed';

/** Failure code reported for a repository that is not on the configured forge list. */
export const REPO_URL_NOT_ALLOWED_CODE: ProvisionFailureReason = 'repo_url_not_allowed';

/**
 * What the user is told when the stored repository is no longer allowed.
 *
 * It names the variable and nothing else. Quoting the repository URL back would put a value the
 * redactor does not know about into a persisted, displayed message, and the operator who has to
 * act on it is reading the configuration, not this string.
 */
export const REPO_URL_NOT_ALLOWED_MESSAGE =
  'This repository is not on an origin listed in ALLOWED_REPO_HOSTS.';

/** Outcome of {@link provisionWorkspace}. */
export type ProvisionResult =
  | { ok: true; workspace: Workspace; handle: WorkspaceHandle }
  | {
      ok: false;
      reason: ProvisionFailureReason;
      message: string;
      /** The row that was created and marked `FAILED`, when one was. */
      workspaceId: string;
    };

/** What a workspace is being provisioned for. */
export interface ProvisionInput {
  kind: WorkspaceKind;
  /** Set for a chat workspace; carried as the `ah.chat` label. */
  chatId?: string;
  /** Set for a scheduled run's workspace; carried as the `ah.jobRun` label. */
  jobRunId?: string;
  /** Credential-free repository URL. */
  repoUrl: string;
  /** Branch the workspace is created for. */
  branch: string;
}

/**
 * Builds the container labels, which are also the garbage collector's only selector.
 *
 * @param deps - For the instance name.
 * @param input - What the workspace serves.
 * @param workspaceId - The row's id.
 * @returns The label set.
 */
function labelsFor(
  deps: ProcessorDeps,
  input: ProvisionInput,
  workspaceId: string,
): Record<string, string> {
  return {
    [LABELS.instance]: deps.config.AH_INSTANCE,
    [LABELS.workspace]: workspaceId,
    [LABELS.kind]: input.kind,
    // Spread conditionally because a workspace serves a chat or a run and never both, and a label
    // set is `Record<string, string>`: a key carrying nothing is not a label the daemon can be
    // asked about, so the absent one is left out rather than set to nothing.
    // Stryker disable next-line ConditionalExpression
    ...(input.chatId === undefined ? {} : { [LABELS.chat]: input.chatId }),
    // Stryker disable next-line ConditionalExpression
    ...(input.jobRunId === undefined ? {} : { [LABELS.jobRun]: input.jobRunId }),
  };
}

/**
 * Records a provisioning failure on the workspace row and reports it to the caller.
 *
 * @param deps - Repositories.
 * @param workspaceId - Row to close out.
 * @param reason - Why it failed.
 * @param message - What the user is told; already safe to persist.
 * @param failureReason - What the row records.
 * @returns The failure result.
 */
async function failWorkspace(
  deps: ProcessorDeps,
  workspaceId: string,
  reason: ProvisionFailureReason,
  message: string,
  failureReason: string,
): Promise<ProvisionResult> {
  await deps.repos.workspaces.setStatus(workspaceId, 'FAILED', { failureReason });
  return { ok: false, reason, message, workspaceId };
}

/**
 * Opens the row a workspace is born as, before anything exists to point it at.
 *
 * @param deps - Repositories and configuration.
 * @param input - What the workspace serves.
 * @returns The `CREATING` row.
 * @throws LiveWorkspaceExistsError When the chat already has a live workspace.
 */
async function openWorkspaceRow(deps: ProcessorDeps, input: ProvisionInput): Promise<Workspace> {
  return deps.repos.workspaces.create({
    kind: input.kind,
    // Spread conditionally because `chatId` is an optional property this project may not hand an
    // explicit `undefined`; the repository writes the absent one as `null` either way, so no
    // reader can tell the two spellings apart.
    // Stryker disable next-line ConditionalExpression
    ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    runnerKind: deps.runner.kind,
    image: deps.config.WORKSPACE_IMAGE,
    repoUrl: input.repoUrl,
    branch: input.branch,
  });
}

/**
 * Takes a workspace provisioning left `READY`, for the work about to run inside it.
 *
 * Conditional, because `READY` is the one live status nobody owns and the collector may take it
 * first. A job workspace is the more exposed case: its idle clock is `lastActiveAt`, stamped when
 * the row is inserted and never bumped for a job workspace, because only a chat turn calls
 * `markActive`. Provisioning that outlives the TTL therefore leaves the row eligible the instant it
 * turns `READY`, and the collector runs on its own queue — so it can take it inside this process,
 * not merely across workers. An unconditional write would put the row back `BUSY` over a teardown
 * that had already committed to destroying the container, and the work would exec into it.
 *
 * @param deps - Repositories.
 * @param workspaceId - The workspace provisioning produced.
 * @returns The row, now `BUSY`, or `null` when another writer took it first.
 */
export async function takeReadyWorkspace(
  deps: ProcessorDeps,
  workspaceId: string,
): Promise<Workspace | null> {
  return deps.repos.workspaces.claimStatus(workspaceId, 'READY', 'BUSY');
}

/**
 * The origin a stored repository URL names, when the operator still allows that origin.
 *
 * The list is read from configuration on every call rather than captured once, so removing an
 * origin takes effect on the next turn instead of on the next restart of this process. Callers
 * that reach a repository without provisioning a workspace — a chat whose container is still
 * running — have to ask this themselves; provisioning asks it below.
 *
 * The origin comes back rather than a verdict because it is what the container is then told. It is
 * `URL.origin` of the very URL that has just been measured, which is also how the allow-list
 * entries were normalised, so what the container enforces is the same origin the operator
 * authorised, in the same spelling.
 *
 * @param deps - For the configured allow-list.
 * @param repoUrl - The stored repository URL.
 * @returns The origin, or `null` when the URL is unusable or its origin is not allowed.
 */
export function allowedRepoOrigin(deps: ProcessorDeps, repoUrl: string): string | null {
  const allowed = repoUrlForHosts(parseAllowedRepoHosts(deps.config.ALLOWED_REPO_HOSTS));
  const result = allowed.safeParse(repoUrl);
  const parsed = result.success ? URL.parse(result.data) : null;
  return parsed === null ? null : parsed.origin;
}

/**
 * Whether a stored repository URL still names an origin the operator allows.
 *
 * @param deps - For the configured allow-list.
 * @param repoUrl - The stored repository URL.
 * @returns `true` when the URL names one repository on a currently allowed origin.
 */
export function isRepoUrlAllowed(deps: ProcessorDeps, repoUrl: string): boolean {
  return allowedRepoOrigin(deps, repoUrl) !== null;
}

/** The origin a workspace may reach, or the refusal already recorded on its row. */
type OriginDecision =
  | { readonly allowed: true; readonly origin: string }
  | { readonly allowed: false; readonly refusal: ProvisionResult };

/**
 * Resolves the one origin this workspace's container may reach, or refuses a repository the
 * operator no longer allows — either way before anything has been decrypted.
 *
 * Resolving and refusing are the same act on purpose: the origin the container is bound to can
 * only be one that has just passed the allow-list, because it is the value that passing it
 * produced.
 *
 * @param deps - Configuration and repositories.
 * @param input - What the workspace serves.
 * @param workspaceId - The row already opened for it.
 * @returns The origin, or the failure result recorded for a repository that is not allowed.
 */
async function resolveWorkspaceOrigin(
  deps: ProcessorDeps,
  input: ProvisionInput,
  workspaceId: string,
): Promise<OriginDecision> {
  const origin = allowedRepoOrigin(deps, input.repoUrl);
  if (origin !== null) {
    return { allowed: true, origin };
  }
  return {
    allowed: false,
    refusal: await failWorkspace(
      deps,
      workspaceId,
      REPO_URL_NOT_ALLOWED_CODE,
      REPO_URL_NOT_ALLOWED_MESSAGE,
      REPO_URL_NOT_ALLOWED_REASON,
    ),
  };
}

/**
 * Closes the row out for a container that could not be created, and says what kind of failure it
 * was.
 *
 * @param deps - Repositories, redactor and image status.
 * @param workspaceId - The row the create was for.
 * @param error - What the runner rejected with.
 * @returns The failure result, for the two kinds a retry would only repeat.
 * @throws unknown The original error when the daemon was unreachable, so the job is failed rather
 *   than the workspace; nothing redelivers it, so the caller records the turn or run first.
 */
async function failedCreate(
  deps: ProcessorDeps,
  workspaceId: string,
  error: unknown,
): Promise<ProvisionResult> {
  if (error instanceof WorkspaceImageMissing) {
    return failWorkspace(
      deps,
      workspaceId,
      'workspace_image_missing',
      error.message,
      error.message,
    );
  }
  if (isTransportError(error)) {
    await deps.repos.workspaces.setStatus(workspaceId, 'FAILED', {
      failureReason: 'docker unreachable',
    });
    throw error;
  }
  const message = deps.redactor.redact(error instanceof Error ? error.message : String(error));
  return failWorkspace(deps, workspaceId, 'workspace_create_failed', message, message);
}

/**
 * Destroys a container whose reference is about to be lost, and closes its row out.
 *
 * Both steps are best-effort and independent: the row write is the one that just failed, so it may
 * well fail again, and the container must go regardless — it is the expensive half, and a workspace
 * nothing can address is a workspace nothing will ever reclaim.
 *
 * @param deps - Runner, repositories and logger.
 * @param workspaceId - The row whose container was never recorded.
 * @param handle - The reference this call is the last holder of.
 */
async function discardUnrecordedWorkspace(
  deps: ProcessorDeps,
  workspaceId: string,
  handle: WorkspaceHandle,
): Promise<void> {
  try {
    await deps.runner.destroy(handle);
  } catch (error) {
    deps.logger.error(
      { err: error, workspaceId },
      'destroying a workspace whose reference was never recorded failed',
    );
  }
  try {
    await deps.repos.workspaces.setStatus(workspaceId, 'FAILED', {
      failureReason: UNRECORDED_WORKSPACE_REASON,
    });
  } catch (error) {
    // Described rather than logged whole: this is a repository failure, and a driver builds its
    // message from the connection string it was configured with.
    deps.logger.error(
      { failure: describeClientFailure(error), workspaceId },
      'could not close out a workspace whose reference was never recorded',
    );
  }
}

/**
 * Records the container on its row, or destroys it when that write is refused.
 *
 * Nothing else can be attached to the container at this point, which is what makes destroying it
 * safe: the handle has not been returned to any caller, no exec has been started in it, the row
 * carries no reference for anything to look it up by, and the single live workspace a chat is
 * allowed is already this row — a concurrent create would have been refused by the database.
 *
 * @param deps - The processor's collaborators.
 * @param workspaceId - The row being completed.
 * @param handle - The reference the runner handed out.
 * @returns The ready workspace.
 * @throws unknown Whatever the repository rejected with, once the container is gone.
 */
async function recordReadyWorkspace(
  deps: ProcessorDeps,
  workspaceId: string,
  handle: WorkspaceHandle,
): Promise<ProvisionResult> {
  try {
    const ready = await deps.repos.workspaces.setStatus(workspaceId, 'READY', {
      runnerRef: handle.runnerRef,
    });
    return { ok: true, workspace: ready, handle };
  } catch (error) {
    await discardUnrecordedWorkspace(deps, workspaceId, handle);
    throw error;
  }
}

/**
 * Creates a workspace row and the container behind it.
 *
 * The repository is measured against the configured forge list first, so a stored URL that the
 * operator has since stopped allowing is refused before a container exists.
 *
 * @param deps - The processor's collaborators.
 * @param input - What the workspace serves.
 * @returns The ready workspace, or why it could not be created.
 * @throws LiveWorkspaceExistsError When the chat already has a live workspace; the caller decides
 *   whether that is a race to reuse or a bug.
 * @throws Error When the Docker daemon is unreachable, so the job is failed rather than the
 *   workspace; nothing redelivers it, so the caller records the turn or run first.
 */
export async function provisionWorkspace(
  deps: ProcessorDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const workspace = await openWorkspaceRow(deps, input);
  const decision = await resolveWorkspaceOrigin(deps, input, workspace.id);
  if (!decision.allowed) {
    return decision.refusal;
  }

  const stored = await deps.secrets.status();
  if (!stored.GITHUB_PAT.set || !stored.OPENAI_API_KEY.set) {
    return failWorkspace(
      deps,
      workspace.id,
      SECRETS_MISSING_CODE,
      SECRETS_MISSING_MESSAGE,
      SECRETS_MISSING_REASON,
    );
  }

  let handle: WorkspaceHandle;
  try {
    handle = await deps.runner.create({
      workspaceId: workspace.id,
      kind: input.kind,
      image: deps.config.WORKSPACE_IMAGE,
      env: {
        // Spread first so nothing an extra block carries can shadow the provider selection below
        // it.
        ...deps.fakeProviderEnv,
        GIT_ASKPASS: ASKPASS_PATH,
        OPENAI_MODEL: deps.config.OPENAI_MODEL,
        AGENT_MODEL_PROVIDER: deps.config.AGENT_MODEL_PROVIDER,
        ...(deps.config.OPENAI_BASE_URL === undefined
          ? {}
          : { OPENAI_BASE_URL: deps.config.OPENAI_BASE_URL }),
      },
      files: [{ path: ALLOWED_ORIGIN_PATH, content: `${decision.origin}\n` }],
      limits: WORKSPACE_LIMITS,
      labels: labelsFor(deps, input, workspace.id),
    });
  } catch (error) {
    return failedCreate(deps, workspace.id, error);
  }

  return recordReadyWorkspace(deps, workspace.id, handle);
}
