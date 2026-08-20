/**
 * What the worker currently believes about the workspace image.
 *
 * Layer: utility.
 *
 * The `WorkspaceRunner` port exposes no image lookup, so nothing short of creating a container can
 * ask the daemon whether the image exists. What the worker does have is the answer it gets every
 * time it tries: a create either raises `WorkspaceImageMissing` or succeeds. This records that
 * answer so the health heartbeat can report something it actually observed.
 *
 * It starts optimistic. Before any workspace has been created there is nothing to report, and
 * claiming the image is missing would put a banner in front of a user whose image is fine; the
 * first create corrects it either way, and a turn that hits a missing image fails with the command
 * that builds it regardless of what this says.
 */

/** Observed presence of the workspace image. */
export interface WorkspaceImageStatus {
  /** Whether the last create found the image, or nothing has been created yet. */
  present(): boolean;
  /** Records that a create found the image. */
  markPresent(): void;
  /** Records that a create reported the image missing. */
  markMissing(): void;
}

/**
 * Creates the observed image status of one worker process.
 *
 * @returns A status that starts optimistic and follows what creates report.
 */
export function createImageStatus(): WorkspaceImageStatus {
  let present = true;
  return {
    present: () => present,
    markPresent: () => {
      present = true;
    },
    markMissing: () => {
      present = false;
    },
  };
}
