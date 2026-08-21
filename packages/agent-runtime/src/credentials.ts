/**
 * The credentials one turn runs with, taken off the filesystem at start-up.
 *
 * Layer: adapter.
 *
 * The host places a file just before it starts this process and this module removes it as soon as
 * it has been read. The environment cannot carry a credential: `/proc/<pid>/environ` is readable
 * by any process of the same user, every process in a workspace runs as that one user, and the
 * shell tool runs commands a model wrote after reading untrusted repository content — so anything
 * injected as a variable is a `cat` away for as long as the process that holds it lives. A file
 * can be unlinked, which is the whole of what this buys: the credential is readable from inside
 * the container for the distance between the host's write and the read below, not for the life of
 * the workspace.
 *
 * The unlink is therefore not cleanup and is not best-effort. A read that cannot be followed by a
 * removal leaves exactly the exposure this exists to close, so it fails the turn.
 *
 * What it does not buy: the file reaches the container's writable layer on the way in, because
 * that is where the host can put it, so the bytes exist on a disk for the length of a start-up and
 * are freed with the container. The credential the workspace keeps using — the git token — goes on
 * to a tmpfs file instead, and is unlinked at the end of the turn.
 */
import { readFile, rm } from 'node:fs/promises';

import { z } from 'zod';

/**
 * Where the host places the credentials of a turn.
 *
 * Spelled here and again in the worker rather than shared, exactly as the askpass helper's path
 * and the approved-origin file's are: the two live on opposite sides of a container boundary, and
 * the only thing that could keep a shared constant honest across it is the end-to-end suite that
 * already runs a real turn through a real image.
 */
export const DEFAULT_CREDENTIALS_FILE = '/opt/agent-runtime/handoff/credentials.json';

/**
 * Variable naming another file to read the credentials from.
 *
 * For the harnesses that run the shipped bundle outside a workspace — the bundle check and the
 * suites — which have no way to write to an absolute path in `/opt`. Nothing sets it in
 * production, and it is not a hole the workspace could reach: it is read once, before the agent
 * exists, out of an environment only the host writes. What it names is a path, not a policy;
 * pointing it at a file of the workspace's own would feed the runtime credentials the workspace
 * already had.
 */
export const CREDENTIALS_FILE_VAR = 'AH_CREDENTIALS_FILE';

/**
 * The document the host writes.
 *
 * Both values are required and neither may be empty. An absent credential is a workspace that
 * cannot do its job, and an empty one is worse than absent: handed to git it becomes a valid
 * empty password and turns a misconfiguration into an authentication failure against the forge.
 */
export const workspaceCredentialsSchema = z.object({
  /** GitHub PAT, released to git through the askpass helper. */
  githubToken: z.string().min(1),
  /** OpenAI API key the model provider is constructed from. */
  openaiApiKey: z.string().min(1),
});

/** The credentials of one turn. */
export type WorkspaceCredentials = z.infer<typeof workspaceCredentialsSchema>;

/** Raised when the credentials of a turn could not be taken off the filesystem. */
export class CredentialsUnavailable extends Error {
  /**
   * @param message - What could not be done; never carries the file's content.
   * @param options - Standard error options, carrying the underlying failure as `cause`.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialsUnavailable';
  }
}

/**
 * Reads the credentials of this turn and removes the file that carried them.
 *
 * Read, then unlink, then parse. Unlinking before the content is judged is deliberate: a document
 * that fails validation is still a document holding two credentials, and leaving it behind for
 * the sake of a better error message would leave them readable for the rest of the container's
 * life.
 *
 * @param file - Path the host placed the document at; defaults to {@link DEFAULT_CREDENTIALS_FILE}.
 * @returns The credentials the turn runs with.
 * @throws CredentialsUnavailable when the file cannot be read, cannot be removed, or does not
 *   carry both credentials.
 */
export async function takeWorkspaceCredentials(
  file: string = DEFAULT_CREDENTIALS_FILE,
): Promise<WorkspaceCredentials> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new CredentialsUnavailable(`no workspace credentials at ${file}`, { cause: error });
  }

  try {
    await rm(file);
  } catch (error) {
    throw new CredentialsUnavailable(`workspace credentials at ${file} could not be removed`, {
      cause: error,
    });
  }

  return parseCredentials(raw, file);
}

/**
 * Validates the document, saying only that it was wrong and never what it held.
 *
 * @param raw - The file's content.
 * @param file - Path it came from, for the message.
 * @returns The credentials.
 * @throws CredentialsUnavailable when the text is not the expected document.
 */
function parseCredentials(raw: string, file: string): WorkspaceCredentials {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    // The parse error quotes a prefix of its input, and that input is two credentials.
    throw new CredentialsUnavailable(`workspace credentials at ${file} are not valid JSON`);
  }
  const result = workspaceCredentialsSchema.safeParse(document);
  if (!result.success) {
    // Zod's own message quotes the offending value; only the field names are safe to report.
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new CredentialsUnavailable(`workspace credentials at ${file} are incomplete (${fields})`);
  }
  return result.data;
}
