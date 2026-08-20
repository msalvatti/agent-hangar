#!/usr/bin/env bash
# Derives the per-instance environment (ports, database, compose project, container prefix) from
# AH_INSTANCE / AH_PORT_BASE, falling back to CONDUCTOR_WORKSPACE_NAME / CONDUCTOR_PORT, then to
# default / 3000. Mirrors packages/core/src/config/instance.ts — a test keeps both in sync.
#
# The instance identity — AH_INSTANCE, AH_PORT_BASE and everything derived from them (ports,
# database name, URLs, compose project, container prefix) — is computed here and only here. Those
# variables are NOT read from the environment, so nothing can hold an instance's name while
# pointing its connection strings at another instance's data. The remaining variables are ordinary
# configuration and an explicit value in the environment does win over the default.
#
# AH_ENV_FILE overrides the path of the env file read/written below (default: <repo-root>/.env.local),
# so tests exercise this script against a throwaway file instead of the developer's real one.
#
# Usage:
#   infra/scripts/env.sh                 write .env.local if absent
#   infra/scripts/env.sh --force         overwrite .env.local
#   infra/scripts/env.sh --print         print `export KEY=value` lines derived from this shell
#                                        (eval "$(infra/scripts/env.sh --print)")
#   infra/scripts/env.sh --print-effective
#                                        print `export KEY=value` lines from .env.local when it
#                                        exists, else the derived ones — the environment every
#                                        step of a run must agree on. An existing file that does
#                                        not define every key is refused (exit 4) naming the ones
#                                        it is missing, rather than left for the first consumer to
#                                        dereference; see ah_assert_complete
#   infra/scripts/env.sh --print-checked
#                                        same output as --print-effective, plus a refusal (exit 3)
#                                        when the shell explicitly names an instance the file
#                                        contradicts. Every command that acts on an already
#                                        configured instance reads this mode; see
#                                        ah_assert_agreement for why disagreement is refused
#                                        rather than resolved, and for the AH_ENV_FILE path that
#                                        runs a command against a second instance from a checkout
#                                        configured for a different one
#
# Runs on macOS bash 3.2: no associative arrays, no mapfile.
set -euo pipefail

ah_root_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# Lowercase, anything outside [a-z0-9-] becomes "-", runs collapse, ends trimmed, max 30 chars.
ah_slugify() {
  local value
  value=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/-+/-/g; s/^-//; s/-$//')
  value=${value:0:30}
  value=$(printf '%s' "$value" | sed -E 's/-$//')
  if [ -z "$value" ]; then
    value="default"
  fi
  printf '%s' "$value"
}

