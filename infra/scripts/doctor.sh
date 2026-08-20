#!/usr/bin/env bash
# doctor.sh — environment diagnostics table (spec 05 §4). One row per check, an exact fix command
# for every ✗/⚠, and a non-zero exit iff a required row is ✗. `--json` prints the same rows as a
# JSON array instead of the table.
#
# AH_DOCTOR_HELPER_CMD overrides the prefix used to run the TypeScript helpers under
# infra/scripts/lib/*.main.ts (default: `pnpm exec tsx`) — tests point it at a shim.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

json_mode=0
case "${1:-}" in
  --json) json_mode=1 ;;
  "") ;;
  *)
    echo "usage: doctor.sh [--json]" >&2
    exit 2
    ;;
esac

eval "$(bash "$here/env.sh" --print)"

ROW_NAMES=()
ROW_STATUSES=()
ROW_DETAILS=()
ROW_FIXES=()
required_failed=0

# add_row <name> <status> <detail> <fix> <required 0|1>
add_row() {
  ROW_NAMES+=("$1")
  ROW_STATUSES+=("$2")
  ROW_DETAILS+=("$3")
  ROW_FIXES+=("$4")
  if [ "$5" = "1" ] && [ "$2" = "✗" ]; then
    required_failed=$((required_failed + 1))
  fi
}

ah_tcp_open() {
  (exec 3<>"/dev/tcp/$1/$2") 2>/dev/null
}

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
  if HELPER_OUTPUT=$("${cmd[@]}" "$root/infra/scripts/lib/$1" 2>&1); then
    HELPER_RC=0
  else
    HELPER_RC=$?
  fi
}

check_node() {
  local version major
  version=$(node -v 2>/dev/null || printf '')
  major=$(printf '%s' "$version" | sed -E 's/^v([0-9]+).*/\1/')
  if [ -n "$major" ] && [ "$major" -ge 24 ] 2>/dev/null; then
    row_status="✓"; row_fix=""
  else
    row_status="✗"; row_fix="nvm install 24 && nvm use 24"
  fi
  row_detail="${version:-not found}"
}

check_pnpm() {
  local version major
  version=$(pnpm -v 2>/dev/null || printf '')
  major=$(printf '%s' "$version" | cut -d. -f1)
  if [ -n "$major" ] && [ "$major" -ge 11 ] 2>/dev/null; then
    row_status="✓"; row_fix=""
  else
    row_status="✗"; row_fix="corepack enable && corepack prepare pnpm@11 --activate"
  fi
  row_detail="${version:-not found}"
}

check_docker_socket() {
  if [ -n "${DOCKER_HOST:-}" ]; then
    row_detail="$DOCKER_HOST"
  elif [ -S "$HOME/.docker/run/docker.sock" ]; then
    export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
    row_detail="$DOCKER_HOST"
  else
    row_detail="/var/run/docker.sock"
  fi
  if docker info >/dev/null 2>&1; then
    row_status="✓"; row_fix=""
  else
    row_status="✗"
    row_fix="Start Docker Desktop (or set DOCKER_HOST=unix://\$HOME/.docker/run/docker.sock)"
  fi
}

check_postgres() {
  row_detail="127.0.0.1:$POSTGRES_PORT"
  if ah_tcp_open 127.0.0.1 "$POSTGRES_PORT"; then
    row_status="✓"; row_fix=""
  else
    row_status="✗"; row_fix="pnpm infra:up"
  fi
}

check_redis() {
  row_detail="127.0.0.1:$REDIS_PORT"
  if ah_tcp_open 127.0.0.1 "$REDIS_PORT"; then
    row_status="✓"; row_fix=""
  else
    row_status="✗"; row_fix="pnpm infra:up"
  fi
}

check_migrations() {
  if [ "$postgres_ok" != "1" ]; then
    row_status="–"; row_detail="postgres down"; row_fix=""
    return 0
  fi
  if pnpm --filter @agent-hangar/core exec prisma migrate status >/dev/null 2>&1; then
    row_status="✓"; row_detail="up to date"; row_fix=""
  else
    row_status="✗"; row_detail="pending"; row_fix="pnpm db:migrate"
  fi
}

