/**
 * Unit tests for the redactor.
 *
 * Layer: unit.
 * Goal: registered credentials disappear in every spelling they can take, anything shaped like a
 * credential disappears even when it was never registered, ordinary text survives byte for byte,
 * and redacting twice changes nothing.
 * Mocks: none; synthetic token-shaped values are assembled at runtime so no credential-shaped
 * literal is ever written to this file.
 */
import { describe, expect, it } from 'vitest';

import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../secrets/types.ts';
import {
  assertNoCanary,
  CANARY_MARKER,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '../testing/canaries.ts';

import { CIRCULAR_TOKEN, createRedactor, escapeRegExp } from './redactor.ts';

/** A classic PAT shape that was never registered anywhere. */
const CLASSIC_PAT = `ghp_${'A'.repeat(36)}`;

/** A fine-grained PAT shape. */
const FINE_GRAINED_PAT = `github_pat_${'B'.repeat(30)}`;

/** An OpenAI key shape. */
const API_KEY = `sk-${'c'.repeat(30)}`;

/** A project-scoped OpenAI key shape. */
const PROJECT_API_KEY = `sk-proj-${'d'.repeat(30)}`;

/** An authorization header carrying an opaque token. */
const BEARER_HEADER = `Authorization: Bearer ${'e'.repeat(40)}`;

/**
 * A database password. It carries the canary marker so it is unmistakably fake, and it is shaped
 * like nothing the contract patterns match — which is the point: only the connection-string rule
 * can catch it.
 */
const DB_PASSWORD = `db-${CANARY_MARKER}-pw`;

describe('createRedactor registered values', () => {
  /**
   * The credential the worker just revealed is the one value the redactor knows exactly; it has to
   * vanish from prose, from a JSON document and from a clone URL alike, because all three reach
   * logs and rows.
   */
  it.each([
    ['prose', (value: string) => `the token is ${value} and that is that`],
    ['a JSON document', (value: string) => JSON.stringify({ token: value })],
    ['a clone URL', (value: string) => `https://x-access-token:${value}@github.com/o/r.git`],
  ])('removes a registered value from %s', (_label, wrap) => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY]);

    const output = redactor.redact(wrap(GITHUB_CANARY));

    assertNoCanary(output);
    expect(output).toContain(REDACTED_TOKEN);
  });

  /**
   * A credential pasted into a URL query arrives percent-encoded, so the encoded spelling has to be
   * registered alongside the raw one or it would sail through untouched.
   */
  it('removes the percent-encoded spelling of a registered value', () => {
    const redactor = createRedactor();
    const value = 'abc/def+ghi=jkl';
    redactor.register([value]);

    const output = redactor.redact(`raw=${value} encoded=${encodeURIComponent(value)}`);

    expect(output).toBe(`raw=${REDACTED_TOKEN} encoded=${REDACTED_TOKEN}`);
  });

  /**
   * Inside a JSON string a quote or a backslash is escaped, which changes the bytes on the wire;
   * that spelling is registered too so serialised payloads are covered.
   */
  it('removes the JSON-escaped spelling of a registered value', () => {
    const redactor = createRedactor();
    const value = 'quote"and\\slash';
    redactor.register([value]);

    const output = redactor.redact(JSON.stringify({ token: value }));

    expect(output).not.toContain('quote');
    expect(output).toContain(REDACTED_TOKEN);
  });

  /**
   * When one registered value is a prefix of another, replacing the short one first would leave the
   * tail of the long one in the output; longest-first ordering prevents that.
   */
  it('replaces the longest registered value first', () => {
    const redactor = createRedactor();
    redactor.register(['abcd', 'abcdefgh']);

    expect(redactor.redact('abcdefgh')).toBe(REDACTED_TOKEN);
  });

  /**
   * A very short value would match ordinary prose everywhere and turn logs into noise, so it is
   * ignored rather than rejected — the caller registers whatever it revealed without checking.
   */
  it('ignores values shorter than the minimum length', () => {
    const redactor = createRedactor();
    redactor.register(['ab', '']);

    expect(redactor.redact('ab is fine')).toBe('ab is fine');
  });

  /**
   * Registering the replacement token itself would make redaction non-idempotent, so the token and
   * any fragment of it are refused.
   */
  it('ignores the replacement token and its fragments', () => {
    const redactor = createRedactor();
    redactor.register([REDACTED_TOKEN, 'REDACT']);

    expect(redactor.redact(`already ${REDACTED_TOKEN} here`)).toBe(
      `already ${REDACTED_TOKEN} here`,
    );
  });

  /**
   * Shutting a worker down forgets the credentials it held, but the shape patterns are a property
   * of the redactor itself and must keep working afterwards.
   */
  it('forgets registered values on clear while shape patterns stay active', () => {
    const redactor = createRedactor();
    redactor.register(['not-a-credential-shape']);
    redactor.clear();

    expect(redactor.redact('not-a-credential-shape')).toBe('not-a-credential-shape');
    expect(redactor.redact(CLASSIC_PAT)).toBe(REDACTED_TOKEN);
  });
});

