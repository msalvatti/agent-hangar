#!/usr/bin/env bash
# Runs every mutation-testing suite in the repository — one workspace at a time, then the
# `infra/scripts` project — and reports what each one did.
#
# The shape mirrors `run-tests.sh`, for the same two reasons:
#
#   * `&&` means one workspace under the threshold stops the run before the later ones are reached,
#     and a suite that never executed looks, from the outside, exactly like one that passed.
#   * Recursive `pnpm run` is concurrent by default. A mutation run's verdicts are partly decided by
#     wall-clock — a `Timeout` counts as killed — so two of them on one machine can change each
#     other's results. `--sequential` is what keeps a score reproducible.
#
# Every suite therefore runs, whatever the ones before it did, and the exit code is non-zero if any
# of them fell under its threshold.
#
# Arguments are forwarded to both groups.
#
# `set -e` is deliberately absent: this script exists precisely to keep running past a non-zero
# exit and decide the status itself.
set -uo pipefail

pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test:mutation "$@"
workspaces_status=$?

pnpm exec stryker run "$@"
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

printf '\nMutation suites run:\n' >&2
report 'workspace packages' "$workspaces_status"
report 'infra/scripts' "$scripts_status"

if [ "$workspaces_status" -ne 0 ] || [ "$scripts_status" -ne 0 ]; then
  exit 1
fi

exit 0
