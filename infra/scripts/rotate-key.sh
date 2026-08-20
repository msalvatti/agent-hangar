#!/usr/bin/env bash
# rotate-key.sh — generates a new master key, re-encrypts every stored secret under it, then puts
# the new key in place and keeps a timestamped backup of the old one.
#
# A rotation changes two things that cannot be changed together: the rows in Postgres and the key
# file on disk. The phase it has reached is therefore written to "<key>.rotation" before each step,
# and `--resume` reads it back:
#
#   prepared      the new key file exists and the database has not been touched. Resuming
#                 re-encrypts exactly as a fresh run would.
#   reencrypting  the helper was started. Rows may be under the current key, under the new key, or
#                 split between them (a rollback that could not finish leaves them split).
#                 Resuming re-encrypts in salvage mode: each row is opened with whichever of the
#                 two keys authenticates it — AES-GCM makes that unambiguous, an envelope opens
#                 under exactly one key and fails closed under the other — and rewritten under the
#                 new key. Salvage is correct for all three of those states, which is also why a
#                 lost state file falls back to it.
#   reencrypted   every row is under the new key and only the key files are left to put in place.
#                 Resuming skips the helper entirely, so the swap finishes even while the database
#                 is unreachable.
#
# Putting the key in place copies "<key>" to the backup first and then RENAMES "<key>.new" over
# "<key>". "<key>" therefore always exists — holding either the old material or the new one, never
# nothing — and the old material is already on disk under the backup name before it stops being the
# current key.
#
# No key file is ever deleted while a row might still be sealed under it. "<key>" is never deleted
# at all (it is copied, then replaced in place); "<key>.new" is deleted only when the helper
# reported that every row is back under the current key.
#
# Flags:
#   --yes      required to actually rotate; without it the plan is printed and nothing runs
#   --resume   continue a previously interrupted rotation
set -euo pipefail

# Helper exit codes, mirroring lib/rotate-key.ts, which is the only place that produces them.
# EXIT_ABORTED: nothing was written. EXIT_ROLLED_BACK: a partial rotation was fully undone.
# EXIT_COMPENSATION_INCOMPLETE: undoing it failed and the store is split across the two keys.
readonly EXIT_ABORTED=2
readonly EXIT_ROLLED_BACK=3
readonly EXIT_COMPENSATION_INCOMPLETE=4

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

eval "$(bash "$here"/env.sh --print)"
key="$MASTER_KEY_PATH"
state="$key.rotation"

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
#
# The default prefix is three words and the override is a single executable path, so both are held
# in an array: expanded as "${cmd[@]}" the word boundaries come from the array, never from
# splitting a string on whitespace, and a path containing a space still resolves to one command.
run_helper() {
  local cmd=(pnpm exec tsx)
  if [ -n "${AH_DOCTOR_HELPER_CMD:-}" ]; then
    cmd=("$AH_DOCTOR_HELPER_CMD")
  fi
  if HELPER_OUTPUT=$("${cmd[@]}" "$here/lib/$1" 2>&1); then
    HELPER_RC=0
  else
    HELPER_RC=$?
  fi
}

# read_state <field>: prints the value of the "<field>=<value>" line, or nothing when the state
# file does not exist or does not carry that field.
read_state() {
  [ -f "$state" ] || return 0
  sed -n "s/^$1=//p" "$state"
}

# write_state <phase> <backup path>: records the phase reached, before the step it describes runs.
write_state() {
  printf 'phase=%s\nbackup=%s\n' "$1" "$2" > "$state"
  chmod 600 "$state"
}