check_workspace_image() {
  if [ "$docker_ok" != "1" ]; then
    row_status="–"; row_detail="docker unreachable"; row_fix=""
    return 0
  fi
  if docker image inspect "$WORKSPACE_IMAGE" >/dev/null 2>&1; then
    row_status="✓"; row_detail="$WORKSPACE_IMAGE"; row_fix=""
  else
    row_status="✗"; row_detail="missing"; row_fix="pnpm infra:image"
  fi
}

# Number of hex characters a master key file holds; `MasterKeyFile` accepts nothing else.
readonly MASTER_KEY_HEX_LENGTH=64

# Checks the key the way a reader does, not just that a file is there. A key that exists with the
# right mode but cannot actually be loaded — a symlink, which `MasterKeyFile` refuses outright via
# O_NOFOLLOW, or content that is not 64 hex characters — used to reach only the optional Secrets
# row, where it rendered as a skip and left the run exiting 0 on a machine whose credentials were
# unreadable. A required dependency that fails must fail a required row.
check_master_key() {
  if [ -L "$MASTER_KEY_PATH" ]; then
    row_status="✗"; row_detail="symlink"
    row_fix="Replace $MASTER_KEY_PATH with a regular file (the loader refuses to follow links)"
    return 0
  fi
  if [ ! -f "$MASTER_KEY_PATH" ]; then
    row_status="✗"; row_detail="missing"; row_fix="pnpm setup"
    return 0
  fi
  local mode
  # GNU and BSD stat spell the format flag differently, and neither fails cleanly when handed the
  # other's: GNU reads -f as --file-system and treats the format string as a second file operand, so
  # it still prints a filesystem block on stdout for the real file while exiting non-zero. Asking for
  # the GNU form FIRST is what keeps the fallback honest — the BSD build rejects -c as an illegal
  # option and writes nothing to stdout, so only one of the two ever contributes output.
  mode=$(stat -c '%a' "$MASTER_KEY_PATH" 2>/dev/null || stat -f '%Lp' "$MASTER_KEY_PATH")
  case "$mode" in
    600|400) ;;
    *)
      row_status="✗"; row_detail="mode $mode"; row_fix="chmod 600 \"$MASTER_KEY_PATH\""
      return 0
      ;;
  esac
  # Command substitution strips the trailing newline, so a well-formed file is exactly the hex and
  # nothing else. The case pattern rejects any character outside the set — a newline included, so a
  # multi-line file cannot slip through the way a line-oriented grep would let it.
  local content
  content=$(cat "$MASTER_KEY_PATH")
  case "$content" in
    *[!0-9a-fA-F]*|'')
      row_status="✗"; row_detail="malformed"
      row_fix="Restore $MASTER_KEY_PATH from a .bak-* backup, or pnpm setup for a new key"
      return 0
      ;;
  esac
  if [ "${#content}" -ne "$MASTER_KEY_HEX_LENGTH" ]; then
    row_status="✗"; row_detail="malformed (${#content} of $MASTER_KEY_HEX_LENGTH hex characters)"
    row_fix="Restore $MASTER_KEY_PATH from a .bak-* backup, or pnpm setup for a new key"
    return 0
  fi
  row_status="✓"; row_detail="$MASTER_KEY_PATH (mode $mode)"; row_fix=""
}

secrets_openai_set=0

# format_secret_detail <raw>: "unset" -> "unset"; "set:ab12" -> "set (…ab12)".
format_secret_detail() {
  case "$1" in
    unset) printf 'unset' ;;
    set:*) printf 'set (…%s)' "${1#set:}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Fills row_status/row_detail/row_fix and secrets_openai_set from a successful helper run.
check_secrets_ok() {
  local github openai
  github=$(printf '%s\n' "$HELPER_OUTPUT" | sed -n 's/^GITHUB_PAT=//p')
  openai=$(printf '%s\n' "$HELPER_OUTPUT" | sed -n 's/^OPENAI_API_KEY=//p')
  row_detail="GitHub PAT: $(format_secret_detail "$github") · OpenAI key: $(format_secret_detail "$openai")"
  if [ "${github%%:*}" = "set" ] && [ "${openai%%:*}" = "set" ]; then
    row_status="✓"; row_fix=""
  else
    row_status="⚠"; row_fix="Open http://localhost:$WEB_PORT/settings and save the missing key"
  fi
  if [ "${openai%%:*}" = "set" ]; then
    secrets_openai_set=1
  fi
}

