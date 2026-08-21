#!/usr/bin/env bash
# image.sh — builds the workspace image for this instance and proves the result carries this tree.
#
# The tag is the instance's own (env.sh derives `agent-hangar/workspace:<instance>`), so a build
# here cannot retarget what another checkout's next container is created from. `WORKSPACE_IMAGE`
# exported in the shell still names the tag to build, because building a tag on somebody's behalf
# — the end-to-end harness builds its own — is a thing a build command legitimately does; what it
# may not be is the *default*.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"

# shellcheck source=/dev/null
. "$here/workspace-image.sh"

# The tag: an explicit one from the shell, otherwise the instance's own. Naming a tag outright is
# the one thing a build command may do that no other command may — the end-to-end harness builds
# the image of the instance it is about to run — so it is read before anything else. Otherwise the
# instance decides, resolved the way every command that acts on a configured instance resolves it.
image="${WORKSPACE_IMAGE:-}"
if [ -z "$image" ]; then
  instance_env="$(bash "$here/env.sh" --print-checked)" || exit "$?"
  eval "$instance_env"
  image="$WORKSPACE_IMAGE"
fi

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

digest="$(ah_workspace_digest)"
echo "building $image from infra/workspace (digest ${digest:0:12})"
docker build --build-arg "AH_WORKSPACE_DIGEST=$digest" -t "$image" infra/workspace

# What the tag resolves to now, asked of Docker rather than assumed from an exit status. A build
# whose every layer is cached prints CACHED and succeeds, so "docker build returned 0" says nothing
# about which image the tag ended up on; this does.
built="$(ah_image_digest "$image")"
if [ "$built" != "$digest" ]; then
  echo "error: $image carries digest \"$built\" after the build, expected \"$digest\"." >&2
  echo "The tag was not moved to the image this build produced. Retry with \"docker build --no-cache -t $image infra/workspace\" and report it if it persists." >&2
  exit 1
fi
echo "$image is current with this tree"
