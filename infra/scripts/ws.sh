#!/usr/bin/env bash
# ws.sh list|reap — debug aids over the workspace containers of one instance. Both subcommands are
# scoped strictly by the `ah.instance` label, never by a bare name prefix, so a foreign instance's
# containers are never touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Instance resolution — see ah_assert_agreement in env.sh. Captured before it is evaluated, so a
# refusal is not swallowed by `eval`, which succeeds on the empty string a refusal prints.
instance_env="$(bash "$here/env.sh" --print-checked)" || exit "$?"
eval "$instance_env"

ws_list() {
  docker ps --filter "label=ah.instance=$AH_INSTANCE" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Label "ah.kind"}}\t{{.Label "ah.chat"}}{{.Label "ah.jobRun"}}'
}

ws_reap() {
  local listing id
  local ids=()
  # Stated before the removal, not only in the count afterwards: this subcommand destroys
  # containers, and the operator has to be able to see which instance's before it happens.
  echo "Reaping workspace containers of instance \"$AH_INSTANCE\""
  listing="$(docker ps -aq --filter "label=ah.instance=$AH_INSTANCE")"
  # One id per line, collected into an array: expanded as "${ids[@]}" every id stays a separate
  # argument to `docker rm`, so an id carrying whitespace can never split into two.
  while IFS= read -r id; do
    if [ -n "$id" ]; then
      ids+=("$id")
    fi
  done <<< "$listing"
  if [ ${#ids[@]} -gt 0 ]; then
    docker rm -f "${ids[@]}" >/dev/null
  fi
  echo "Removed ${#ids[@]} workspace container(s) of instance $AH_INSTANCE"
}

case "${1:-}" in
  list) ws_list ;;
  reap) ws_reap ;;
  *)
    echo "usage: ws.sh <list|reap>" >&2
    exit 2
    ;;
esac
