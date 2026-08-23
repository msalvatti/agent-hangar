/**
 * Query keys of the scheduled feature.
 *
 * Layer: feature (lib).
 *
 * The listing, one job, a job's runs and one run are each read in one place and invalidated in
 * another, so the key a view is registered under is a contract between two files. Spelled out at
 * both ends they can drift apart silently: a mutation that invalidates a key nothing is registered
 * under refreshes nothing, and a view showing what it showed before is indistinguishable from one
 * whose reload has not arrived yet.
 */

/** Key the job listing is registered under. */
export const JOBS_KEY: readonly string[] = ['jobs'];

/**
 * Key one job's own view is registered under.
 *
 * @param jobId - The job.
 * @returns Its query key.
 */
export function jobKey(jobId: string): readonly string[] {
  return ['job', jobId];
}

/**
 * Key a job's run history is registered under.
 *
 * @param jobId - The job whose runs are listed.
 * @returns Its query key.
 */
export function runsKey(jobId: string): readonly string[] {
  return ['runs', jobId];
}

/**
 * Key one run's detail is registered under.
 *
 * @param runId - The run.
 * @returns Its query key.
 */
export function runKey(runId: string): readonly string[] {
  return ['run', runId];
}
