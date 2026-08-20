# Git smart-HTTP server for the end-to-end suite: `git http-backend` behind a Node HTTP shim,
# serving bare repositories from /repos. Test fixture only — it runs as root, exports every
# repository it holds and accepts unauthenticated pushes. Never deploy it.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY server.mjs seed.sh /srv/
RUN chmod +x /srv/seed.sh

ENV GIT_PROJECT_ROOT=/repos \
    GIT_HTTP_EXPORT_ALL=1 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=2s --timeout=3s --retries=30 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/bin/sh", "-c", "/srv/seed.sh && exec node /srv/server.mjs"]
