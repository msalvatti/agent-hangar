#!/usr/bin/env bash
# run.sh — single entry point for `pnpm dev`, `pnpm start` and Conductor's Run button. Resolves the
# instance's environment, prints the URL Agent Hangar will serve, then starts web + worker
# together. Both modes go through here so neither can drift from the instance's ports, database and
# Redis: a plain `pnpm start` that skipped this would silently serve the default port block against
# the default database, whatever the instance is configured for.
#
# Refuses to start while a master key rotation holds its lock: the app would cache the key it finds
# and go on writing under it, and a secret saved mid-rotation is lost whichever side of the swap it
# lands on. `--print-only` is exempt, since it starts nothing.
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
# Instance resolution — see ah_assert_agreement in env.sh. Captured before it is evaluated, so a
# refusal is not swallowed by `eval`, which succeeds on the empty string a refusal prints.
instance_env="$(bash "$here/env.sh" --print-checked)" || exit "$?"
eval "$instance_env"

# A rotation re-encrypts every stored secret and then swaps the key file. Starting the app in the
# middle of that loses credentials both ways: a secret saved from Settings between the rotation's
# reveal and its write is silently replaced by the value revealed earlier, and one saved after the
# write is sealed under the old key, which nothing reads again once the files swap. rotate-key.sh
# refuses to start while this app answers on its web port; this is the other half of that, and
# together they are exclusion rather than two point-in-time checks.
#
# Only a lock whose owner is alive blocks: one left behind by a killed rotation must not keep the
# app down forever. Nothing is reclaimed here — removing rotation state is rotate-key.sh's job.
if [ $print_only -eq 0 ] && [ -f "$MASTER_KEY_PATH.lock" ]; then
  rotation_owner="$(cat "$MASTER_KEY_PATH.lock" 2>/dev/null || printf '')"
  if [ -n "$rotation_owner" ] && kill -0 "$rotation_owner" 2>/dev/null; then
    echo "A master key rotation is in progress (pid $rotation_owner). Wait for it to finish before starting Agent Hangar: a process started now would cache the old key and any secret it wrote would be sealed under a key nothing reads again." >&2
    exit 1
  fi
fi

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
