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
 * Reads are unaffected. `GET`/`HEAD` and the SSE routes stay open because the browser already
 * blocks a cross-origin page from reading their responses, and `EventSource` is same-origin by
 * construction.
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
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin !== expectedOrigin(request)) {
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