describe('createRedactor shape patterns', () => {
  /**
   * Each contract pattern covers one credential family the agent can print without the host ever
   * having registered it — from its own environment, from a git remote, from an error page.
   */
  it.each([
    ['a classic PAT', CLASSIC_PAT],
    ['a fine-grained PAT', FINE_GRAINED_PAT],
    ['an API key', API_KEY],
    ['a project API key', PROJECT_API_KEY],
    ['an authorization header', BEARER_HEADER],
  ])('removes %s that was never registered', (_label, secret) => {
    const output = createRedactor().redact(`before ${secret} after`);

    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED_TOKEN);
  });

  /**
   * A log line can carry the same credential many times; a pattern that stopped after the first
   * match would leak every later one.
   */
  it('removes every occurrence in one string', () => {
    const output = createRedactor().redact(`${CLASSIC_PAT} then ${CLASSIC_PAT}`);

    expect(output).toBe(`${REDACTED_TOKEN} then ${REDACTED_TOKEN}`);
  });

  /**
   * The project-scoped prefix is longer than the plain one, so its pattern has to win; otherwise
   * the shorter rule would swallow the prefix and leave a stub behind.
   */
  it('removes a project API key without leaving a fragment', () => {
    expect(createRedactor().redact(PROJECT_API_KEY)).toBe(REDACTED_TOKEN);
  });

  /**
   * Over-redaction is its own failure: a commit sha, the bare word Bearer, a short string with a
   * key-like prefix and ordinary prose must all come back untouched, or transcripts become
   * unreadable.
   */
  it.each([
    ['a commit sha', 'deadbeef'.repeat(5)],
    ['the bare word', 'Bearer'],
    ['a short key-like value', 'sk-short'],
    ['ordinary prose', 'The deploy finished in 12s with 0 errors.'],
  ])('leaves %s untouched', (_label, text) => {
    expect(createRedactor().redact(text)).toBe(text);
  });

  /**
   * Callers may narrow or extend the pattern set; a caller-supplied pattern that already carries
   * the global flag must be honoured rather than recompiled into something different.
   */
  it('accepts caller-supplied patterns and replacement', () => {
    const pattern = /token\(\d+\)/gi;
    const redactor = createRedactor({ patterns: [pattern], replacement: '***' });

    expect(redactor.redact('TOKEN(1) and token(22)')).toBe('*** and ***');
    expect(redactor.redact(CLASSIC_PAT)).toBe(CLASSIC_PAT);
    // The caller still owns the pattern object, so no cursor may be left on it afterwards.
    expect(pattern.lastIndex).toBe(0);
  });

  /**
   * A sticky pattern matches only at its cursor, so probing it once from position 0 answers the
   * wrong question: it reports "no match" for a credential further along, and the redactor used to
   * return the input untouched — a silent failure to redact, which is the one outcome this module
   * exists to prevent.
   */
  it('redacts a sticky pattern whose match is not at the start', () => {
    const pattern = /token\(\d+\)/y;
    const redactor = createRedactor({ patterns: [pattern] });

    expect(redactor.redact('prefix token(1) tail')).toBe(`prefix ${REDACTED_TOKEN} tail`);
    expect(pattern.lastIndex).toBe(0);
  });

  /**
   * Every occurrence goes, not only the first one found by the walk.
   */
  it('redacts every match of a sticky pattern', () => {
    const redactor = createRedactor({ patterns: [/token\(\d+\)/y] });

    expect(redactor.redact('a token(1) b token(22) c')).toBe(
      `a ${REDACTED_TOKEN} b ${REDACTED_TOKEN} c`,
    );
  });

  /**
   * A sticky pattern that matches nowhere must exhaust the walk and leave the text byte for byte,
   * rather than reporting a match at the position the scan happened to stop on.
   */
  it('leaves text alone when a sticky pattern matches nowhere', () => {
    const redactor = createRedactor({ patterns: [/token\(\d+\)/y] });

    expect(redactor.redact('nothing to see here')).toBe('nothing to see here');
  });

  /**
   * A pattern that can match the empty string would never advance the cursor; the scan stops
   * instead of looping forever, which keeps a bad pattern from hanging the logger.
   */
  it('stops on a pattern that matches the empty string', () => {
    const redactor = createRedactor({ patterns: [/z*/] });

    expect(redactor.redact('nothing to see')).toBe('nothing to see');
  });

  /**
   * A pattern without the global flag must still be applied to every occurrence, and the anchors
   * inside it must be judged against the real input. Scanning a progressively shortened copy would
   * re-satisfy `^` at each step and redact the second occurrence, which the pattern never matched.
   */
  it('applies an anchored pattern globally without re-anchoring on the remainder', () => {
    const redactor = createRedactor({ patterns: [/^token/] });

    expect(redactor.redact('tokentoken')).toBe(`${REDACTED_TOKEN}token`);
  });

  /**
   * `$` is the mirror case: only the occurrence at the very end of the input matches, and the
   * earlier one has to survive untouched.
   */
  it('honours an end anchor against the whole input', () => {
    const redactor = createRedactor({ patterns: [/token$/] });

    expect(redactor.redact('tokentoken')).toBe(`token${REDACTED_TOKEN}`);
  });

  /**
   * A lookbehind needs the text that precedes the match; a scan over a shortened copy would have
   * thrown that context away, so the second, unqualified occurrence must stay readable.
   */
  it('keeps the context a lookbehind depends on', () => {
    const redactor = createRedactor({ patterns: [/(?<=key=)[a-z]{6}/] });

    expect(redactor.redact('key=abcdef and abcdef')).toBe(`key=${REDACTED_TOKEN} and abcdef`);
  });

  /**
   * A pattern whose secret sits inside a capture group must still be replaced whole. Splitting on
   * a pattern hands back its captures between the surrounding pieces, and writing those back out
   * would print the very text the pattern was there to remove.
   */
  it('drops the captures of a pattern that groups the value it matches', () => {
    const redactor = createRedactor({ patterns: [/(secret)=(\d+)/] });

    expect(redactor.redact('a secret=42 b secret=99 c')).toBe(
      `a ${REDACTED_TOKEN} b ${REDACTED_TOKEN} c`,
    );
  });

  /**
   * The contract patterns are shared, frozen state; compiling copies must not leave `lastIndex`
   * behind on them, or the second call would start matching halfway through the input.
   */
  it('does not mutate the shared contract patterns', () => {
    const redactor = createRedactor();
    redactor.redact(`${CLASSIC_PAT} ${CLASSIC_PAT}`);

    expect(SECRET_SHAPE_PATTERNS.every((pattern) => pattern.lastIndex === 0)).toBe(true);
    expect(redactor.redact(CLASSIC_PAT)).toBe(REDACTED_TOKEN);
  });
});

