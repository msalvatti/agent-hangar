# Workspace image: the disposable container an agent runs in (one per chat / per scheduled run).
# Base only: toolchain, non-root user, git helper. No secrets, no .env, no application source;
# credentials arrive as container environment at `create` time and git reads the token through
# GIT_ASKPASS. The agent runtime bundle is copied in by a later build step (see placeholder).
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
    && chown agent:agent /workspace \
    && chown -R agent:agent /opt/agent-runtime

COPY --chmod=755 askpass.sh /opt/agent-runtime/askpass.sh

USER agent
RUN git config --global credential.helper "" \
    && git config --global user.name "Agent Hangar" \
    && git config --global user.email "agent@localhost" \
    && git config --global --add safe.directory /workspace \
    && git config --global init.defaultBranch main

# --- AGENT RUNTIME BUNDLE (added by W1-D) ---

WORKDIR /workspace
# CMD (not ENTRYPOINT) so the worker can exec into an idling container while `docker run <image> node --version` still works.
CMD ["sleep", "infinity"]
