/**
 * Creating one workspace container with the credentials a turn needs.
 *
 * Layer: service.
 *
 * Shared by chat turns and scheduled runs so that "how a workspace is born" has one description:
 * a row first, then the credentials, then the container, then the row again. Writing the row
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
 * Security: this is the only function in the application that holds a decrypted credential. The
 * two plaintexts live in local constants, go into the environment of the `create` call and into
 * the redactor, and are referenced nowhere else — not on the result, not in a log record, and not
 * in the message of a failure. Failures are reported by the typed error the runner raised, whose
 * messages are built from ids and image names only.
 */
import { describeClientFailure, WorkspaceImageMissing } from '@agent-hangar/core';
import type { Workspace, WorkspaceHandle, WorkspaceKind } from '@agent-hangar/core';

import { isTransportError } from '../errors.js';

import { ASKPASS_PATH, LABELS, WORKSPACE_LIMITS } from './constants.js';
import type { ProcessorDeps } from './types.js';

/** Why a workspace could not be provisioned. */
export type ProvisionFailureReason =
  'secrets_missing' | 'workspace_image_missing' | 'workspace_create_failed';

/** `Workspace.failureReason` written when the container could not be recorded on its row. */
export const UNRECORDED_WORKSPACE_REASON = 'container reference was never recorded';

/** `Workspace.failureReason` written when a credential was not configured. */
export const SECRETS_MISSING_REASON = 'secrets missing';

/** What the user is told to do when a credential is not configured. */
export const SECRETS_MISSING_MESSAGE =
  'Configure the GitHub PAT and the OpenAI API key in Settings, then try again.';

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
    ...(input.chatId === undefined ? {} : { [LABELS.chat]: input.chatId }),
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
    ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    runnerKind: deps.runner.kind,
    image: deps.config.WORKSPACE_IMAGE,
    repoUrl: input.repoUrl,
    branch: input.branch,
  });
}

/**
 * Closes the row out for a container that could not be created, and says what kind of failure it
 * was.
 *
 * @param deps - Repositories, redactor and image status.
 * @param workspaceId - The row the create was for.
 * @param error - What the runner rejected with.
 * @returns The failure result, for the two kinds a retry would only repeat.
 * @throws unknown The original error when the daemon was unreachable, so BullMQ retries the job.
 */
async function failedCreate(
  deps: ProcessorDeps,
  workspaceId: string,
  error: unknown,
): Promise<ProvisionResult> {
  if (error instanceof WorkspaceImageMissing) {
    deps.imageStatus.markMissing();
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
 * well fail again, and the container must go regardless — it is the expensive half, and its
 * environment holds both revealed credentials.
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
 * @param deps - The processor's collaborators.
 * @param input - What the workspace serves.
 * @returns The ready workspace, or why it could not be created.
 * @throws LiveWorkspaceExistsError When the chat already has a live workspace; the caller decides
 *   whether that is a race to reuse or a bug.
 * @throws Error When the Docker daemon is unreachable, so BullMQ retries the job.
 */
export async function provisionWorkspace(
  deps: ProcessorDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const workspace = await openWorkspaceRow(deps, input);

  const pat = await deps.secrets.reveal('GITHUB_PAT');
  const apiKey = await deps.secrets.reveal('OPENAI_API_KEY');
  if (pat === null || apiKey === null) {
    return failWorkspace(
      deps,
      workspace.id,
      'secrets_missing',
      SECRETS_MISSING_MESSAGE,
      SECRETS_MISSING_REASON,
    );
  }
  deps.redactor.register([pat, apiKey]);

  let handle: WorkspaceHandle;
  try {
    handle = await deps.runner.create({
      workspaceId: workspace.id,
      kind: input.kind,
      image: deps.config.WORKSPACE_IMAGE,
      env: {
        GITHUB_TOKEN: pat,
        OPENAI_API_KEY: apiKey,
        GIT_ASKPASS: ASKPASS_PATH,
        OPENAI_MODEL: deps.config.OPENAI_MODEL,
        AGENT_MODEL_PROVIDER: deps.config.AGENT_MODEL_PROVIDER,
        ...(deps.config.OPENAI_BASE_URL === undefined
          ? {}
          : { OPENAI_BASE_URL: deps.config.OPENAI_BASE_URL }),
      },
      limits: WORKSPACE_LIMITS,
      labels: labelsFor(deps, input, workspace.id),
    });
  } catch (error) {
    return failedCreate(deps, workspace.id, error);
  }

  deps.imageStatus.markPresent();
  return recordReadyWorkspace(deps, workspace.id, handle);
}
