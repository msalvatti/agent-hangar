/**
 * Same-origin guard for every state-changing route.
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
 * Reads are mostly unaffected, and the reason is confidentiality: the browser already blocks a
 * cross-origin page from reading their responses. That reason covers a read that only costs a
 * local query, and it does not cover a read that spends something the user cannot get back.
 * Same-origin policy stops a hostile page reading an answer; it does not stop it issuing the
 * request. So the forge-backed pickers, which spend the user's upstream rate limit on every call
 * and walk several pages doing it, carry {@link assertNoForeignOrigin} — a weaker guard than the
 * one writes carry, for a reason its own documentation gives.
 *
 * The streaming routes genuinely differ and are left open. `EventSource` always issues its request
 * in CORS mode, so a cross-origin page cannot open one against a server that returns no
 * `Access-Control-Allow-Origin` — the browser refuses it before the handler is reached. That is
 * not true of `fetch(..., { mode: 'no-cors' })`, which is fire-and-forget and is exactly how the
 * pickers would be abused. The streams also read only this instance's own Redis, so there is no
 * external budget to drain.
 *
 * Residual risk this does not cover: DNS rebinding, where the attacker's own hostname resolves to
 * the loopback address, so `Origin` and `Host` agree. Closing that needs a hostname allow-list,
 * which is a deployment decision rather than a request-level one.
 */
import { ForbiddenOriginError } from './errors';

/** `Sec-Fetch-Site` values a state-changing request may carry when it sends no `Origin`. */
export const ALLOWED_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/**
 * Derives the origin the request was actually addressed to.
 *
 * The `Host` header is what the browser puts on the request for the host it connected to, and a
 * page cannot forge it; the scheme comes from the URL the server itself resolved. Building the
 * expected origin from both keeps the check independent of the port, which varies per instance.
 *
 * @param request - The incoming request.
 * @returns The expected origin, or `null` when neither source is usable.
 */
function expectedOrigin(request: Request): string | null {
  const host = request.headers.get('host');
  const url = URL.parse(request.url);
  if (host === null || host.length === 0 || url === null) {
    return null;
  }
  return `${url.protocol}//${host}`;
}

/**
 * Whether the request carries an `Origin` naming somewhere other than this application.
 *
 * @param request - The incoming request.
 * @returns `true` only when an `Origin` is present and does not match.
 */
function hasForeignOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin !== expectedOrigin(request);
}

/**
 * Rejects a read that shows it was issued from another site, while allowing one that shows nothing.
 *
 * Weaker than {@link assertSameOrigin} on purpose, and the difference is the request that carries
 * neither header. A write can insist on proof of same origin because every browser sends `Origin`
 * on a non-`GET` request; a same-origin `GET` is not obliged to send either header, so demanding
 * proof would refuse legitimate reads from any client that omits both. This refuses only positive
 * evidence of another site.
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
 * @throws ForbiddenOriginError 403 when the request names another origin or site.
 */
export function assertNoForeignOrigin(request: Request): void {
  if (hasForeignOrigin(request)) {
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
 * Rules, in order: an `Origin` header must equal the request's own origin; with no `Origin`, the
 * `Sec-Fetch-Site` header must say `same-origin` or `none`. A request carrying neither header is
 * refused, so a non-browser client must send one of them.
 *
 * @param request - The incoming request.
 * @throws ForbiddenOriginError 403 when the request is not proven same-origin.
 */
export function assertSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== null) {
    if (hasForeignOrigin(request)) {
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
