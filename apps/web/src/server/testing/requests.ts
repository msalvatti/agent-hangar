/**
 * Request builders shared by the route suites.
 *
 * Layer: test double.
 *
 * The guards read the `Origin` and `Host` headers, so every request a suite builds has to set
 * both — reads included, since the host guard runs on every route. Building them in one place
 * keeps the headers a hostile request carries described once rather than approximated differently
 * in each file, and there are two hostile shapes: a `no-cors` fetch from another origin, and a
 * request whose `Origin` and `Host` agree on a hostname the attacker rebound to the loopback
 * address.
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
  return new Request(`${TEST_ORIGIN}${path}`, { headers: { host: TEST_HOST } });
}

/**
 * Builds the read a hostile page would issue.
 *
 * A `no-cors` `GET` is fire-and-forget: the page cannot read the answer and does not need to, so
 * these headers are what the browser attaches rather than anything the page chose. No `Origin` is
 * sent, because a `no-cors` `GET` carries none — `Sec-Fetch-Site` is the whole of what labels it,
 * which is precisely what the read guard has to work from.
 *
 * @param path - Path below the API root, query included.
 * @returns The request.
 */
export function foreignReadRequest(path: string): Request {
  return new Request(`${TEST_ORIGIN}${path}`, {
    headers: { host: TEST_HOST, 'sec-fetch-site': 'cross-site' },
  });
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

/**
 * Hostname a DNS-rebinding attacker serves their page from and then points at the loopback address.
 *
 * Deliberately a name and not an address: what makes the attack work is that the browser resolves
 * it to `127.0.0.1` after the page has loaded, so every header the browser writes agrees with
 * every other one and only the name itself gives the attack away.
 */
export const REBOUND_ORIGIN = 'http://rebind.example:3000';

/** `Host` header of a rebound request, matching {@link REBOUND_ORIGIN}. */
const REBOUND_HOST = 'rebind.example:3000';

/**
 * Builds the request a DNS-rebinding attack produces.
 *
 * Nothing here is anomalous to a guard that compares the request against itself: the browser
 * genuinely believes this is a same-origin request, so it sends a matching `Origin`,
 * `Sec-Fetch-Site: same-origin` and a real content type — and it will hand the response body back
 * to the attacking page, which is why reads are as exposed as writes. The only thing that betrays
 * it is the hostname, which is not one this machine answers to.
 *
 * @param path - Path below the API root, query included.
 * @param method - HTTP method; `GET` for the read routes.
 * @param body - JSON body, when the method takes one.
 * @returns The request.
 */
export function reboundRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`${REBOUND_ORIGIN}${path}`, {
    method,
    headers: {
      host: REBOUND_HOST,
      origin: REBOUND_ORIGIN,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
