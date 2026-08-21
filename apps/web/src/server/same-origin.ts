/**
 * Origin and host guards for the API.
 *
 * Layer: service (server).
 *
 * This API has no session cookie and no login, so its effective authorisation is "whoever can
 * reach the port" — and a page open in the developer's browser can reach it. A cross-origin
 * `fetch(..., { mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } })` triggers no
 * preflight, and `request.json()` parses the body whatever content type it declares, so the write
 * lands even though the attacker cannot read the opaque response: overwrite the stored PAT, start
 * turns, delete chats.
 *
 * Three guards, in increasing strength, and every route carries at least the first.
 *
 * {@link assertKnownHost} answers a question the other two cannot: *which server does the client
 * believe it is talking to?* Comparing `Origin` against `Host` proves they agree; it does not
 * prove they name this application. In a DNS-rebinding attack the attacker's own hostname is made
 * to resolve to the loopback address, so the browser treats `http://attacker.example:3000` as one
 * origin and every check that compares the request against itself passes — including the read
 * side, because the browser now considers the response same-origin and lets the page read it.
 * What closes that is a host allow-list, and this application has one it does not have to be told:
 * `next dev` and `next start` are both launched with `-H 127.0.0.1`, so the only hostnames that
 * can legitimately address the listener are the ones that mean "this machine". `isLoopbackHostname`
 * is core's single definition of that set, already the rule deciding whether a credential may
 * travel in plaintext, and it is closed rather than heuristic — an unrecognised spelling is
 * refused, never admitted.
 *
 * Reads are otherwise unaffected, and the reason is confidentiality: once the host is known to be
 * this machine, the browser already blocks a cross-origin page from reading a response. That
 * reason covers a read that only costs a local query, and it does not cover a read that spends
 * something the user cannot get back. Same-origin policy stops a hostile page reading an answer;
 * it does not stop it issuing the request. So the forge-backed pickers, which spend the user's
 * upstream rate limit on every call and walk several pages doing it, carry
 * {@link assertNoForeignOrigin} — a weaker guard than the one writes carry, for a reason its own
 * documentation gives.
 *
 * Writes carry {@link assertSameOrigin}, which additionally demands positive proof that this
 * application issued them.
 *
 * The streaming routes take the host guard and nothing more. `EventSource` always issues its
 * request in CORS mode, so a cross-origin page cannot open one against a server that returns no
 * `Access-Control-Allow-Origin` — the browser refuses it before the handler is reached. That is
 * not true of `fetch(..., { mode: 'no-cors' })`, which is fire-and-forget and is exactly how the
 * pickers would be abused. The streams also read only this instance's own Redis, so there is no
 * external budget to drain.
 */
import { isLoopbackHostname } from '@agent-hangar/core';

import { ForbiddenOriginError } from './errors';

/** `Sec-Fetch-Site` values a state-changing request may carry when it sends no `Origin`. */
export const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/**
 * Characters a `Host` header may contain: a host, an optional port, and nothing else.
 *
 * Applied before the value is parsed, so a header smuggling a userinfo section or a path — the
 * shapes that make `http://<host>` parse as something other than the authority it looks like — is
 * refused outright instead of being canonicalised into whatever `URL` makes of it.
 *
 * Both cases are spelled out rather than folded with the `i` flag, so the class reads as exactly
 * the set it admits: ASCII letters, digits, and the punctuation an authority is allowed to carry.
 */
const HOST_HEADER = /^[A-Za-z0-9._~\-[\]:]+$/u;

/** The authority a request was addressed to, canonicalised. */
interface AddressedHost {
  /** Origin the request was addressed to, in the serialisation an `Origin` header uses. */
  origin: string;
  /** Its hostname, canonicalised by `URL` (`LOCALHOST` lower-cased, `127.1` expanded). */
  hostname: string;
}

/**
 * Derives the authority the request was actually addressed to.
 *
 * The `Host` header is what the browser puts on the request for the host it connected to, and a
 * page cannot forge it; the scheme comes from the URL the server itself resolved. Both are run
 * through `URL` so the comparison is against the canonical spelling rather than the literal bytes.
 *
 * @param request - The incoming request.
 * @returns The addressed authority, or `null` when the header is missing or unusable.
 */
function addressedHost(request: Request): AddressedHost | null {
  const host = request.headers.get('host');
  if (host === null || !HOST_HEADER.test(host)) {
    return null;
  }
  const addressed = URL.parse(`${new URL(request.url).protocol}//${host}`);
  return addressed === null ? null : { origin: addressed.origin, hostname: addressed.hostname };
}

