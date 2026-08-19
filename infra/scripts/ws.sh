#!/usr/bin/env bash
# ws.sh list|reap — debug aids over the workspace containers of one instance. Both subcommands are
# scoped strictly by the `ah.instance` label, never by a bare name prefix, so a foreign instance's
# containers are never touched.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

eval "$(bash "$here/env.sh" --print)"

ws_list() {
  docker ps --filter "label=ah.instance=$AH_INSTANCE" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Label "ah.kind"}}\t{{.Label "ah.chat"}}{{.Label "ah.jobRun"}}'
}

ws_reap() {
  ids="$(docker ps -aq --filter "label=ah.instance=$AH_INSTANCE")"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null
    count=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
  else
    count=0
  fi
  echo "Removed $count workspace container(s) of instance $AH_INSTANCE"
}

case "${1:-}" in
  list) ws_list ;;
  reap) ws_reap ;;
  *)
    echo "usage: ws.sh <list|reap>" >&2
    exit 2
    ;;
esac