ah_first_non_empty() {
  local candidate
  for candidate in "$@"; do
    candidate=$(printf '%s' "$candidate" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
    if [ -n "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 0
}

# Exports every derived variable into the current shell.
ah_resolve_env() {
  local raw_instance raw_port
  raw_instance=$(ah_first_non_empty "${AH_INSTANCE:-}" "${CONDUCTOR_WORKSPACE_NAME:-}")
  raw_port=$(ah_first_non_empty "${AH_PORT_BASE:-}" "${CONDUCTOR_PORT:-}")
  if [ -z "$raw_instance" ]; then
    raw_instance="default"
  fi
  if [ -z "$raw_port" ]; then
    raw_port="3000"
  fi
  case "$raw_port" in
    ''|*[!0-9]*)
      echo "error: AH_PORT_BASE must be an integer between 1024 and 65000, got \"$raw_port\"" >&2
      return 1
      ;;
  esac
  if [ "$raw_port" -lt 1024 ] || [ "$raw_port" -gt 65000 ]; then
    echo "error: AH_PORT_BASE must be an integer between 1024 and 65000, got \"$raw_port\"" >&2
    return 1
  fi

  AH_INSTANCE=$(ah_slugify "$raw_instance")
  AH_PORT_BASE=$raw_port
  # Identity block. Every value below is a pure function of AH_INSTANCE/AH_PORT_BASE and ignores
  # any same-named variable already in the environment: an instance is a sealed sandbox, and a
  # POSTGRES_PORT that could be set independently of the base would let a shell calling itself
  # "feat-x" build a DATABASE_URL pointing at another instance's database while every other value
  # still named feat-x. Change the instance or the base to move the ports; nothing else does.
  WEB_PORT=$((AH_PORT_BASE + 0))
  POSTGRES_PORT=$((AH_PORT_BASE + 1))
  REDIS_PORT=$((AH_PORT_BASE + 2))
  POSTGRES_DB="agent_hangar_$(printf '%s' "$AH_INSTANCE" | tr '-' '_')"
  # Local compose credentials (not a secret: loopback only, ciphertext-only contents).
  local db_scheme="postgresql" db_credentials="ah:ah"
  DATABASE_URL="${db_scheme}://${db_credentials}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}"
  REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"
  COMPOSE_PROJECT_NAME="agent-hangar-${AH_INSTANCE}"
  WORKSPACE_NAME_PREFIX="ah-ws-${AH_INSTANCE}-"
  # Configuration block. These name what an instance runs with, not which instance it is, so an
  # explicit value wins over the default and no two instances can collide through one.
  WORKSPACE_IMAGE="${WORKSPACE_IMAGE:-agent-hangar/workspace:dev}"
  MASTER_KEY_PATH="${MASTER_KEY_PATH:-$HOME/.agent-hangar/master.key}"
  WORKSPACE_IDLE_TTL_MIN="${WORKSPACE_IDLE_TTL_MIN:-30}"
  WORKER_TURN_CONCURRENCY="${WORKER_TURN_CONCURRENCY:-2}"
  OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.6-sol}"
  AGENT_MODEL_PROVIDER="${AGENT_MODEL_PROVIDER:-openai}"
  LOG_LEVEL="${LOG_LEVEL:-info}"
  export AH_INSTANCE AH_PORT_BASE WEB_PORT POSTGRES_PORT REDIS_PORT POSTGRES_DB DATABASE_URL \
    REDIS_URL COMPOSE_PROJECT_NAME WORKSPACE_NAME_PREFIX WORKSPACE_IMAGE MASTER_KEY_PATH \
    WORKSPACE_IDLE_TTL_MIN WORKER_TURN_CONCURRENCY OPENAI_MODEL AGENT_MODEL_PROVIDER LOG_LEVEL
}

AH_ENV_KEYS="AH_INSTANCE AH_PORT_BASE WEB_PORT POSTGRES_PORT REDIS_PORT POSTGRES_DB DATABASE_URL REDIS_URL COMPOSE_PROJECT_NAME WORKSPACE_NAME_PREFIX WORKSPACE_IMAGE MASTER_KEY_PATH WORKSPACE_IDLE_TTL_MIN WORKER_TURN_CONCURRENCY OPENAI_MODEL AGENT_MODEL_PROVIDER LOG_LEVEL"

# Double-quotes a value for both `bash` (eval / source) and docker compose `--env-file`:
# backslash, double quote, dollar and backtick are escaped.
ah_quote() {
  printf '%s' "$1" | sed -e 's/[\\"$`]/\\&/g' -e 's/^/"/' -e 's/$/"/'
}

# Prints KEY="value" lines (optionally prefixed, e.g. "export ").
ah_print_env() {
  local prefix="${1:-}" key
  for key in $AH_ENV_KEYS; do
    printf '%s%s=%s\n' "$prefix" "$key" "$(ah_quote "${!key}")"
  done
}

ah_write_env_file() {
  local target="$1"
  {
    echo "# Generated by infra/scripts/env.sh for instance \"$AH_INSTANCE\" — re-run with --force to regenerate."
    echo "# Secrets (GitHub PAT, OpenAI key) are NOT environment variables: enter them in Settings."
    ah_print_env ""
    echo "OPENAI_BASE_URL="
    echo "DOCKER_HOST="
    echo "NEXT_PUBLIC_API_MOCK=0"
  } > "$target"
}

# Re-emits an existing .env.local as `export KEY="value"` lines. Values were quoted by
# ah_write_env_file, so the output is safe to eval; comments and blank lines are dropped.
ah_print_env_file() {
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -e 's/^/export /' "$1"
}