describe('createRedactor connection-string passwords', () => {
  /**
   * The credential a process leaks about itself rather than about its user. A driver that cannot
   * open a connection quotes the string it tried, password and all, and that string is registered
   * nowhere — the web process reveals no stored secret, so it registers none. Shape is the only
   * layer left, and both connection URLs a process holds have to be covered by it.
   */
  it.each([
    ['a Postgres URL', `postgresql://ah:${DB_PASSWORD}@127.0.0.1:5433/agent_hangar_default`],
    ['a Redis URL', `redis://default:${DB_PASSWORD}@127.0.0.1:5434`],
    ['a driver failure quoting one', `connect ECONNREFUSED redis://u:${DB_PASSWORD}@host:5434`],
  ])('removes the password from %s', (_label, text) => {
    const redactor = createRedactor();

    const output = redactor.redact(text);

    expect(output).not.toContain(DB_PASSWORD);
    expect(output).toContain(REDACTED_TOKEN);
  });

  /**
   * The canonical spelling of a Redis URL that carries only a password: `requirepass` is set, no
   * ACL user is, and the username is therefore empty. It has its own test rather than a row in the
   * table above because it is the likeliest real shape of `REDIS_URL` and the one a rule written
   * around `user:password` silently misses — every other case here passed while this one leaked.
   */
  it('removes the password of a URL with an empty username', () => {
    const redactor = createRedactor();

    const output = redactor.redact(`redis://:${DB_PASSWORD}@127.0.0.1:5434`);

    expect(output).toBe(`redis://:${REDACTED_TOKEN}@127.0.0.1:5434`);
  });

  /**
   * What the lookbehind assumes about the rest of the URL, stated as cases so the assumptions stay
   * as weak as a real URL needs them to be: a scheme that is not a bare word, a percent-encoded
   * username, a bracketed IPv6 host after the userinfo, and a password that itself contains the
   * colon RFC 3986 admits in userinfo — where the first colon separates user from password and
   * everything after it belongs to the password.
   */
  it.each([
    [
      'a compound scheme',
      `postgresql+psycopg://ah:${DB_PASSWORD}@127.0.0.1:5433/db`,
      `postgresql+psycopg://ah:${REDACTED_TOKEN}@127.0.0.1:5433/db`,
    ],
    [
      'brackets in the password',
      `postgresql://ah:${DB_PASSWORD}[x]@127.0.0.1:5433/db`,
      `postgresql://ah:${REDACTED_TOKEN}@127.0.0.1:5433/db`,
    ],
    [
      'an at-sign in the password',
      `postgresql://ah:${DB_PASSWORD}@x@127.0.0.1:5433/db`,
      `postgresql://ah:${REDACTED_TOKEN}@127.0.0.1:5433/db`,
    ],
    [
      'a query string that carries an at-sign',
      `https://u:${DB_PASSWORD}@example.com?next=a@b`,
      `https://u:${REDACTED_TOKEN}@example.com?next=a@b`,
    ],
    [
      'a path that carries an at-sign',
      `https://u:${DB_PASSWORD}@example.com/a@b`,
      `https://u:${REDACTED_TOKEN}@example.com/a@b`,
    ],
    [
      'a percent-encoded username',
      `postgresql://a%40b:${DB_PASSWORD}@127.0.0.1:5433/db`,
      `postgresql://a%40b:${REDACTED_TOKEN}@127.0.0.1:5433/db`,
    ],
    [
      'an IPv6 host',
      `rediss://:${DB_PASSWORD}@[::1]:5434`,
      `rediss://:${REDACTED_TOKEN}@[::1]:5434`,
    ],
    [
      'a password containing a colon',
      `postgresql://ah:${DB_PASSWORD}:more@127.0.0.1:5433/db`,
      `postgresql://ah:${REDACTED_TOKEN}@127.0.0.1:5433/db`,
    ],
  ])('handles %s', (_label, text, expected) => {
    expect(createRedactor().redact(text)).toBe(expected);
  });

  /**
   * Only the password is taken. A failure nobody can locate is its own kind of harm, so the
   * scheme, the user, the host and the path all survive — the line still names what could not be
   * reached.
   */
  it('keeps everything around the password', () => {
    const redactor = createRedactor();

    const output = redactor.redact(
      `postgresql://ah:${DB_PASSWORD}@127.0.0.1:5433/agent_hangar_default`,
    );

    expect(output).toBe(`postgresql://ah:${REDACTED_TOKEN}@127.0.0.1:5433/agent_hangar_default`);
  });

  /**
   * A URL with no password in it is ordinary text and must survive byte for byte, or every log
   * line naming a service would start losing pieces of itself.
   */
  it.each([
    ['no userinfo at all', 'redis://127.0.0.1:5434'],
    ['a user and no password', 'postgresql://ah@127.0.0.1:5433/agent_hangar_default'],
    ['an empty password', 'https://x-access-token:@github.com/acme/widgets.git'],
    ['an empty username and password', 'redis://:@127.0.0.1:5434'],
    ['a bare host and port', 'connect ECONNREFUSED 127.0.0.1:5433'],
    ['an address with no scheme separator', 'mailto:someone@example.com'],
    [
      'a URL without userinfo beside an address that has an at-sign',
      '{"redis":"redis://127.0.0.1:5434","contact":"ops@example.com"}',
    ],
  ])('leaves %s untouched', (_label, text) => {
    expect(createRedactor().redact(text)).toBe(text);
  });

  /**
   * The two spellings the rule sells, pinned so the price stays visible and so widening the class
   * later has to re-derive the trade rather than discover it. The WHATWG parser accepts a raw quote
   * and a raw space in userinfo and percent-encodes them itself, so both are real passwords — but
   * admitting a bare quote would let one match cross a field boundary of a serialised record and
   * delete the fields between, and admitting whitespace would let one run across a whole log line
   * to a distant at-sign. What covers a password of any shape is registering the configured value
   * at boot, not a wider pattern.
   */
  it.each([
    ['a raw quote', `postgresql://ah:${DB_PASSWORD}"x@127.0.0.1:5433/db`],
    ['a raw space', `postgresql://ah:${DB_PASSWORD} x@127.0.0.1:5433/db`],
  ])('leaves a password containing %s to registration instead', (_label, text) => {
    expect(createRedactor().redact(text)).toBe(text);
  });

  /**
   * The property the structural bound had to re-establish from scratch, because it no longer rests
   * on the replacement token's brackets being unmatchable: the token carries no at-sign, so after a
   * substitution it sits immediately before the at-sign the match ended at, and a second pass lands
   * on that same at-sign, matches exactly the token and writes it back. The output is identical,
   * which is what lets the finished-line scrub return early instead of rewriting the line again.
   */
  it.each([
    ['a path after the authority', `postgresql://ah:${DB_PASSWORD}@127.0.0.1:5433/db`],
    ['no path at all', `redis://:${DB_PASSWORD}@127.0.0.1:5434`],
    ['brackets in the password', `postgresql://ah:${DB_PASSWORD}[x]@127.0.0.1:5433/db`],
    ['a query string', `https://u:${DB_PASSWORD}@example.com?next=a@b`],
  ])('is stable when applied twice to a URL with %s', (_label, text) => {
    const redactor = createRedactor();
    const once = redactor.redact(text);

    expect(once).toContain(REDACTED_TOKEN);
    expect(once).not.toContain(DB_PASSWORD);
    expect(redactor.redact(once)).toBe(once);
  });

  /**
   * Two URLs on one line stay two: whitespace ends a match, so the first URL's password cannot
   * reach the second URL's at-sign and swallow everything between them.
   */
  it('redacts each URL on a line independently', () => {
    const text = `postgresql://ah:${DB_PASSWORD}1@h1/db redis://:${DB_PASSWORD}2@h2:5434`;

    expect(createRedactor().redact(text)).toBe(
      `postgresql://ah:${REDACTED_TOKEN}@h1/db redis://:${REDACTED_TOKEN}@h2:5434`,
    );
  });

  /**
   * The redactor's last pass runs over a whole serialised record, where two unrelated values sit
   * next to each other with only `","` between them. A rule that read across that boundary — from
   * a value ending in `scheme://host:` to an `@` in a later value — would swallow the field names
   * in between. Measured, that produces valid JSON with a field silently gone, which is worse than
   * a line that fails to parse: nothing downstream can tell it happened. Over-redaction is a
   * failure of its own, and this is its worst form.
   */
  it('does not read across the fields of a serialised record', () => {
    const line = JSON.stringify({ endpoint: 'https://cache:', contact: 'ops@example.com' });

    const output = createRedactor().redact(line);

    expect(output).toBe(line);
    expect(JSON.parse(output)).toStrictEqual({
      endpoint: 'https://cache:',
      contact: 'ops@example.com',
    });
  });

  /**
   * The same boundary from the other side: a record whose own field holds a URL with a password
   * loses the password and keeps every field, including a later one that contains an at-sign of
   * its own. This is the shape a real log line takes, so it is the one that has to survive intact.
   */
  it('redacts a password inside a record without disturbing the fields around it', () => {
    const line = JSON.stringify({
      db: `redis://:${DB_PASSWORD}@127.0.0.1:5434`,
      contact: 'ops@example.com',
    });

    const output = createRedactor().redact(line);

    expect(output).not.toContain(DB_PASSWORD);
    expect(JSON.parse(output)).toStrictEqual({
      db: `redis://:${REDACTED_TOKEN}@127.0.0.1:5434`,
      contact: 'ops@example.com',
    });
  });
});

