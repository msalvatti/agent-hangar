#!/usr/bin/env bash
# run.sh — single entry point for `pnpm dev`, `pnpm start` and Conductor's Run button. Resolves the
# instance's environment, prints the URL Agent Hangar will serve, then starts web + worker
# together. Both modes go through here so neither can drift from the instance's ports, database and
# Redis: a plain `pnpm start` that skipped this would silently serve the default port block against
# the default database, whatever the instance is configured for.
#
# Flags:
#   --production  run the built output (`next start`, `node dist/main.js`) instead of the sources
#   --print-only  print the command instead of running it (used by tests)
#
# In development NODE_OPTIONS is exported with --conditions=development so every child process
# resolves @agent-hangar/core from packages/core/src (not the built dist/, which a fresh worktree
# never has) — the worker's own dev script already asks for the condition directly, but a future
# tsx-based child would silently fail with ERR_MODULE_NOT_FOUND without this export. The production
# mode deliberately does not export it: there the build output is what must be loaded.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

production=0
print_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --production) production=1 ;;
    --print-only) print_only=1 ;;
    *)
      echo "usage: run.sh [--production] [--print-only]" >&2
      exit 2
      ;;
  esac
  shift
done

env_file="${AH_ENV_FILE:-$root/.env.local}"
[ -f "$env_file" ] || bash "$here/env.sh"
eval "$(bash "$here/env.sh" --print-effective)"

echo "Agent Hangar · instance=$AH_INSTANCE · http://localhost:$WEB_PORT"

if [ $production -eq 0 ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --conditions=development"
fi

cmd=(pnpm exec concurrently -n web,worker -c blue,magenta --kill-others-on-fail)
if [ $production -eq 1 ]; then
  cmd+=("pnpm --filter web start --port $WEB_PORT" "pnpm --filter worker start")
else
  cmd+=("pnpm --filter web dev --port $WEB_PORT" "pnpm --filter worker dev")
fi

if [ $print_only -eq 1 ]; then
  printf '%q ' "${cmd[@]}"
  echo
  exit 0
fi

cd "$root" && exec "${cmd[@]}"
