#!/usr/bin/env bash
# Runs `tsc -b` and then rewrites @agent-hangar/core's emitted declarations — always, and without
# changing what decides success.
#
# Why a wrapper rather than `tsc -b && <rewrite>`:
#
#   * `tsc -b` emits for every `composite` project it reaches, so it writes `packages/core/dist`
#     whether it was invoked to build or merely to type-check. Those declarations name relative
#     ".ts" specifiers that only the rewrite turns into ".js".
#   * `&&` short-circuits. A failing compile therefore leaves a partially emitted, unrewritten
#     `dist` behind, and the next command that reads it — a `tsc` resolving the package, or the
#     guard suite that scans the emitted declaration graph — fails for a reason nobody introduced.
#
# So the rewrite runs unconditionally here, and the compiler's exit code is still what the caller
# sees. Only when the compile succeeded does a failing rewrite decide the outcome: a rewrite that
# fails after a failed compile is a symptom of the compile, not a second, independent fault.
#
# Arguments are forwarded to `tsc -b`, so `tsc-build.sh --force` and friends work as usual.
#
# The compiler is reached through `pnpm exec` rather than as a bare `tsc`: only a package script
# gets `node_modules/.bin` on its PATH, and this script has to behave the same when a developer
# runs it directly.
#
# `set -e` is deliberately absent: this script exists precisely to keep running past a non-zero
# exit and decide the status itself.
set -uo pipefail

pnpm exec tsc -b "$@"
compile_status=$?

pnpm --filter @agent-hangar/core declarations:rewrite
rewrite_status=$?

if [ "$compile_status" -ne 0 ]; then
  exit "$compile_status"
fi

exit "$rewrite_status"
