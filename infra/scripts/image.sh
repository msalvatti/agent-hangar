#!/usr/bin/env bash
# Builds the workspace image (WORKSPACE_IMAGE from .env.local when present, default tag otherwise).
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"

if [ -f .env.local ]; then
  set -a
  # shellcheck source=/dev/null
  . ./.env.local
  set +a
fi

image="${WORKSPACE_IMAGE:-agent-hangar/workspace:dev}"
echo "building $image from infra/workspace"
docker build -t "$image" infra/workspace