check_secrets() {
  if [ "$postgres_ok" != "1" ] || [ "$master_key_ok" != "1" ]; then
    row_status="–"; row_detail="master key or database unavailable"; row_fix=""
    return 0
  fi
  run_helper secrets-status.main.ts
  case "$HELPER_RC" in
    0) check_secrets_ok ;;
    3) row_status="–"; row_detail="db-unreachable"; row_fix="" ;;
    4) row_status="–"; row_detail="master-key-missing"; row_fix="" ;;
    *) row_status="–"; row_detail="helper error ($HELPER_RC)"; row_fix="" ;;
  esac
}

check_openai_model() {
  if [ "$secrets_openai_set" != "1" ]; then
    row_status="–"; row_detail="no OpenAI key"; row_fix=""
    return 0
  fi
  run_helper openai-check.main.ts
  case "$HELPER_RC" in
    0)
      row_status="✓"; row_detail="${HELPER_OUTPUT#ok }"; row_fix=""
      ;;
    5)
      row_status="⚠"; row_detail="$HELPER_OUTPUT"
      row_fix="Set OPENAI_MODEL in .env.local to one of the listed models"
      ;;
    6)
      row_status="⚠"; row_detail="auth"; row_fix="Replace the OpenAI key in Settings"
      ;;
    *)
      row_status="⚠"; row_detail="$HELPER_OUTPUT"; row_fix="Check network / OPENAI_BASE_URL"
      ;;
  esac
}

check_node; add_row "Node" "$row_status" "$row_detail" "$row_fix" 1
check_pnpm; add_row "pnpm" "$row_status" "$row_detail" "$row_fix" 1
check_docker_socket; add_row "Docker socket" "$row_status" "$row_detail" "$row_fix" 1
docker_ok=0; [ "$row_status" = "✓" ] && docker_ok=1
check_postgres; add_row "Postgres" "$row_status" "$row_detail" "$row_fix" 1
postgres_ok=0; [ "$row_status" = "✓" ] && postgres_ok=1
check_redis; add_row "Redis" "$row_status" "$row_detail" "$row_fix" 1
check_migrations; add_row "Migrations" "$row_status" "$row_detail" "$row_fix" 1
check_workspace_image; add_row "Workspace image" "$row_status" "$row_detail" "$row_fix" 1
check_master_key; add_row "Master key" "$row_status" "$row_detail" "$row_fix" 1
master_key_ok=0; [ "$row_status" = "✓" ] && master_key_ok=1
check_secrets; add_row "Secrets" "$row_status" "$row_detail" "$row_fix" 0
check_openai_model; add_row "OpenAI model" "$row_status" "$row_detail" "$row_fix" 0

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

emit_table() {
  echo "Agent Hangar doctor · instance=$AH_INSTANCE · ports $WEB_PORT/$POSTGRES_PORT/$REDIS_PORT · db $POSTGRES_DB"
  printf '%-16s %-3s %-40s %s\n' "Check" "St" "Detail" "Fix"
  local i=0
  while [ "$i" -lt "${#ROW_NAMES[@]}" ]; do
    printf '%-16s %-3s %-40s %s\n' "${ROW_NAMES[$i]}" "${ROW_STATUSES[$i]}" "${ROW_DETAILS[$i]}" "${ROW_FIXES[$i]}"
    i=$((i + 1))
  done
  if [ "$required_failed" -gt 0 ]; then
    echo "$required_failed required check(s) failed"
  else
    echo "All required checks passed"
  fi
}

emit_json() {
  local i=0 sep=""
  printf '['
  while [ "$i" -lt "${#ROW_NAMES[@]}" ]; do
    printf '%s{"check":"%s","status":"%s","detail":"%s","fix":"%s"}' \
      "$sep" "$(json_escape "${ROW_NAMES[$i]}")" "$(json_escape "${ROW_STATUSES[$i]}")" \
      "$(json_escape "${ROW_DETAILS[$i]}")" "$(json_escape "${ROW_FIXES[$i]}")"
    sep=","
    i=$((i + 1))
  done
  printf ']\n'
}

if [ "$json_mode" = "1" ]; then
  emit_json
else
  emit_table
fi

if [ "$required_failed" -gt 0 ]; then
  exit 1
fi
exit 0
