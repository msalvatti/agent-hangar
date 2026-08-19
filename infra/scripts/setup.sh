#!/usr/bin/env bash
# First-run setup — idempotent end to end: install dependencies, write .env.local, create the
# master key, start Postgres + Redis for this instance, generate the Prisma client, apply
# migrations, build the workspace image (only when missing), then run the doctor and propagate
# its exit code.
#
# Instance selection: AH_INSTANCE / AH_PORT_BASE (or CONDUCTOR_WORKSPACE_NAME / CONDUCTOR_PORT).
#
# Flags:
#   --force          rewrite .env.local even when it already exists
#   --rebuild-image  rebuild the workspace image even when it is already present
#   --skip-doctor    do not run the doctor at the end (used by CI and by earlier lane tasks)
#   --skip-install   skip `pnpm install --frozen-lockfile` (CI already installed)
#
# AH_ENV_FILE, MASTER_KEY_PATH and AH_DOCTOR_SCRIPT are honoured throughout so tests can point
# every step at a throwaway location instead of the developer's real files.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
here="$root/infra/scripts"
cd "$root"

force=0
rebuild_image=0
skip_doctor=0
skip_install=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --rebuild-image) rebuild_image=1 ;;
    --skip-doctor) skip_doctor=1 ;;
    --skip-install) skip_install=1 ;;
    *)
      echo "usage: setup.sh [--force] [--rebuild-image] [--skip-doctor] [--skip-install]" >&2
      exit 2
      ;;
  esac
  shift
done

env_file="${AH_ENV_FILE:-$root/.env.local}"

log() { printf '\n==> %s\n' "$*"; }

log "1/7 Installing dependencies"
if [ $skip_install -eq 1 ]; then
  echo "skipped (--skip-install)"
else
  pnpm install --frozen-lockfile
fi

log "2/7 Writing $env_file"
if [ $force -eq 1 ]; then
  bash "$here"/env.sh --force
else
  bash "$here"/env.sh
fi
# Load what the env file defines rather than re-deriving from this shell. `docker compose
# --env-file` below reads that file, so on a second run an exported AH_INSTANCE/AH_PORT_BASE that
# disagrees with the preserved file would bring compose up on one instance's ports while the
# migrations and the image build targeted another.
eval "$(bash "$here"/env.sh --print-effective)"

log "3/7 Docker socket"
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "using DOCKER_HOST=$DOCKER_HOST"
elif [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  echo "using $DOCKER_HOST (Docker Desktop user socket)"
else
  echo "using /var/run/docker.sock (default)"
fi
if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not reachable. Start Docker Desktop, or set DOCKER_HOST=unix://\$HOME/.docker/run/docker.sock" >&2
  exit 1
fi

log "4/7 Master key ($MASTER_KEY_PATH)"
key_dir=$(dirname "$MASTER_KEY_PATH")
if [ ! -d "$key_dir" ]; then
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"
fi
if [ ! -f "$MASTER_KEY_PATH" ]; then
  umask 077
  openssl rand -hex 32 > "$MASTER_KEY_PATH"
  chmod 600 "$MASTER_KEY_PATH"
  echo "created new master key"
else
  echo "master key present"
fi
# Refuse group/world-readable keys: the file decrypts every stored credential.
key_mode=$(stat -f '%Lp' "$MASTER_KEY_PATH" 2>/dev/null || stat -c '%a' "$MASTER_KEY_PATH")
case "$key_mode" in
  600|400) ;;
  *)
    echo "error: $MASTER_KEY_PATH has mode $key_mode; it must be 0600 (run: chmod 600 \"$MASTER_KEY_PATH\")" >&2
    exit 1
    ;;
esac

log "5/7 Starting Postgres + Redis ($COMPOSE_PROJECT_NAME on ports $POSTGRES_PORT/$REDIS_PORT)"
docker compose -f "$root/infra/docker-compose.yml" --env-file "$env_file" up -d --wait

log "6/7 Prisma client + migrations ($POSTGRES_DB)"
pnpm --filter @agent-hangar/core db:generate
pnpm --filter @agent-hangar/core db:migrate

log "7/7 Workspace image ($WORKSPACE_IMAGE)"
if [ $rebuild_image -eq 1 ] || ! docker image inspect "$WORKSPACE_IMAGE" >/dev/null 2>&1; then
  docker build -t "$WORKSPACE_IMAGE" infra/workspace
else
  echo "workspace image present ($WORKSPACE_IMAGE); use --rebuild-image to force a rebuild"
fi

echo
echo "Summary: instance=$AH_INSTANCE ports=$WEB_PORT/$POSTGRES_PORT/$REDIS_PORT db=$POSTGRES_DB compose=$COMPOSE_PROJECT_NAME image=$WORKSPACE_IMAGE key=$MASTER_KEY_PATH"

log "Doctor"
doctor_script="${AH_DOCTOR_SCRIPT:-$here/doctor.sh}"
doctor_status=0
if [ $skip_doctor -eq 1 ]; then
  echo "skipped (--skip-doctor)"
else
  bash "$doctor_script" || doctor_status=$?
fi

echo
echo "Setup complete for instance \"$AH_INSTANCE\". Next: pnpm dev  →  http://127.0.0.1:$WEB_PORT"
exit $doctor_status
