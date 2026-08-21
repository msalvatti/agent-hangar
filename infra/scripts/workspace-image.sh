#!/usr/bin/env bash
# workspace-image.sh — the identity and the freshness of the workspace image, in one place.
#
# Two failures this answers, both of which used to be silent:
#
#   * one checkout's `pnpm infra:image` deciding what another checkout's next container runs. The
#     tag now carries the instance (env.sh derives it), so this asserts that the tag in use really
#     is the one the instance derives — an .env.local written before that change records the old
#     machine-global tag and would keep the collision;
#   * an image that lags the checkout it is used from. `pnpm infra:image` rebuilds the bundle and
#     copies it, but a build that carries nothing new still reports success, and the run that
#     follows measures a combination of worker and runtime that exists in no tree. So the build
#     stamps a digest of what it carried into the image, and every command that is about to use
#     the image recomputes that digest from its own tree and compares.
#
# The digest is over the bundle's own bytes — rebuilt in memory from source by
# packages/agent-runtime/scripts/bundle-digest.mjs — plus the two files of the build context that
# are not generated. Not a commit id, and not a timestamp: a rebuild that consumed stale generated
# output would stamp the current HEAD onto older bytes, and uncommitted changes share a commit id
# with the code they differ from, so either would accept the very image this exists to reject
# while reporting it verified.
#
# Usage:
#   workspace-image.sh --digest                    print the digest of the tree
#   workspace-image.sh --image-digest <tag>        print the digest an existing image carries
#   workspace-image.sh --status <tag>              current | stale | missing | unverifiable | unavailable
#   workspace-image.sh --assert-tag <tag> <name>   refuse a tag that is not instance <name>'s
#
# Runs on macOS bash 3.2.
set -euo pipefail

# Image label the build stamps the digest into.
AH_IMAGE_DIGEST_LABEL="ah.workspace.digest"

ah_wsi_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# Prints the SHA-256 of stdin as bare hex. GNU coreutils spells the tool `sha256sum` and macOS
# ships `shasum` instead; both print "<hex>  -", so only the name differs. `command -v` decides,
# rather than running one and falling back on its failure: a tool that exists but fails for
# another reason must not be papered over by the other one.
ah_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# Digest of everything the workspace image is built from, computed from this tree.
#
# The bundle is hashed from a build performed here and now, so the answer describes the source
# rather than whatever a previous build left in dist/. The Dockerfile and askpass.sh are the rest
# of the image's behaviour and are hashed as they sit. The three go through a second hash so the
# result is one fixed-length value, and so a change in any of them changes it.
ah_workspace_digest() {
  local root bundle dockerfile askpass
  root=$(ah_wsi_root)
  # Each step is checked, and an empty answer counts as a failure: `set -e` does not apply inside
  # the command substitution a caller tests the result of, so an unchecked step would contribute an
  # empty string to the manifest and produce a perfectly stable digest of nothing.
  bundle=$(node "$root/packages/agent-runtime/scripts/bundle-digest.mjs") || return 1
  dockerfile=$(ah_sha256_stdin < "$root/infra/workspace/Dockerfile") || return 1
  askpass=$(ah_sha256_stdin < "$root/infra/workspace/askpass.sh") || return 1
  if [ -z "$bundle" ] || [ -z "$dockerfile" ] || [ -z "$askpass" ]; then
    return 1
  fi
  printf 'bundle %s\ndockerfile %s\naskpass %s\n' "$bundle" "$dockerfile" "$askpass" \
    | ah_sha256_stdin
}

# Digest an existing image carries, or nothing when the image is absent, unlabelled or Docker is
# not reachable. The three are told apart by ah_workspace_image_status, which asks Docker first.
ah_image_digest() {
  docker image inspect --format "{{index .Config.Labels \"$AH_IMAGE_DIGEST_LABEL\"}}" "$1" \
    2>/dev/null || printf ''
}

# Prints one word for how far the image can be trusted:
#
#   current       it carries the digest this tree produces
#   stale         it exists but carries another digest, or none at all because it predates the
#                 label — either way what it would run is not what this checkout says
#   missing       Docker answered and has no such image; already loud everywhere it matters (the
#                 worker logs it, the health endpoint reports it, the doctor has a row)
#   unverifiable  the image is there and this tree could not produce a digest to compare it with
#   unavailable   Docker did not answer, so there is neither an image to judge nor a container it
#                 could be creating
#
# The last two are one situation — "not checked" — told apart because they cost their callers
# different things, and folding them together made one of those callers wrong. `pnpm dev` must
# start with Docker stopped, since the interface is worked on without it; it must NOT start against
# an image it holds in its hand and cannot vouch for. A single word for both forced a choice
# between blocking the first and waving through the second.
#
# Neither is ever rounded to `current`: a check that reports success without checking is worse than
# no check. Both say why on stderr.
#
# Never exits non-zero: the caller decides what each answer costs it.
ah_workspace_image_status() {
  local tag="$1" tree_digest image_digest
  if ! docker image inspect "$tag" >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      printf 'missing\n'
    else
      echo "workspace image not verified: Docker is not reachable" >&2
      printf 'unavailable\n'
    fi
    return 0
  fi
  if ! tree_digest=$(ah_workspace_digest 2>/dev/null); then
    echo "workspace image not verified: the runtime bundle could not be built from this tree" >&2
    printf 'unverifiable\n'
    return 0
  fi
  image_digest=$(ah_image_digest "$tag")
  if [ "$image_digest" = "$tree_digest" ]; then
    printf 'current\n'
  else
    printf 'stale\n'
  fi
}

# Refuses a tag that is not the one the named instance derives.
#
# The remedy names `pnpm run setup --force`, with the `run`: `setup` is also a built-in pnpm
# command and `--force` is one of its options, so without `run` the flag is consumed by pnpm and
# the script is invoked with no arguments at all — advice that reproduces the problem it advises
# about.
ah_assert_workspace_image_tag() {
  local tag="$1" instance="$2" derived
  derived="agent-hangar/workspace:$instance"
  if [ "$tag" = "$derived" ]; then
    return 0
  fi
  echo "error: instance \"$instance\" is configured to use the workspace image \"$tag\", but its own image is \"$derived\"." >&2
  echo "A tag another checkout also resolves is a tag another checkout can rebuild, and the rebuild decides what this instance's next container runs." >&2
  echo "Regenerate the environment with \"pnpm run setup --force\", or change the WORKSPACE_IMAGE line of .env.local to \"$derived\"." >&2
  return 3
}

ah_workspace_image_main() {
  case "${1:-}" in
    --digest) ah_workspace_digest ;;
    --image-digest)
      [ $# -eq 2 ] || { echo "usage: workspace-image.sh --image-digest <tag>" >&2; return 2; }
      ah_image_digest "$2"
      ;;
    --status)
      [ $# -eq 2 ] || { echo "usage: workspace-image.sh --status <tag>" >&2; return 2; }
      ah_workspace_image_status "$2"
      ;;
    --assert-tag)
      [ $# -eq 3 ] || { echo "usage: workspace-image.sh --assert-tag <tag> <instance>" >&2; return 2; }
      ah_assert_workspace_image_tag "$2" "$3"
      ;;
    *)
      echo "usage: workspace-image.sh [--digest|--image-digest <tag>|--status <tag>|--assert-tag <tag> <instance>]" >&2
      return 2
      ;;
  esac
}

# Only run when executed directly; sourcing just defines the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  ah_workspace_image_main "$@"
fi
