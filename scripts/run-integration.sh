#!/usr/bin/env bash
# Runs every `@db` / `@redis` / `@docker` suite in the repository and refuses to call a run that
# executed nothing a success.
#
# Why a script rather than the bare recursive command it wraps:
#
#   * Each suite skips itself when the resource it needs is absent, which is the right behaviour
#     locally — a developer without Docker should not be told their change is broken. But pnpm then
#     reports exit 0, and a command that answers "success" having run no assertion at all is the
#     shape this repository already went to some trouble to eliminate elsewhere: a check that
#     cannot fail. Measured: thirteen files, a hundred and fifty tests, every one of them skipped,
#     exit 0, no line in the output saying so.
#   * The per-workspace reporting says how many tests each suite skipped, but nothing says whether
#     that was all of them, and the number scrolls past above whatever ran last.
#
# So the recursive run is left exactly as it was — the same flags, the same reporting, real
# failures still decide the exit code — and one question is answered at the end that its output
# cannot answer on its own: did anything actually execute.
#
# `CI=1` is unaffected. There the resources are provided and the suites fail loudly when they are
# not, so this never becomes the thing that reports the problem.
#
# `set -e` is deliberately absent: the point is to keep going past a non-zero exit and decide the
# status here.
set -uo pipefail

log=$(mktemp -t ah-integration)
trap 'rm -f "$log"' EXIT

pnpm --recursive --if-present --sequential --no-bail --no-include-workspace-root run test:integration "$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

# Vitest's own summary line, one per workspace: "Tests  126 passed (126)" or "Tests  150 skipped".
# Counting the lines that report a pass answers the only question asked here.
executed=$(grep -cE '^[[:space:]]*Tests[[:space:]].*[0-9]+ passed' "$log" || true)
skipped=$(grep -oE '[0-9]+ skipped' "$log" | awk '{ total += $1 } END { print total + 0 }')

if [ "$executed" -gt 0 ]; then
  printf '\nIntegration suites: %s workspace suite(s) executed.\n' "$executed" >&2
  exit 0
fi

{
  printf '\nIntegration suites: NOTHING RAN — %s test(s) skipped, no assertion executed.\n' "$skipped"
  printf 'This is not a pass. The suites skip themselves when the resource they need is absent.\n'
  printf 'To run them, bring a throwaway instance up and set both flags:\n'
  printf '  AH_ENV_FILE=/tmp/ah-test.env AH_INSTANCE=test AH_PORT_BASE=3410 pnpm setup\n'
  printf '  eval "$(AH_ENV_FILE=/tmp/ah-test.env bash infra/scripts/env.sh --print-effective)"\n'
  printf '  AH_ALLOW_DESTRUCTIVE_TESTS=1 DOCKER_AVAILABLE=1 pnpm test:integration\n'
  printf 'See README "Running the integration suites".\n'
} >&2
exit 1
