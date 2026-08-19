#!/usr/bin/env bash
# rotate-key.sh — generates a new master key, re-encrypts every stored secret under it, then
# swaps the key file atomically and keeps a timestamped backup of the old one. Failure at any
# point leaves the current master key unchanged and every stored secret decryptable with it.
#
# Flags:
#   --yes      required to actually rotate; without it the plan is printed and nothing runs
#   --resume   continue a previously interrupted rotation (a "<key>.new" from a prior run)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

eval "$(bash "$here"/env.sh --print)"
key="$MASTER_KEY_PATH"

confirmed=0
resume=0
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) confirmed=1 ;;
    --resume) resume=1 ;;
    *)
      echo "usage: rotate-key.sh [--yes] [--resume]" >&2
      exit 2
      ;;
  esac
  shift
done

# run_helper <relative .main.ts path>: sets HELPER_OUTPUT and HELPER_RC.
run_helper() {
  local cmd="${AH_DOCTOR_HELPER_CMD:-pnpm exec tsx}"
  # shellcheck disable=SC2086
  if HELPER_OUTPUT=$($cmd "$here/lib/$1" 2>&1); then
    HELPER_RC=0
  else
    HELPER_RC=$?
  fi
}

if [ $confirmed -ne 1 ]; then
  set +e
  run_helper secrets-status.main.ts
  set -e
  set_count=0
  if [ "$HELPER_RC" = "0" ]; then
    set_count=$(printf '%s\n' "$HELPER_OUTPUT" | grep -c '=set:' || true)
  fi
  echo "Plan (not run without --yes):"
  echo "  key: $key"
  echo "  backup: $key.bak-<YYYYMMDDHHMMSS>"
  echo "  re-encrypts $set_count secret(s)"
  exit 2
fi

if [ -f "$key.new" ] && [ $resume -ne 1 ]; then
  echo "A previous rotation was interrupted; inspect $key.new and re-run with --resume, or delete it" >&2
  exit 1
fi

if [ $resume -ne 1 ]; then
  umask 077
  openssl rand -hex 32 > "$key.new"
  chmod 600 "$key.new"
fi

export AH_NEW_MASTER_KEY_PATH="$key.new"
set +e
run_helper rotate-key.main.ts
rc=$HELPER_RC
set -e
unset AH_NEW_MASTER_KEY_PATH
echo "$HELPER_OUTPUT"

if [ "$rc" = "0" ]; then
  ts="$(date +%Y%m%d%H%M%S)"
  mv "$key" "$key.bak-$ts"
  mv "$key.new" "$key"
  chmod 600 "$key"
  echo "Master key rotated. Backup: $key.bak-$ts — it can still decrypt the PREVIOUS ciphertext; delete it once you verified the app (pnpm doctor) and keep it out of backups."
  exit 0
fi

if [ $resume -ne 1 ]; then
  rm -f "$key.new"
fi
echo "Rotation aborted (helper exit $rc); the current master key is unchanged." >&2
exit "$rc"
