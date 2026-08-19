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

import { REDACTED_TOKEN, SECRET_SHAPE_PATTERNS } from '../secrets/types.js';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.js';

import { CIRCULAR_TOKEN, createRedactor, escapeRegExp } from './redactor.js';

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
    const redactor = createRedactor({ patterns: [/token\(\d+\)/gi], replacement: '***' });

    expect(redactor.redact('TOKEN(1) and token(22)')).toBe('*** and ***');
    expect(redactor.redact(CLASSIC_PAT)).toBe(CLASSIC_PAT);
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
