#!/usr/bin/env bash
# First-run setup (idempotent): install dependencies, write .env.local, create the master key,
# start Postgres + Redis for this instance, generate the Prisma client, apply migrations, build
# the workspace image, then run the doctor.
#
# Instance selection: AH_INSTANCE / AH_PORT_BASE (or CONDUCTOR_WORKSPACE_NAME / CONDUCTOR_PORT).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

log() { printf '\n==> %s\n' "$*"; }

log "1/7 Installing dependencies"
pnpm install --frozen-lockfile

log "2/7 Writing .env.local"
bash infra/scripts/env.sh
# shellcheck source=/dev/null
eval "$(bash infra/scripts/env.sh --print)"

log "3/7 Master key ($MASTER_KEY_PATH)"
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

log "4/7 Docker socket"
if [ -n "${DOCKER_HOST:-}" ]; then
  echo "using DOCKER_HOST=$DOCKER_HOST"
elif [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
  echo "using $DOCKER_HOST (Docker Desktop user socket)"
else
  echo "using /var/run/docker.sock (default)"
fi

log "5/7 Starting Postgres + Redis ($COMPOSE_PROJECT_NAME on ports $POSTGRES_PORT/$REDIS_PORT)"
docker compose -f infra/docker-compose.yml --env-file .env.local up -d --wait

log "6/7 Prisma client + migrations ($POSTGRES_DB)"
pnpm --filter @agent-hangar/core db:generate
pnpm --filter @agent-hangar/core db:migrate

log "7/7 Workspace image ($WORKSPACE_IMAGE)"
docker build -t "$WORKSPACE_IMAGE" infra/workspace

log "Doctor"
bash infra/scripts/doctor.sh || true

echo
echo "Setup complete for instance \"$AH_INSTANCE\". Next: pnpm dev  →  http://127.0.0.1:$WEB_PORT"
