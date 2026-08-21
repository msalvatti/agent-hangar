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
# Refuses to start against a workspace image that was not built from this checkout: the app would
# come up, take turns and report results produced by an agent runtime that is in no tree. See
# workspace-image.sh. An image that is simply absent is not refused — that one is already loud
# everywhere (the worker logs it, /api/health reports it, the UI shows a banner) and a developer
# working on the UI has no reason to build one.
#
# In development NODE_OPTIONS is exported with --conditions=development so every child process
# resolves @agent-hangar/core from packages/core/src (not the built dist/, which a fresh worktree
# never has) — the worker's own dev script already asks for the condition directly, but a future
# tsx-based child would silently fail with ERR_MODULE_NOT_FOUND without this export. The production
# mode deliberately does not export it: there the build output is what must be loaded.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

# shellcheck source=/dev/null
. "$here/workspace-image.sh"

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

if [ $print_only -eq 0 ]; then
  ah_assert_workspace_image_tag "$WORKSPACE_IMAGE" "$AH_INSTANCE" || exit "$?"
  case "$(ah_workspace_image_status "$WORKSPACE_IMAGE")" in
    stale)
      echo "error: the workspace image \"$WORKSPACE_IMAGE\" was not built from this checkout." >&2
      echo "Every container it creates would run an agent runtime this tree does not contain, and nothing about the run would say so: the turn succeeds and reports a result for a combination of worker and runtime that was never released together." >&2
      echo "Rebuild it with \"pnpm infra:image\"." >&2
      exit 1
      ;;
    unverifiable)
      # Not the same as "no image". There is one, this instance is about to create containers from
      # it, and this checkout cannot say what is inside it — which is the state the whole check
      # exists to refuse. Starting anyway on the grounds that nothing was proven wrong is how a run
      # ends up reporting a result for a runtime nobody can name.
      echo "error: the workspace image \"$WORKSPACE_IMAGE\" could not be checked against this checkout: the runtime bundle did not build, so there is no digest to compare it with." >&2
      echo "The reason is on the line above. \"pnpm install\" if this worktree has no dependencies yet; otherwise the bundle itself does not build, and the image cannot be vouched for until it does." >&2
      exit 1
      ;;
  esac
fi

# 127.0.0.1, not localhost: `next dev`/`next start` are given `-H 127.0.0.1`, so the listener is
# IPv4 loopback only. `localhost` resolves to ::1 first on macOS and nothing answers there, which
# leaves the printed URL working only for clients that retry the second address — the same reason
# .env.example spells the database and Redis hosts numerically. Printing the address that is
# actually bound depends on no fallback at all.
echo "Agent Hangar · instance=$AH_INSTANCE · http://127.0.0.1:$WEB_PORT"

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
