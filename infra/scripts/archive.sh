#!/usr/bin/env bash
# archive.sh — Conductor's workspace teardown: tears the instance's compose resources down and
# reaps every workspace container labelled for it. Best-effort and scoped strictly to the
# resolved instance — it never touches another instance's containers or the shared master key.
#
# Flags:
#   --keep-env  do not remove the env file (default: remove it)
#   --dry-run   print the three planned actions and touch nothing
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

keep_env=0
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-env) keep_env=1 ;;
    --dry-run) dry_run=1 ;;
    *)
      echo "usage: archive.sh [--keep-env] [--dry-run]" >&2
      exit 2
      ;;
  esac
  shift
done

eval "$(bash "$here/env.sh" --print)"
env_file="${AH_ENV_FILE:-$root/.env.local}"

if [ $dry_run -eq 1 ]; then
  echo "Plan (dry run, instance=$AH_INSTANCE):"
  echo "  1. docker compose -f infra/docker-compose.yml down -v --remove-orphans (project $COMPOSE_PROJECT_NAME)"
  echo "  2. docker rm -f every container labelled ah.instance=$AH_INSTANCE"
  if [ $keep_env -eq 1 ]; then
    echo "  3. keep $env_file (--keep-env)"
  else
    echo "  3. remove $env_file"
  fi
  exit 0
fi

echo "1/3 Tearing down compose resources ($COMPOSE_PROJECT_NAME)"
if ! docker compose -f "$root/infra/docker-compose.yml" down -v --remove-orphans; then
  echo "warning: compose teardown failed (Docker may be unreachable); continuing to reap containers" >&2
fi

echo "2/3 Reaping workspace containers of instance $AH_INSTANCE"
ids="$(docker ps -aq --filter "label=ah.instance=$AH_INSTANCE")"
if [ -n "$ids" ]; then
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null
  count=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
  echo "Removed $count workspace container(s) of instance $AH_INSTANCE"
else
  echo "No workspace containers for instance $AH_INSTANCE"
fi

echo "3/3 Env file ($env_file)"
if [ $keep_env -eq 1 ]; then
  echo "kept (--keep-env)"
else
  rm -f "$env_file"
  echo "removed $env_file"
fi