describe('createRedactor redactJson', () => {
  /**
   * Agent events and tool arguments are nested structures; a credential can sit at any depth, in a
   * value or in a key, and both have to be scrubbed.
   */
  it('scrubs strings and keys at depth', () => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY, OPENAI_CANARY]);

    const output = redactor.redactJson({
      level: { args: [{ [GITHUB_CANARY]: `bearer ${OPENAI_CANARY}` }] },
    });

    assertNoCanary(JSON.stringify(output));
    expect(output).toEqual({ level: { args: [{ [REDACTED_TOKEN]: `bearer ${REDACTED_TOKEN}` }] } });
  });

  /**
   * Everything that is not text carries no credential and must survive with its type intact, or
   * downstream consumers would see numbers turn into strings.
   */
  it('leaves numbers, booleans, null and undefined untouched', () => {
    const output = createRedactor().redactJson({
      count: 12,
      ok: true,
      missing: null,
      absent: undefined,
    });

    expect(output).toEqual({ count: 12, ok: true, missing: null, absent: undefined });
    expect(Object.keys(output as object)).toContain('absent');
  });

  /**
   * The caller keeps using the object it passed in — an event it is about to publish — so the
   * redactor must build a new structure instead of editing that one.
   */
  it('returns a new structure and leaves the input untouched', () => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY]);
    const input = { outer: { inner: [GITHUB_CANARY] } };

    const output = redactor.redactJson(input);

    expect(output).not.toBe(input);
    expect(input).toEqual({ outer: { inner: [GITHUB_CANARY] } });
  });

  /**
   * Objects that refer back to themselves reach the logger through error chains and cached
   * entities; the walk has to end rather than overflow the stack.
   */
  it('marks a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    cyclic.list = [cyclic];

    const output = createRedactor().redactJson(cyclic) as Record<string, unknown>;

    expect(output.self).toBe(CIRCULAR_TOKEN);
    expect(output.list).toEqual([CIRCULAR_TOKEN]);
  });

  /**
   * The same object appearing twice side by side is not a cycle; flagging it would silently drop
   * real data from a log line.
   */
  it('keeps a repeated sibling object rather than calling it a cycle', () => {
    const shared = { id: 'x' };

    const output = createRedactor().redactJson({ a: shared, b: shared });

    expect(output).toEqual({ a: { id: 'x' }, b: { id: 'x' } });
  });

  /**
   * Dates, buffers and class instances are handed back by reference: rebuilding them would change
   * their meaning, and they are not where credentials live.
   */
  it('returns non-plain values by reference', () => {
    const when = new Date(0);
    const bytes = Buffer.from('abc');
    const instance = new Error('boom');

    const output = createRedactor().redactJson({ when, bytes, instance }) as Record<
      string,
      unknown
    >;

    expect(output.when).toBe(when);
    expect(output.bytes).toBe(bytes);
    expect(output.instance).toBe(instance);
  });

  /**
   * A null-prototype object is still a bare record — it is what `Object.create(null)` maps produce
   * — so its contents must be walked like any other.
   */
  it('walks a null-prototype record', () => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY]);
    const record = Object.assign(Object.create(null) as object, { token: GITHUB_CANARY });

    assertNoCanary(JSON.stringify(redactor.redactJson(record)));
  });

  /**
   * A bare string or number can be handed to `redactJson` directly, for instance when scrubbing a
   * single field, and must behave like the string form.
   */
  it('accepts a bare value', () => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY]);

    expect(redactor.redactJson(GITHUB_CANARY)).toBe(REDACTED_TOKEN);
    expect(redactor.redactJson(7)).toBe(7);
    expect(redactor.redactJson(null)).toBeNull();
  });
});