# free_backup_path: prints a backup path no file occupies yet. The timestamp has a one-second
# resolution, so two rotations of a small store can land on the same name; reusing it would replace
# a backup that is still the only copy of the key it holds.
free_backup_path() {
  local stamp candidate suffix
  stamp="$(date +%Y%m%d%H%M%S)"
  candidate="$key.bak-$stamp"
  suffix=1
  while [ -e "$candidate" ]; do
    candidate="$key.bak-$stamp.$suffix"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

# put_key_in_place <backup path>: keeps the current key under <backup path> and makes "<key>.new"
# the current key. Idempotent — a crash anywhere inside it is finished by running it again — and it
# leaves no instant in which "<key>" is missing.
put_key_in_place() {
  local backup="$1"
  if [ -f "$key.new" ]; then
    if [ ! -f "$backup" ]; then
      cp "$key" "$backup"
      chmod 600 "$backup"
    fi
    mv "$key.new" "$key"
    chmod 600 "$key"
  fi
  rm -f "$state"
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
  if [ -f "$state" ]; then
    echo "  in progress: phase $(read_state phase) — finish it with --yes --resume"
  fi
  exit 2
fi

umask 077

# Nothing below can run without the key it rotates away from: the helper decrypts with it and the
# backup is a copy of it. Saying so here beats failing halfway with a bare `cp` error, and it is
# also the state an operator lands in after restoring only part of a rotation by hand.
if [ ! -f "$key" ]; then
  echo "No master key at $key. Create one with pnpm setup, or restore it from a $key.bak-* backup, before rotating." >&2
  exit 1
fi

phase="$(read_state phase)"
backup="$(read_state backup)"

if [ $resume -ne 1 ]; then
  if [ -f "$key.new" ] || [ -f "$state" ]; then
    echo "A previous rotation was interrupted (phase ${phase:-unknown}); re-run with --resume. Do not delete $key.new before then: secrets may be sealed under it." >&2
    exit 1
  fi
  openssl rand -hex 32 > "$key.new"
  chmod 600 "$key.new"
  write_state prepared ""
  phase="prepared"
elif [ ! -f "$key.new" ] && [ ! -f "$state" ]; then
  echo "Nothing to resume: neither $key.new nor $state exists." >&2
  exit 1
elif [ -z "$phase" ]; then
  # The state file is gone but "<key>.new" is still here, so how far the interrupted run got is
  # unknown. Salvage handles every pre-swap state, so assume the widest one.
  phase="reencrypting"
fi

if [ "$phase" = "reencrypted" ]; then
  if [ -z "$backup" ]; then
    echo "Corrupt rotation state: $state records phase reencrypted without a backup path. Restore the backup line or move $key.new aside manually." >&2
    exit 1
  fi
else
  mode="salvage"
  if [ "$phase" = "prepared" ]; then
    mode="strict"
  fi
  write_state reencrypting ""
  export AH_NEW_MASTER_KEY_PATH="$key.new"
  export AH_ROTATION_MODE="$mode"
  set +e
  run_helper rotate-key.main.ts
  rc=$HELPER_RC
  set -e
  unset AH_NEW_MASTER_KEY_PATH AH_ROTATION_MODE
  echo "$HELPER_OUTPUT"

  if [ "$rc" != "0" ]; then
    # "$key.new" may only be removed when every row is provably back under the current key. The
    # helper says so in exactly two ways: it rolled the partial rotation back, or it aborted a
    # strict run — which writes nothing, to a store that was wholly under the current key to begin
    # with. Any other outcome, a salvage abort and a killed helper included, leaves the split
    # possible, and deleting either key file would then destroy the credentials it holds.
    if [ "$rc" = "$EXIT_ROLLED_BACK" ] ||
      { [ "$rc" = "$EXIT_ABORTED" ] && [ "$mode" = "strict" ]; }; then
      rm -f "$key.new" "$state"
      echo "Rotation aborted (helper exit $rc); the current master key is unchanged." >&2
      exit "$rc"
    fi
    if [ "$rc" = "$EXIT_COMPENSATION_INCOMPLETE" ]; then
      echo "Rotation failed during rollback. Part of the store is now sealed under $key.new and the rest under $key: KEEP BOTH files (mode 600, out of backups) — deleting either one destroys the credentials it holds. Re-run with --resume once the database is reachable again." >&2
    else
      echo "Rotation stopped in phase reencrypting (helper exit $rc). Rows may be sealed under $key.new: KEEP BOTH files (mode 600, out of backups) and re-run with --resume; it opens each row with whichever key authenticates it." >&2
    fi
    exit "$rc"
  fi

  backup="$(free_backup_path)"
  write_state reencrypted "$backup"
fi

put_key_in_place "$backup"
echo "Master key rotated. Backup: $backup — it can still decrypt the PREVIOUS ciphertext; delete it once you verified the app (pnpm doctor) and keep it out of backups."
exit 0
