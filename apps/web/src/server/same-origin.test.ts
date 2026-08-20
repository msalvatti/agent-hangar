/** @vitest-environment node */
/**
 * Unit tests for the same-origin guard.
 *
 * Layer: unit.
 * Goal: a state-changing request is accepted only when it proves it came from this application,
 * across every combination of `Origin` and `Sec-Fetch-Site` a browser can send.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { ForbiddenOriginError } from './errors';
import { assertSameOrigin } from './same-origin';

/**
 * Builds a state-changing request with the given headers.
 *
 * @param headers - Headers to attach; `host` defaults to the URL's own authority.
 * @param url - Request URL.
 * @returns The request.
 */
function stateChanging(
  headers: Record<string, string>,
  url = 'http://127.0.0.1:3280/api/settings/GITHUB_PAT',
): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { host: new URL(url).host, ...headers },
  });
}

describe('assertSameOrigin', () => {
  /**
   * The ordinary browser case: a same-origin `fetch` sends an `Origin` equal to the page's own,
   * which matches the authority the request was addressed to.
   */
  it('accepts a matching Origin', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ origin: 'http://127.0.0.1:3280' }));
    }).not.toThrow();
  });

  /**
   * The port is not hard-coded: every checkout runs on its own instance port, and a guard that
   * pinned 3000 would reject every other instance.
   */
  it('accepts a matching Origin on any port', () => {
    const url = 'http://127.0.0.1:4100/api/chats';
    expect(() => {
      assertSameOrigin(stateChanging({ origin: 'http://127.0.0.1:4100' }, url));
    }).not.toThrow();
  });

  /**
   * The attack this guard exists for: a page on another origin issues a `no-cors` write. The
   * browser attaches its own `Origin`, which does not match, so the write never reaches the body.
   */
  it('rejects a foreign Origin', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ origin: 'http://evil.example' }));
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * A scheme mismatch is a different origin: `https://host` and `http://host` are not the same
   * site, and accepting either would let a page on one drive the other.
   */
  it('rejects an Origin that differs only in scheme', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ origin: 'https://127.0.0.1:3280' }));
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * `Origin: null` is what a sandboxed iframe, a `data:` document or some redirects send. It
   * belongs to no origin, so it can never equal this one.
   */
  it('rejects the null Origin', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ origin: 'null' }));
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * Without a `Host` header there is nothing to compare against, so the request cannot be proven
   * same-origin and is refused rather than waved through.
   */
  it('rejects a request with an Origin but no Host', () => {
    const request = new Request('http://127.0.0.1:3280/api/chats', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3280' },
    });
    request.headers.delete('host');
    expect(() => {
      assertSameOrigin(request);
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * Same-site navigations and form posts may omit `Origin`; the fetch-metadata header then says
   * where the request came from, and `same-origin` is the only value that proves it.
   */
  it('accepts Sec-Fetch-Site: same-origin when Origin is absent', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ 'sec-fetch-site': 'same-origin' }));
    }).not.toThrow();
  });

  /**
   * `none` means the user started the request themselves — typing a URL or using a bookmark — so
   * no other page drove it.
   */
  it('accepts Sec-Fetch-Site: none', () => {
    expect(() => {
      assertSameOrigin(stateChanging({ 'sec-fetch-site': 'none' }));
    }).not.toThrow();
  });

  /**
   * `cross-site` and `same-site` both mean another document issued the request; neither proves it
   * came from this application.
   */
  it('rejects any other Sec-Fetch-Site', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(() => {
        assertSameOrigin(stateChanging({ 'sec-fetch-site': site }));
      }).toThrow(ForbiddenOriginError);
    }
  });

  /**
   * A request carrying neither header proves nothing, so it is refused. A non-browser client has
   * to say which origin it is acting for, which is a one-header cost for a closed door.
   */
  it('rejects a request carrying neither header', () => {
    expect(() => {
      assertSameOrigin(stateChanging({}));
    }).toThrow(ForbiddenOriginError);
  });
});
