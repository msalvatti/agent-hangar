/**
 * Creating one workspace container with the credentials a turn needs.
 *
 * Layer: service.
 *
 * Shared by chat turns and scheduled runs so that "how a workspace is born" has one description:
 * a row first, then the credentials, then the container, then the row again. Writing the row
 * before the container is what makes an interrupted create discoverable — the garbage collector
 * reconciles both directions.
 *
 * Security: this is the only function in the application that holds a decrypted credential. The
 * two plaintexts live in local constants, go into the environment of the `create` call and into
 * the redactor, and are referenced nowhere else — not on the result, not in a log record, and not
 * in the message of a failure. Failures are reported by the typed error the runner raised, whose
 * messages are built from ids and image names only.
 */
import { WorkspaceImageMissing } from '@agent-hangar/core';
import type { Workspace, WorkspaceHandle, WorkspaceKind } from '@agent-hangar/core';

import { isTransportError } from '../errors.js';

import { ASKPASS_PATH, LABELS, WORKSPACE_LIMITS } from './constants.js';
import type { ProcessorDeps } from './types.js';

/** Why a workspace could not be provisioned. */
export type ProvisionFailureReason =
  'secrets_missing' | 'workspace_image_missing' | 'workspace_create_failed';

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
  const workspace = await deps.repos.workspaces.create({
    kind: input.kind,
    ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    runnerKind: deps.runner.kind,
    image: deps.config.WORKSPACE_IMAGE,
    repoUrl: input.repoUrl,
    branch: input.branch,
  });

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
    if (error instanceof WorkspaceImageMissing) {
      return failWorkspace(
        deps,
        workspace.id,
        'workspace_image_missing',
        error.message,
        error.message,
      );
    }
    if (isTransportError(error)) {
      await deps.repos.workspaces.setStatus(workspace.id, 'FAILED', {
        failureReason: 'docker unreachable',
      });
      throw error;
    }
    const message = deps.redactor.redact(error instanceof Error ? error.message : String(error));
    return failWorkspace(deps, workspace.id, 'workspace_create_failed', message, message);
  }

  const ready = await deps.repos.workspaces.setStatus(workspace.id, 'READY', {
    runnerRef: handle.runnerRef,
  });
  return { ok: true, workspace: ready, handle };
}
