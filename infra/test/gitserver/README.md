# gitserver (end-to-end test fixture)

A git smart-HTTP server the end-to-end suite clones from and pushes to, so no test ever reaches
GitHub. `server.mjs` is a Node stdlib CGI shim in front of `git http-backend`; `seed.sh` creates
the bare repository `/repos/sample.git` (branches `main` and `feature/docs`) with fixed author and
commit dates, so the seed commits have the same SHAs on every machine.

Build and run: `docker build -t agent-hangar/gitserver:test infra/test/gitserver` then
`docker run --rm -p 3907:8080 agent-hangar/gitserver:test`.

Repository URLs have the shape `http://<host>:<port>/sample.git` — for example
`http://127.0.0.1:3907/sample.git` from the host, or `http://host.docker.internal:3907/sample.git`
from inside a workspace container.

This is a test fixture, not a production server: it runs as root, sets `GIT_HTTP_EXPORT_ALL`, and
accepts anonymous `git push`.
