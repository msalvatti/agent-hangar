#!/usr/bin/env bash
# run.sh — single entry point for `pnpm dev` and for Conductor's Run button. Resolves the
# instance's environment, prints the URL Agent Hangar will serve, then starts web + worker
# together. `--print-only` prints the command instead of running it (used by tests).
#
# NODE_OPTIONS is exported with --conditions=development so every child process resolves
# @agent-hangar/core from packages/core/src (not the built dist/, which a fresh worktree never
# has) — the worker's own dev script already asks for the condition directly, but a future
# tsx-based child would silently fail with ERR_MODULE_NOT_FOUND without this export.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

env_file="${AH_ENV_FILE:-$root/.env.local}"
[ -f "$env_file" ] || bash "$here/env.sh"
eval "$(bash "$here/env.sh" --print-effective)"

echo "Agent Hangar · instance=$AH_INSTANCE · http://localhost:$WEB_PORT"

export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=development"

cmd=(pnpm exec concurrently -n web,worker -c blue,magenta --kill-others-on-fail
  "pnpm --filter web dev --port $WEB_PORT" "pnpm --filter worker dev")

if [ "${1:-}" = "--print-only" ]; then
  printf '%q ' "${cmd[@]}"
  echo
  exit 0
fi

cd "$root" && exec "${cmd[@]}"
