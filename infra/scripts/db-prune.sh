#!/usr/bin/env bash
# db-prune.sh [--days N] [--dry-run] — deletes Workspace rows that have been DESTROYED for more
# than N days (default 30), per spec 02 §5 retention. `--dry-run` only counts the candidates.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

days=30
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days)
      shift
      days="${1:-}"
      ;;
    --dry-run) dry_run=1 ;;
    *)
      echo "usage: db-prune.sh [--days N] [--dry-run]" >&2
      exit 2
      ;;
  esac
  shift
done

case "$days" in
  ''|*[!0-9]*)
    echo "error: --days must be a positive integer, got \"$days\"" >&2
    exit 2
    ;;
esac
if [ "$days" -lt 1 ]; then
  echo "error: --days must be a positive integer, got \"$days\"" >&2
  exit 2
fi

# Instance resolution — see ah_assert_agreement in env.sh. Captured before it is evaluated, so a
# refusal is not swallowed by `eval`, which succeeds on the empty string a refusal prints.
instance_env="$(bash "$here/env.sh" --print-checked)" || exit "$?"
eval "$instance_env"

where="status = 'DESTROYED' AND \"destroyedAt\" < now() - interval '$days days'"
if [ $dry_run -eq 1 ]; then
  sql="SELECT count(*) FROM \"Workspace\" WHERE $where"
else
  sql="DELETE FROM \"Workspace\" WHERE $where"
fi

# The rows about to be deleted belong to one instance's database; it is named before the
# statement runs rather than left implicit in the compose project the command resolves to.
echo "Target instance \"$AH_INSTANCE\" (database $POSTGRES_DB)"

output="$(docker compose -f "$root/infra/docker-compose.yml" exec -T postgres \
  psql -U ah -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc "$sql")"

if [ $dry_run -eq 1 ]; then
  count="$(printf '%s' "$output" | tr -d '[:space:]')"
  echo "Would prune $count destroyed workspace row(s) older than $days days"
else
  count="$(printf '%s\n' "$output" | sed -n 's/^DELETE \([0-9]*\)$/\1/p')"
  echo "Pruned ${count:-0} destroyed workspace row(s) older than $days days"
fi
