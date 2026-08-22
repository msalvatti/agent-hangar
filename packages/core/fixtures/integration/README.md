# Integration fan-out log fixtures

Recorded standard output of the recursive pnpm command that `scripts/run-integration.sh` wraps,
one file per outcome the wrapper has to tell apart. `integration-wrapper.test.ts` replays them
through a `pnpm` shim on `PATH` and runs the real script, so the decision the wrapper makes is
pinned by bytes a machine actually produced rather than by a pattern read back to itself.

## Files

| File                         | Run it records                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `github-actions-passing.log` | Three workspace suites, 150 assertions, all passing — GitHub's runner, coloured |
| `all-skipped.log`            | The same three suites with no Postgres, Redis or Docker — every test skipped    |

## Provenance

`github-actions-passing.log` is the pnpm section of the `integration` job of workflow run
32539100915 (`gh api --allow-escape-sequences repos/…/actions/jobs/96945373446/logs`), with
GitHub's own per-line timestamp prefix removed and nothing else changed. Its escape sequences are
real bytes (`0x1b`), which is the point: that run is where the wrapper read a summary it could not
match and called three passing suites "NOTHING RAN".

`all-skipped.log` was recorded locally by running the same pnpm command with no `DATABASE_URL`,
`REDIS_URL` or `DOCKER_AVAILABLE`. The absolute path of the checkout was replaced with the
runner's so the file names no developer's home directory; nothing else was edited. That command
exits 0, which is the defect the wrapper exists to convert into a failure.

No log holds a credential: the suites use the canaries from `src/testing/canaries.ts`, and neither
file contains one.

## Re-recording

Replace a file with a fresh capture of the same command and update the counts asserted in
`integration-wrapper.test.ts`. Keep the escape sequences: stripping them from
`github-actions-passing.log` would leave a fixture that passes against the anchor that failed in
CI, and the test would stop being able to catch the thing it was written for.
