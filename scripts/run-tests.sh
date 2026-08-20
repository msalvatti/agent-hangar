#!/usr/bin/env bash
# Runs every unit suite in the repository — one workspace at a time, then the `scripts` project —
# and reports what each one did.
#
# Why a script rather than `pnpm -r --if-present test && vitest run --project scripts`:
#
#   * `&&` means one failing workspace stops the run before the `scripts` project is reached. The
#     job then reports the earlier failure, and the suites that never executed look, from the
#     outside, exactly like suites that passed. That has already happened here: a timing-dependent
#     web test failed and the suites covering the change under review were never run.
#   * Recursive `pnpm run` is concurrent by default. Four Vitest processes at once is what this
#     repository's memory budget is written to avoid; `--sequential` makes the ordering match the
#     `maxWorkers: 3`, one-suite-at-a-time rule the Vitest configs already follow.
#
# Every suite therefore runs, whatever the ones before it did, and the exit code is non-zero if any
# of them failed. `--no-bail` is pnpm's own flag for this and keeps its per-workspace reporting;
# the summary below adds the one thing that reporting cannot say on its own, which is that both
# groups were actually reached.
#
# Arguments are forwarded to both groups, so `pnpm test -- --coverage` reaches every suite rather
# than only the last command on the line.
#
# Vitest is reached through `pnpm exec` rather than as a bare `vitest`: only a package script gets
# `node_modules/.bin` on its PATH, and this script has to behave the same when a developer runs it
# directly.
#
# `--no-include-workspace-root` is stated rather than left to the default, because the root `test`
# script is what runs this file: a workspace configuration that ever opted the root project into
# recursive runs would have this script call itself forever.
#
# `set -e` is deliberately absent: this script exists precisely to keep running past a non-zero
# exit and decide the status itself.
set -uo pipefail

pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test "$@"
workspaces_status=$?

pnpm exec vitest run --project scripts "$@"
scripts_status=$?

# Reports one group, as "PASS" or "FAIL", on standard error so it survives a piped stdout.
report() {
  local label="$1"
  local status="$2"
  if [ "$status" -eq 0 ]; then
    printf 'PASS  %s\n' "$label" >&2
  else
    printf 'FAIL  %s (exit %s)\n' "$label" "$status" >&2
  fi
}

printf '\nSuites run:\n' >&2
report 'workspace packages' "$workspaces_status"
report 'infra/scripts' "$scripts_status"

if [ "$workspaces_status" -ne 0 ] || [ "$scripts_status" -ne 0 ]; then
  exit 1
fi

exit 0