# Instance the shell explicitly asks for, before slugifying; empty when it asks for none.
ah_selected_instance() {
  ah_first_non_empty "${AH_INSTANCE:-}" "${CONDUCTOR_WORKSPACE_NAME:-}"
}

# Port base the shell explicitly asks for; empty when it asks for none.
ah_selected_port_base() {
  ah_first_non_empty "${AH_PORT_BASE:-}" "${CONDUCTOR_PORT:-}"
}

# Prints the value an existing env file records for one key, or nothing when it records none.
# The file is re-read through ah_print_env_file and evaluated in a subshell, so the value comes
# back through exactly the quoting ah_write_env_file put it in rather than through a second parser
# that could disagree with the first.
ah_env_file_value() {
  local target="$1" key="$2"
  (
    unset "$key"
    eval "$(ah_print_env_file "$target")"
    printf '%s' "${!key:-}"
  )
}

# Prints the keys of AH_ENV_KEYS an existing env file does not define, one per line.
#
# Read through ah_print_env_file, so a key that survives only as a comment counts as missing —
# that spelling is what turned an incomplete file into a bare "unbound variable" instead of a
# diagnosis. A key defined but left empty counts as missing too: under `set -u` an empty value
# passes the dereference and then fails somewhere further along, which is the same failure with
# even less to go on.
ah_missing_env_keys() {
  local target="$1" key
  (
    for key in $AH_ENV_KEYS; do
      unset "$key"
    done
    eval "$(ah_print_env_file "$target")"
    for key in $AH_ENV_KEYS; do
      if [ -z "${!key:-}" ]; then
        printf '%s\n' "$key"
      fi
    done
  )
}

# Refuses when an existing env file does not define every variable the run needs.
#
# The file is trusted outright once it exists — that is what keeps compose, the migrations and the
# image build on one instance — so an incomplete one is trusted just as far, and the first consumer
# to dereference a key it never carried fails under `set -u` with a message naming the variable and
# nothing else: not the file, not the other keys it also lacks, not the way out.
#
# The keys are named here instead of being filled in from the derivation, because filling them in
# would only fix this shell. `docker compose --env-file` reads the file itself, so a run that
# repaired POSTGRES_PORT in memory would still bring compose up from a file that does not record
# it — one instance in the shell, another on the ports. And a file missing AH_INSTANCE has nothing
# left to derive *from* except the shell it was written to overrule. Regenerating the file is the
# only repair that leaves every reader agreeing, so that is what this asks for.
#
# The remedy is spelled `pnpm run setup --force`, with the `run`, and so is the one in
# ah_assert_agreement below. `setup` is also the name of a built-in pnpm command, and pnpm parses
# the flags after a built-in name against that command's own option list before it decides to fall
# back to the package script. `--force` is one of the built-in's options, so it is consumed there
# and the script is invoked with no arguments at all — the file is preserved, and this same error
# is printed again. Advice that reproduces the failure it is advising about is worse than none, so
# every remedy that carries a flag names the script through `run`, which passes the rest through
# untouched.
ah_assert_complete() {
  local target="$1" missing key
  missing=$(ah_missing_env_keys "$target")
  if [ -z "$missing" ]; then
    return 0
  fi
  echo "error: $target does not define every variable this instance needs." >&2
  echo "Missing:" >&2
  for key in $missing; do
    echo "  * $key" >&2
  done
  echo "A key that appears only in a comment does not count: the file is read with comments stripped." >&2
  echo "Regenerate it with \"pnpm run setup --force\", or add the missing lines by hand." >&2
  echo "To see what a complete file looks like: bash infra/scripts/env.sh --print" >&2
  return 4
}

