/**
 * CGI shim in front of `git http-backend`, exposing the bare repositories of /repos over git
 * smart HTTP.
 *
 * Layer: test fixture (container entry point).
 *
 * The workspace runtime clones `http(s)://` URLs and supplies credentials through `GIT_ASKPASS`,
 * exactly as it does for GitHub, so the end-to-end suite needs a smart-HTTP endpoint rather than
 * a `git daemon`: that way no scheme exception is needed anywhere in the product.
 *
 * Responses are buffered whole before they are written. The seed repository is a few kilobytes,
 * and buffering keeps the CGI header parsing in one place instead of spreading it across a
 * streaming state machine.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

/** Port the shim listens on inside the container. */
const PORT = Number(process.env.PORT ?? '8080');

/** Root holding the bare repositories, as `git http-backend` expects it. */
const PROJECT_ROOT = process.env.GIT_PROJECT_ROOT ?? '/repos';

/** `/<name>.git/<rest>`; anything else is not a git request. */
const REPO_REQUEST = /^\/([A-Za-z0-9._-]+\.git)(\/.*)$/u;

/** Status returned when the CGI child names none. */
const DEFAULT_STATUS = 200;

/** Status for a path that is not a git request. */
const NOT_FOUND = 404;

/** Status for a child that failed or produced no parseable CGI response. */
const SERVER_ERROR = 500;

/**
 * Splits a buffered CGI response into its header block and its body.
 *
 * @param buffer - Everything the child wrote to stdout.
 * @returns The header text and the body bytes, or `null` when no header terminator was found.
 */
function splitCgiResponse(buffer) {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { head: buffer.subarray(0, crlf).toString('utf8'), body: buffer.subarray(crlf + 4) };
  }
  if (lf !== -1) {
    return { head: buffer.subarray(0, lf).toString('utf8'), body: buffer.subarray(lf + 2) };
  }
  return null;
}

/**
 * Turns a CGI header block into a status code and response headers.
 *
 * @param head - The header text of the CGI response.
 * @returns The status and the headers to write.
 */
function parseCgiHeaders(head) {
  let status = DEFAULT_STATUS;
  const headers = {};
  for (const line of head.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name.toLowerCase() === 'status') {
      status = Number.parseInt(value, 10) || DEFAULT_STATUS;
      continue;
    }
    headers[name] = value;
  }
  return { status, headers };
}

/**
 * Builds the CGI environment for one request.
 *
 * `REMOTE_USER` is set so `git http-backend` treats the request as authenticated and allows
 * `receive-pack`; the repository also carries `http.receivepack=true` from the seed script.
 *
 * @param request - The incoming HTTP request.
 * @param pathInfo - `/<name>.git/<rest>` for the child.
 * @param query - The query string without its leading `?`.
 * @returns The environment passed to the child.
 */
function cgiEnv(request, pathInfo, query) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_PROJECT_ROOT: PROJECT_ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    GATEWAY_INTERFACE: 'CGI/1.1',
    SERVER_PROTOCOL: 'HTTP/1.1',
    REMOTE_ADDR: '127.0.0.1',
    REMOTE_USER: 'e2e',
    REQUEST_METHOD: request.method ?? 'GET',
    PATH_INFO: pathInfo,
    QUERY_STRING: query,
  };
  if (request.headers['content-type'] !== undefined) {
    env.CONTENT_TYPE = request.headers['content-type'];
  }
  if (request.headers['content-length'] !== undefined) {
    env.CONTENT_LENGTH = request.headers['content-length'];
  }
  if (request.headers['content-encoding'] !== undefined) {
    env.HTTP_CONTENT_ENCODING = request.headers['content-encoding'];
  }
  return env;
}

/**
 * Runs `git http-backend` for one request and writes its response.
 *
 * @param request - The incoming HTTP request.
 * @param response - The response to write.
 * @param pathInfo - `/<name>.git/<rest>`.
 * @param query - The query string without its leading `?`.
 * @returns A promise resolving to the status written.
 */
function serveGit(request, response, pathInfo, query) {
  return new Promise((resolve) => {
    const child = spawn('git', ['http-backend'], {
      env: cgiEnv(request, pathInfo, query),
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => {
      response.writeHead(SERVER_ERROR, { 'content-type': 'text/plain' });
      response.end('git http-backend failed\n');
      resolve(SERVER_ERROR);
    });
    child.on('close', () => {
      const parsed = splitCgiResponse(Buffer.concat(chunks));
      if (parsed === null) {
        response.writeHead(SERVER_ERROR, { 'content-type': 'text/plain' });
        response.end('git http-backend produced no CGI response\n');
        resolve(SERVER_ERROR);
        return;
      }
      const { status, headers } = parseCgiHeaders(parsed.head);
      response.writeHead(status, headers);
      response.end(parsed.body);
      resolve(status);
    });
    request.pipe(child.stdin);
  });
}

const server = createServer((request, response) => {
  const startedAt = Date.now();
  const target = request.url ?? '/';
  const [rawPath = '/', query = ''] = target.split('?', 2);
  const log = (status) => {
    process.stdout.write(
      `${request.method ?? 'GET'} ${rawPath} ${String(status)} ${String(Date.now() - startedAt)}ms\n`,
    );
  };

  if (rawPath === '/healthz') {
    response.writeHead(DEFAULT_STATUS, { 'content-type': 'text/plain' });
    response.end('ok');
    log(DEFAULT_STATUS);
    return;
  }

  const match = REPO_REQUEST.exec(rawPath);
  if (match === null) {
    response.writeHead(NOT_FOUND, { 'content-type': 'text/plain' });
    response.end('not found\n');
    log(NOT_FOUND);
    return;
  }

  serveGit(request, response, `/${match[1]}${match[2]}`, query).then(log, () => log(SERVER_ERROR));
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`gitserver listening on 0.0.0.0:${String(PORT)} (root ${PROJECT_ROOT})\n`);
});
