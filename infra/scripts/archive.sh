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

# Instance resolution — see ah_assert_agreement in env.sh. Captured before it is evaluated, so a
# refusal is not swallowed by `eval`, which succeeds on the empty string a refusal prints.
instance_env="$(bash "$here/env.sh" --print-checked)" || exit "$?"
eval "$instance_env"
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

# A teardown states what it is about to destroy before destroying it. The progress lines below
# name the compose project and the label filter individually; this line is the one place an
# operator can read the whole target off in one go and stop the run if it is the wrong one.
echo "Archiving instance \"$AH_INSTANCE\" (compose $COMPOSE_PROJECT_NAME, database $POSTGRES_DB, env file $env_file)"

echo "1/3 Tearing down compose resources ($COMPOSE_PROJECT_NAME)"
if ! docker compose -f "$root/infra/docker-compose.yml" down -v --remove-orphans; then
  echo "warning: compose teardown failed (Docker may be unreachable); continuing to reap containers" >&2
fi

echo "2/3 Reaping workspace containers of instance $AH_INSTANCE"
# The lookup is allowed to fail: an unreachable Docker daemon must not stop the teardown before
# the env file is dealt with, which is the one step that never needs Docker at all.
if ! listing="$(docker ps -aq --filter "label=ah.instance=$AH_INSTANCE")"; then
  listing=""
  echo "warning: could not list workspace containers (Docker may be unreachable)" >&2
fi
# One id per line, collected into an array: expanded as "${ids[@]}" every id stays a separate
# argument to `docker rm`, so an id carrying whitespace can never split into two.
ids=()
while IFS= read -r id; do
  if [ -n "$id" ]; then
    ids+=("$id")
  fi
done <<< "$listing"
if [ ${#ids[@]} -gt 0 ]; then
  docker rm -f "${ids[@]}" >/dev/null
  echo "Removed ${#ids[@]} workspace container(s) of instance $AH_INSTANCE"
else
  echo "No workspace containers for instance $AH_INSTANCE"
fi

# The network the workspaces of this instance shared. It outlives them by design -- the runner
# expects to find it on the next create -- so archiving the instance is the one moment it should
# go. Removal is best effort and comes last: a network still holding a container the reap above
# could not remove is a failure worth reporting, not one worth stopping the teardown for.
network="ah-ws-$AH_INSTANCE"
if docker network rm "$network" >/dev/null 2>&1; then
  echo "Removed workspace network $network"
else
  echo "No workspace network $network to remove"
fi

echo "3/3 Env file ($env_file)"
if [ $keep_env -eq 1 ]; then
  echo "kept (--keep-env)"
else
  rm -f "$env_file"
  echo "removed $env_file"
fi
