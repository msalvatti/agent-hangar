/**
 * Request builders shared by the route suites.
 *
 * Layer: test double.
 *
 * The same-origin guard reads the `Origin` and `Host` headers, so every state-changing test has to
 * set both. Building them in one place keeps the headers a hostile request carries — a `no-cors`
 * fetch declaring `text/plain` — described once rather than approximated differently in each file.
 */

/** Origin the suites address; the port is arbitrary and never hard-coded in the guard. */
export const TEST_ORIGIN = 'http://127.0.0.1:3000';

/** Host header matching {@link TEST_ORIGIN}. */
const TEST_HOST = '127.0.0.1:3000';

/**
 * Builds a read request, which carries no origin headers at all.
 *
 * @param path - Path below the API root, query included.
 * @returns The request.
 */
export function readRequest(path: string): Request {
  return new Request(`${TEST_ORIGIN}${path}`);
}

/**
 * Builds a state-changing request the same-origin guard accepts.
 *
 * @param path - Path below the API root.
 * @param method - HTTP method.
 * @param body - JSON body, when the route takes one.
 * @returns The request.
 */
export function writeRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`${TEST_ORIGIN}${path}`, {
    method,
    headers: { host: TEST_HOST, origin: TEST_ORIGIN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Builds the request a hostile page would send.
 *
 * `text/plain` is what a `no-cors` fetch may declare without triggering a preflight, and
 * `request.json()` parses the body regardless — which is exactly why the guard exists.
 *
 * The body is required: the point of this request is that it reaches a handler with a payload the
 * guard has to refuse before anything reads it.
 *
 * @param path - Path below the API root.
 * @param method - HTTP method.
 * @param body - JSON body the hostile page would send.
 * @returns The request.
 */
export function foreignRequest(path: string, method: string, body: unknown): Request {
  return new Request(`${TEST_ORIGIN}${path}`, {
    method,
    headers: {
      host: TEST_HOST,
      origin: 'http://evil.example',
      'content-type': 'text/plain',
      'sec-fetch-site': 'cross-site',
    },
    body: JSON.stringify(body),
  });
}
