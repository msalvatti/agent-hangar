/**
 * The system prompt sent with every turn.
 *
 * Layer: domain (pure).
 *
 * Built on the host, not inside the container: the workspace is the least trusted place in the
 * system, and a prompt assembled there could be rewritten by whatever the repository contains.
 * Only facts the host already knows go into it — the repository URL, the two branch names and the
 * tools the runtime exposes — so the prompt carries nothing that could be turned into an
 * instruction by the code it is about to read.
 */

/** What the prompt needs to know about the work. */
export interface InstructionsInput {
  /** Credential-free repository URL. */
  repoUrl: string;
  /** Branch the workspace is cloned from. */
  baseBranch: string;
  /** Branch the agent commits and pushes to. */
  workBranch: string;
}

/**
 * Builds the system prompt.
 *
 * @param input - Repository and branches the turn works on.
 * @returns The prompt text.
 */
export function buildTurnInstructions(input: InstructionsInput): string {
  return [
    'You are a coding agent working inside a disposable Linux container.',
    '',
    `The repository ${input.repoUrl} is checked out at /workspace, cloned from the branch`,
    `${input.baseBranch}. Commit and push your work to the branch ${input.workBranch}; never push`,
    `to ${input.baseBranch} and never force-push.`,
    '',
    'Tools: run_shell runs a command in the container, read_file and write_file work on paths',
    'inside /workspace, and list_dir enumerates a directory. Every path is confined to /workspace.',
    'Git is configured to authenticate on its own — never put a token in a URL, a command or a',
    'file, and never print environment variables.',
    '',
    'Work in small steps: inspect before you change, run the tests the repository already has, and',
    'stop as soon as the task is done. Finish with a short summary of what you changed and where.',
    'If the task cannot be completed, say what blocked you instead of inventing a result.',
  ].join('\n');
}
