/** @vitest-environment node */
/**
 * Unit tests for the origin and host guards.
 *
 * Layer: unit.
 * Goal: no request addressed to a host this machine does not answer to is served at all; a
 * state-changing request is accepted only when it proves it came from this application; and a
 * forge-backed read is refused only when it proves it did not — across every combination of
 * `Host`, `Origin` and `Sec-Fetch-Site` a browser can send.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { ForbiddenOriginError } from './errors';
import { assertKnownHost, assertNoForeignOrigin, assertSameOrigin } from './same-origin';

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

describe('assertKnownHost', () => {
  /**
   * Builds a request addressed to a given authority.
   *
   * The URL and the `Host` header are set from the same value, which is what a browser does and
   * what a rebinding attack produces: the two never disagree, so the header is the only thing that
   * can say where the client thought it was connecting.
   *
   * @param authority - Value of the `Host` header, also used to build the request URL.
   * @returns The request.
   */
  function addressedTo(authority: string): Request {
    return new Request(`http://${authority}/api/chats`, { headers: { host: authority } });
  }

  /**
   * The everyday case, on every instance: each checkout runs on its own port, so the port is not
   * part of the allow-list and `localhost` is accepted alongside the literal the scripts print.
   */
  it('accepts the loopback names on any port', () => {
    for (const authority of [
      '127.0.0.1:3000',
      '127.0.0.1:4100',
      'localhost:3000',
      '[::1]:3000',
      '127.0.0.53:3000',
    ]) {
      expect(() => {
        assertKnownHost(addressedTo(authority));
      }, authority).not.toThrow();
    }
  });

  /**
   * The comparison is against the canonical spelling rather than the literal bytes, so a header a
   * client wrote in another case still names the same machine.
   */
  it('accepts a loopback name in any case', () => {
    expect(() => {
      assertKnownHost(addressedTo('LOCALHOST:3000'));
    }).not.toThrow();
  });

  /**
   * The attack this guard exists for. In a DNS-rebinding attack the attacker's own hostname is
   * made to resolve to the loopback address, so the browser believes the request is same-origin
   * and every header agrees with every other one: `Origin` equals the origin built from `Host`,
   * and `Sec-Fetch-Site` says `same-origin`. Nothing about the request is anomalous except the
   * name, which is why the name is what has to be checked.
   */
  it('rejects a rebound hostname whose Origin agrees with its Host', () => {
    const request = new Request('http://rebind.example:3000/api/chats', {
      method: 'POST',
      headers: {
        host: 'rebind.example:3000',
        origin: 'http://rebind.example:3000',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(() => {
      assertKnownHost(request);
    }).toThrow(ForbiddenOriginError);
    expect(() => {
      assertSameOrigin(request);
    }).toThrow(ForbiddenOriginError);
    expect(() => {
      assertNoForeignOrigin(request);
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * An address on the local network is not the local machine. The listener is bound to
   * `127.0.0.1`, so a request that arrives naming one has been told the wrong thing about where it
   * points.
   */
  it('rejects an address that is not this machine', () => {
    for (const authority of ['192.168.1.10:3000', '0.0.0.0:3000', 'example.com']) {
      expect(() => {
        assertKnownHost(addressedTo(authority));
      }, authority).toThrow(ForbiddenOriginError);
    }
  });

  /**
   * Spellings that look local and are not: a trailing dot and a `.localhost` subdomain both fail
   * to match, and the failure direction of an unrecognised spelling has to be refusal.
   */
  it('rejects a name that only resembles a loopback name', () => {
    for (const authority of ['localhost.:3000', 'evil.localhost:3000']) {
      expect(() => {
        assertKnownHost(addressedTo(authority));
      }, authority).toThrow(ForbiddenOriginError);
    }
  });

  /**
   * A `Host` header is a host and an optional port. One smuggling a userinfo section or a path
   * would otherwise parse as an authority it does not look like, so it is refused before it is
   * parsed at all.
   */
  it('rejects a Host header that is not just a host and a port', () => {
    for (const authority of ['127.0.0.1@evil.example', 'evil.example/@127.0.0.1', '127.0.0.1 x']) {
      const request = new Request('http://127.0.0.1:3000/api/chats', {
        headers: { host: authority },
      });
      expect(() => {
        assertKnownHost(request);
      }, authority).toThrow(ForbiddenOriginError);
    }
  });

  /**
   * A `Host` made only of characters an authority may contain, but which is still not an
   * authority, has no hostname to compare — so there is nothing to accept.
   */
  it('rejects a Host header that no URL can be built from', () => {
    const request = new Request('http://127.0.0.1:3000/api/chats', {
      headers: { host: '[:::]' },
    });
    expect(() => {
      assertKnownHost(request);
    }).toThrow(ForbiddenOriginError);
  });

  /**
   * Without a `Host` header there is nothing to check, and every HTTP client sends one, so its
   * absence is refused rather than waved through.
   */
  it('rejects a request with no Host header', () => {
    const request = new Request('http://127.0.0.1:3000/api/chats');
    request.headers.delete('host');
    expect(() => {
      assertKnownHost(request);
    }).toThrow(ForbiddenOriginError);
  });
});

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

describe('assertNoForeignOrigin', () => {
  /**
   * Builds a read with the given headers.
   *
   * @param headers - Headers to attach; `host` defaults to the URL's own authority.
   * @returns The request.
   */
  function read(headers: Record<string, string>): Request {
    const url = 'http://127.0.0.1:3280/api/repos';
    return new Request(url, { headers: { host: new URL(url).host, ...headers } });
  }

  /**
   * The difference from the write guard, and the reason this one exists: a same-origin `GET` is
   * not obliged to send either header. Refusing the request that proves nothing would refuse the
   * application's own picker, so absence of evidence is not evidence of another site.
   */
  it('accepts a read that carries neither header', () => {
    expect(() => {
      assertNoForeignOrigin(read({}));
    }).not.toThrow();
  });

  /**
   * A read the browser labels as its own is accepted on either signal, so the picker works whether
   * the browser sends an `Origin`, a `Sec-Fetch-Site`, or both.
   */
  it('accepts a read labelled as this origin or this site', () => {
    for (const headers of [
      { origin: 'http://127.0.0.1:3280' },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'none' },
      { origin: 'http://127.0.0.1:3280', 'sec-fetch-site': 'same-origin' },
    ]) {
      expect(() => {
        assertNoForeignOrigin(read(headers));
      }).not.toThrow();
    }
  });

  /**
   * The attack this closes: a page the user visits issuing a `no-cors` read to spend their forge
   * rate limit. It cannot read the answer and never could — the spend was the point — and the
   * browser labels the request either way, which is what makes it refusable.
   */
  it('rejects a read labelled as coming from another site', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(() => {
        assertNoForeignOrigin(read({ 'sec-fetch-site': site }));
      }).toThrow(ForbiddenOriginError);
    }
  });

  /**
   * An `Origin` naming somewhere else is refused on its own, without needing `Sec-Fetch-Site`.
   */
  it('rejects a read naming another origin', () => {
    expect(() => {
      assertNoForeignOrigin(read({ origin: 'http://evil.example' }));
    }).toThrow(ForbiddenOriginError);
  });
});
