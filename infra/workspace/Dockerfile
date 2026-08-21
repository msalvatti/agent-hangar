# Workspace image: the disposable container an agent runs in (one per chat / per scheduled run).
# Base only: toolchain, non-root user, git helper. No secrets, no .env, no application source;
# credentials arrive as container environment at `create` time and git reads the token through
# GIT_ASKPASS. The agent runtime bundle is copied in below, root-owned like askpass.sh.
FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="agent-hangar-workspace"
LABEL ah.image="workspace"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/opt/agent-runtime/askpass.sh

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates ripgrep jq python3 build-essential curl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && useradd -m -u 1001 -s /bin/bash agent \
    && mkdir -p /workspace /opt/agent-runtime \
    && chown agent:agent /workspace

# /opt/agent-runtime stays root-owned and world-readable: `agent` must execute what is in it but
# must never be able to replace it. GIT_ASKPASS points here, so a writable directory would let
# repository-controlled commands unlink askpass.sh (directory write permission governs unlink and
# create, regardless of the file's own owner) and substitute a helper that exfiltrates the PAT the
# next time git asks for credentials. Mutable per-exec state lives on the tmpfs /tmp instead.
COPY --chmod=755 askpass.sh /opt/agent-runtime/askpass.sh

USER agent
RUN git config --global credential.helper "" \
    && git config --global user.name "Agent Hangar" \
    && git config --global user.email "agent@localhost" \
    && git config --global --add safe.directory /workspace \
    && git config --global init.defaultBranch main

# The runtime bundle joins askpass.sh under the same rule: root-owned, readable and executable by
# `agent`, writable by nobody. `--chown=agent:agent` would be self-defeating here — the directory
# being root-owned stops the bundle being unlinked, but an agent-owned FILE can still be rewritten
# in place, and this bundle is what reads the token file and confines every tool path. An
# agent-owned file would let a compromised tool bypass both protections by editing it directly.
#
# The bundle is ESM in a file named `cli.js`. Node runs it via automatic module detection —
# re-parsing the file after it fails as CommonJS — which `--no-experimental-detect-module` turns
# off. The manifest beside it declares the module type outright, so starting the runtime does not
# depend on that heuristic being enabled.
COPY --chmod=755 runtime/cli.js /opt/agent-runtime/cli.js
COPY --chmod=644 runtime/cli.js.map /opt/agent-runtime/cli.js.map
COPY --chmod=644 runtime/package.json /opt/agent-runtime/package.json

# Digest of the tree this image was built from: the bundle's own bytes plus the two files of this
# build context that are not generated. `infra/scripts/workspace-image.sh` computes it, and every
# command that is about to use the image recomputes it from its own tree and compares — which is
# how an image that silently lags its checkout is caught, rather than being discovered later
# through an error that names the code instead of the image.
#
# Declared with no default, so an image built by anything that does not pass it carries an empty
# label and reads as stale. This is the last instruction that changes, so a digest-only change
# rebuilds one layer.
ARG AH_WORKSPACE_DIGEST
LABEL ah.workspace.digest="$AH_WORKSPACE_DIGEST"

WORKDIR /workspace
# CMD (not ENTRYPOINT) so the worker can exec into an idling container while `docker run <image> node --version` still works.
CMD ["sleep", "infinity"]