/**
 * Resolves the origin the request was addressed to, refusing an unknown host.
 *
 * Every guard below starts here, which is what lets the rest of them compare against a single
 * value that is already known to name this machine.
 *
 * @param request - The incoming request.
 * @returns The canonical origin the request was addressed to.
 * @throws ForbiddenOriginError 403 when the `Host` header is missing, malformed, or names anything
 *   other than the local machine.
 */
function requireAddressedOrigin(request: Request): string {
  const addressed = addressedHost(request);
  if (addressed === null || !isLoopbackHostname(addressed.hostname)) {
    throw new ForbiddenOriginError('Request was addressed to a host this instance does not serve');
  }
  return addressed.origin;
}

/**
 * Rejects a request addressed to a host this instance does not answer to.
 *
 * Call it first in every handler, read and write alike. It is the check that survives DNS
 * rebinding, where `Origin` and `Host` agree because both name the attacker's hostname, and it is
 * the only one of the three that protects a plain read: under rebinding the browser hands the
 * response back to the attacking page.
 *
 * The allow-list is not configuration. It is the set of hostnames that mean "the machine this
 * process runs on", and the launch scripts bind the listener to `127.0.0.1` alone, so nothing
 * outside that set can reach the socket except by being lied to about where it points. A list an
 * operator maintained by hand would go stale the first time an instance moved; this one has
 * nothing to move. The port is deliberately not part of it: instances differ by port, and the
 * `Origin` comparison below already pins the one a browser addressed.
 *
 * @param request - The incoming request.
 * @throws ForbiddenOriginError 403 when the `Host` header is missing, malformed, or names anything
 *   other than the local machine.
 */
export function assertKnownHost(request: Request): void {
  requireAddressedOrigin(request);
}

/**
 * Rejects a read that shows it was issued from another site, while allowing one that shows nothing.
 *
 * Weaker than {@link assertSameOrigin} on purpose, and the difference is the request that carries
 * neither header. A write can insist on proof of same origin because every browser sends `Origin`
 * on a non-`GET` request; a same-origin `GET` is not obliged to send either header, so demanding
 * proof would refuse legitimate reads from any client that omits both. This refuses only positive
 * evidence of another site — on top of {@link assertKnownHost}, which it runs first.
 *
 * What that closes: a page the user visits firing `fetch(..., { mode: 'no-cors' })` at a
 * forge-backed route to spend their upstream rate limit. It cannot read the answer, and it never
 * could; what it was buying was the spend, and every browser that labels such a request — with an
 * `Origin` or with `Sec-Fetch-Site` — is now refused before the token is used.
 *
 * What it does not close: a client that sends neither header still reaches the route, so a
 * non-browser caller, or a browser that labels nothing, can still spend the budget. Refusing those
 * would mean refusing the application's own reads. A server-side rate limit is what would cover
 * them, and that is a bound this route does not have.
 *
 * @param request - The incoming request.
 * @throws ForbiddenOriginError 403 when the host is unknown, or the request names another origin
 *   or site.
 */
export function assertNoForeignOrigin(request: Request): void {
  const addressed = requireAddressedOrigin(request);
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== addressed) {
    throw new ForbiddenOriginError('Request origin is not allowed');
  }
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && !ALLOWED_FETCH_SITES.has(site)) {
    throw new ForbiddenOriginError('Request must not be issued from another site');
  }
}

/**
 * Rejects a state-changing request that cannot be shown to come from this application.
 *
 * Call it first in every `POST`, `PUT`, `PATCH` and `DELETE` handler, before the body is read.
 *
 * Rules, in order: the `Host` header must name this machine ({@link assertKnownHost}); an `Origin`
 * header must equal the request's own origin; with no `Origin`, the `Sec-Fetch-Site` header must
 * say `same-origin` or `none`. A request carrying neither header is refused, so a non-browser
 * client must send one of them.
 *
 * @param request - The incoming request.
 * @throws ForbiddenOriginError 403 when the request is not proven same-origin.
 */
export function assertSameOrigin(request: Request): void {
  const addressed = requireAddressedOrigin(request);
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin !== addressed) {
      throw new ForbiddenOriginError('Request origin is not allowed');
    }
    return;
  }
  const site = request.headers.get('sec-fetch-site');
  if (site === null || !ALLOWED_FETCH_SITES.has(site)) {
    throw new ForbiddenOriginError(
      'Request must carry an Origin header or Sec-Fetch-Site: same-origin',
    );
  }
}