# Refuses when the shell explicitly names an instance the env file contradicts.
#
# Two sources can answer "which instance is this command for": the shell, and the env file this
# checkout was set up with. Picking either one silently is what made `archive.sh` tear down the
# DEFAULT instance's compose stack from a checkout configured for another instance, while deleting
# that checkout's own env file — one instance's containers and another instance's configuration,
# from a single command meant to clean up one worktree. The file is the source of truth, because a
# developer who ran setup here expects commands here to act on this checkout; but a shell that
# names an instance is not ignored either, because ignoring it silently is the same class of
# mistake in the other direction. So a disagreement stops the command and says so.
#
# Only what the shell actually sets is compared: a shell naming an instance but no port base is
# not in conflict with a file that records a port base, it simply says nothing about ports.
#
# Running a command against a SECOND instance from a checkout configured for a different one stays
# supported, and goes through AH_ENV_FILE rather than through the shell: an instance is its env
# file, so the second one gets a file of its own (env.sh --force writes it) and AH_ENV_FILE names
# it. That keeps one rule — the file decides — instead of a shell override that would be
# indistinguishable from the stale variable this check exists to catch.
ah_assert_agreement() {
  local target="$1" selected file_value conflict=0
  selected=$(ah_selected_instance)
  if [ -n "$selected" ]; then
    selected=$(ah_slugify "$selected")
    file_value=$(ah_env_file_value "$target" AH_INSTANCE)
    if [ "$selected" != "$file_value" ]; then
      echo "error: this shell selects instance \"$selected\" but $target records instance \"$file_value\"." >&2
      conflict=1
    fi
  fi
  selected=$(ah_selected_port_base)
  if [ -n "$selected" ]; then
    file_value=$(ah_env_file_value "$target" AH_PORT_BASE)
    if [ "$selected" != "$file_value" ]; then
      echo "error: this shell selects port base \"$selected\" but $target records port base \"$file_value\"." >&2
      conflict=1
    fi
  fi
  if [ "$conflict" -eq 0 ]; then
    return 0
  fi
  echo "Refusing to guess which instance this command should act on. Three ways forward:" >&2
  echo "  * unset AH_INSTANCE / AH_PORT_BASE (and CONDUCTOR_WORKSPACE_NAME / CONDUCTOR_PORT) to act on the instance this checkout was set up for;" >&2
  echo "  * run \"pnpm run setup --force\" to move this checkout to the instance the shell names;" >&2
  echo "  * point AH_ENV_FILE at the env file of the other instance to act on it from here without disturbing this checkout. An instance that has none yet gets one with:" >&2
  echo "      AH_ENV_FILE=<path> AH_INSTANCE=<name> AH_PORT_BASE=<base> bash infra/scripts/env.sh --force" >&2
  return 3
}

ah_env_main() {
  local mode="write" root target
  case "${1:-}" in
    --print) mode="print" ;;
    --print-effective) mode="print-effective" ;;
    --print-checked) mode="print-checked" ;;
    --force) mode="force" ;;
    "") ;;
    *)
      echo "usage: env.sh [--print|--print-effective|--print-checked|--force]" >&2
      return 2
      ;;
  esac
  root=$(ah_root_dir)
  target="${AH_ENV_FILE:-$root/.env.local}"
  # The file wins outright, and is echoed without re-deriving anything: the whole point is that a
  # variable exported in this shell cannot disagree with the file docker compose --env-file reads.
  if { [ "$mode" = "print-effective" ] || [ "$mode" = "print-checked" ]; } && [ -f "$target" ]; then
    # Completeness comes first, and before the agreement check as well. Trusting the file means
    # trusting all of it, so the gap is reported here rather than by whichever consumer dereferences
    # a missing key first — and a file that lacks AH_INSTANCE would otherwise be reported as
    # recording the instance "", which describes the symptom instead of the cause.
    ah_assert_complete "$target" || return 4
    if [ "$mode" = "print-checked" ]; then
      ah_assert_agreement "$target" || return 3
    fi
    ah_print_env_file "$target"
    return 0
  fi
  ah_resolve_env
  case "$mode" in
    print|print-effective|print-checked)
      ah_print_env "export "
      ;;
    force)
      ah_write_env_file "$target"
      echo "wrote $target (instance $AH_INSTANCE, ports $WEB_PORT/$POSTGRES_PORT/$REDIS_PORT)"
      ;;
    write)
      if [ -f "$target" ]; then
        echo "$target already exists (use --force to overwrite)"
      else
        ah_write_env_file "$target"
        echo "wrote $target (instance $AH_INSTANCE, ports $WEB_PORT/$POSTGRES_PORT/$REDIS_PORT)"
      fi
      ;;
  esac
}

# Only run when executed directly; sourcing just defines the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  ah_env_main "$@"
fi
