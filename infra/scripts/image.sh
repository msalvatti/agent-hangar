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

# The runtime bundle is a build artefact, so it is staged into the build context here rather than
# committed. Three files: the ESM bundle, its source map, and the manifest that declares the module
# type outright — without it Node starts the bundle only by re-parsing a file that failed as
# CommonJS, which `--no-experimental-detect-module` turns off.
echo "bundling the agent runtime"
pnpm --filter @agent-hangar/agent-runtime build
rm -rf infra/workspace/runtime
mkdir -p infra/workspace/runtime
cp packages/agent-runtime/dist/cli.js \
   packages/agent-runtime/dist/cli.js.map \
   packages/agent-runtime/dist/package.json \
   infra/workspace/runtime/

echo "building $image from infra/workspace"
docker build -t "$image" infra/workspace