describe('createRedactor idempotence', () => {
  /**
   * Redaction runs at several layers — runtime, worker, repository, logger — over the same text,
   * so applying it again must be a no-op rather than mangling the token.
   */
  it('is stable when applied twice to text', () => {
    const redactor = createRedactor();
    redactor.register([GITHUB_CANARY]);
    const text = `${GITHUB_CANARY} ${CLASSIC_PAT} ${FINE_GRAINED_PAT} ${PROJECT_API_KEY} ${API_KEY} ${BEARER_HEADER}`;

    const once = redactor.redact(text);

    expect(redactor.redact(once)).toBe(once);
    assertNoCanary(once);
  });

  /**
   * The same property has to hold for structures, which pass through the repository layer and the
   * logger one after the other.
   */
  it('is stable when applied twice to a structure', () => {
    const redactor = createRedactor();
    redactor.register([OPENAI_CANARY]);
    const input = { headers: { authorization: `Bearer ${OPENAI_CANARY}` }, shape: [CLASSIC_PAT] };

    const once = redactor.redactJson(input);

    expect(redactor.redactJson(once)).toEqual(once);
    assertNoCanary(JSON.stringify(once));
  });
});

describe('escapeRegExp', () => {
  /**
   * The helper exists so callers can turn a literal into a pattern; every metacharacter must be
   * quoted, which is proven by matching the literal against the pattern built from it.
   */
  it('quotes every regular-expression metacharacter', () => {
    expect(escapeRegExp('.*+?^${}()|[]\\/')).toBe('\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\\\/');
    expect(escapeRegExp('plain')).toBe('plain');
  });
});
