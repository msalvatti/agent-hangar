/**
 * Unit tests for the redacting logger factory.
 *
 * Layer: unit.
 * Goal: a credential cannot reach the output stream through any pino channel — message,
 * interpolation, merge object, child binding, error message or stack, or a value the redactor
 * cannot walk — while ordinary fields and the configured level, name and base survive.
 * Mocks: an in-memory `Writable` as the destination; the real redactor with both canaries
 * registered.
 */
import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createRedactor, CIRCULAR_TOKEN } from '../redaction/redactor.ts';
import { REDACTED_TOKEN } from '../secrets/types.ts';
import {
  assertNoCanary,
  CANARY_MARKER,
  GITHUB_CANARY,
  OPENAI_CANARY,
} from '../testing/canaries.ts';

import type { CreateLoggerOptions, LoggerRedactor } from './logger.ts';
import { LOG_REDACT_PATHS, SENSITIVE_FIELD_NAMES, createLogger } from './logger.ts';

/**
 * A credential shaped like nothing the pattern layer recognises and registered nowhere, so only
 * field-name redaction can catch it.
 */
const OPAQUE_CREDENTIAL = 'opaque-value-1234';

/**
 * A database password: registered nowhere, shaped like no token, and marked as a canary so it is
 * unmistakably fake. Only the connection-string rule of the redactor can reach it.
 */
const DB_PASSWORD = `db-${CANARY_MARKER}-pw`;

/** A logger writing into memory, plus access to what it wrote. */
interface Capture {
  logger: ReturnType<typeof createLogger>;
  lines(): string[];
  records(): Record<string, unknown>[];
  text(): string;
}

/**
 * Creates a logger whose destination is an in-memory stream.
 *
 * @param overrides - Options replacing the defaults (level `info`, both canaries registered).
 * @returns The logger and readers over its output.
 */
function capture(overrides: Partial<CreateLoggerOptions> = {}): Capture {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: unknown, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  const redactor = createRedactor();
  redactor.register([GITHUB_CANARY, OPENAI_CANARY]);
  const logger = createLogger({ level: 'info', redactor, destination, ...overrides });
  const lines = (): string[] => chunks.join('').split('\n').filter(Boolean);
  return {
    logger,
    lines,
    records: () => lines().map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => chunks.join(''),
  };
}

describe('createLogger', () => {
  /**
   * The plainest leak: a credential interpolated into the message by the caller. The hook scrubs
   * the arguments before pino ever formats them.
   */
  it('redacts a credential in the message', () => {
    const sink = capture();

    sink.logger.info(`cloning with ${GITHUB_CANARY}`);

    assertNoCanary(sink.text());
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * pino formats `%s` itself, after the hook runs, so the interpolation argument has to be
   * scrubbed as an argument rather than as part of the finished message.
   */
  it('redacts a credential passed as an interpolation argument', () => {
    const sink = capture();

    sink.logger.info('key=%s', OPENAI_CANARY);

    assertNoCanary(sink.text());
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * Structured fields are where agent events land; a credential can sit at any depth of the merge
   * object and must not depend on the caller naming the field sensitively.
   */
  it('redacts a credential nested in the merge object', () => {
    const sink = capture();

    sink.logger.info({ a: { b: { c: OPENAI_CANARY } } }, 'nested');

    assertNoCanary(sink.text());
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * The path list works on names, not shapes, so a credential that matches no pattern and was
   * never registered is still blanked when it sits in a field known to hold one.
   */
  it.each([
    ['a root environment field', { env: { GITHUB_TOKEN: 'plain-value-1234' } }],
    ['a nested environment field', { spec: { env: { OPENAI_API_KEY: 'plain-value-1234' } } }],
    ['a request header', { req: { headers: { authorization: 'Basic plain-value-1234' } } }],
    ['a root header', { headers: { authorization: 'Basic plain-value-1234' } }],
    ['a named secret field', { secret: 'plain-value-1234' }],
    ['a nested plaintext field', { input: { plaintext: 'plain-value-1234' } }],
  ])('blanks %s by path', (_label, record) => {
    const sink = capture();

    sink.logger.info(record, 'by path');

    expect(sink.text()).not.toContain('plain-value-1234');
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * Child loggers carry their bindings into every later record, so a credential bound once would
   * otherwise leak on every line; unrelated bindings must survive.
   */
  it('redacts child bindings and keeps the rest', () => {
    const sink = capture();

    sink.logger.child({ apiKey: OPENAI_CANARY, turnId: 't1' }).info('child');

    assertNoCanary(sink.text());
    expect(sink.records()[0]?.turnId).toBe('t1');
  });

  /**
   * Error messages and stacks quote the input that failed, which is exactly how a credential ends
   * up in a log; both are scrubbed while the error stays recognisable.
   */
  it('redacts the message and stack of a logged error', () => {
    const sink = capture();

    sink.logger.error({ err: new Error(`clone failed for ${GITHUB_CANARY}`) }, 'failed');

    assertNoCanary(sink.text());
    const err = sink.records()[0]?.err as Record<string, unknown>;
    expect(err.type).toBe('Error');
    expect(err.message).toContain(REDACTED_TOKEN);
    expect(String(err.stack)).toContain(REDACTED_TOKEN);
  });

  /**
   * The database password is the one credential no process registers: the web app never reveals a
   * stored secret, so it hands the redactor nothing, and a bare password matches no token shape.
   * A driver that cannot open its connection quotes the string it tried — and a 5xx handler logs
   * that error — so what is asserted here is the written line, not that a hook ran: the password
   * is gone from it and the rest of the URL, which is what makes the failure locatable, is not.
   */
  it('redacts the password of a connection string quoted by a driver error', () => {
    const sink = capture();
    const url = `postgresql://ah:${DB_PASSWORD}@127.0.0.1:5433/agent_hangar_default`;

    sink.logger.error({ err: new Error(`connect ECONNREFUSED ${url}`) }, 'request failed');

    expect(sink.text()).not.toContain(DB_PASSWORD);
    expect(sink.text()).toContain(
      `postgresql://ah:${REDACTED_TOKEN}@127.0.0.1:5433/agent_hangar_default`,
    );
  });

  /**
   * Errors carry extra fields — an exit code, an HTTP status — that are not text; scrubbing must
   * leave them with their type intact so callers can still branch on them.
   */
  it('keeps non-string properties of a logged error', () => {
    const sink = capture();

    sink.logger.error({ err: Object.assign(new Error('boom'), { status: 500 }) }, 'failed');

    expect((sink.records()[0]?.err as Record<string, unknown>).status).toBe(500);
  });

  /**
   * HTTP clients attach the whole failed request to the error they throw, so a credential can sit
   * several levels inside an error property; the serializer walks them all rather than only the
   * top-level strings.
   */
  it('redacts a credential nested inside an error property', () => {
    const sink = capture();
    const failure = Object.assign(new Error('request failed'), {
      request: { headers: { custom: OPENAI_CANARY } },
    });

    sink.logger.error({ err: failure }, 'failed');

    assertNoCanary(sink.text());
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * pino runs the `err` serializer on whatever sits under that key, and a rejection reason is not
   * always an `Error` — a worker logging an unknown rejection as `{ err: reason }` is the ordinary
   * case. `null` used to abort the whole logging call, which would have silenced the record that
   * was meant to report the failure.
   */
  it('logs a null err instead of throwing', () => {
    const sink = capture();

    expect(() => {
      sink.logger.error({ err: null }, 'unknown rejection');
    }).not.toThrow();
    const record = sink.records()[0];
    expect(record?.msg).toBe('unknown rejection');
    expect(record?.err).toBeNull();
  });

  /**
   * A string reason must stay readable. Walking it as an error record spread it into one entry per
   * character, which destroys the only diagnostic the record carried.
   */
  it('keeps a string err readable and scrubs it', () => {
    const sink = capture();

    sink.logger.error({ err: `clone failed for ${GITHUB_CANARY}` }, 'failed');

    assertNoCanary(sink.text());
    expect(sink.records()[0]?.err).toBe(`clone failed for ${REDACTED_TOKEN}`);
  });

  /**
   * A number reason used to be flattened to `{}`, losing the value entirely; it has to survive as
   * itself.
   */
  it('keeps a numeric err intact', () => {
    const sink = capture();

    sink.logger.error({ err: 42 }, 'failed');

    expect(sink.records()[0]?.err).toBe(42);
  });

  /**
   * A plain object reason is not an error either, so it is scrubbed and passed through with its
   * own shape rather than being rebuilt as an error record.
   */
  it('scrubs a plain-object err without reshaping it', () => {
    const sink = capture();

    sink.logger.error({ err: { reason: OPENAI_CANARY, code: 7 } }, 'failed');

    assertNoCanary(sink.text());
    expect(sink.records()[0]?.err).toEqual({ reason: REDACTED_TOKEN, code: 7 });
  });

  /**
   * pino's `redact` paths are matched case-sensitively, and header names are not. An
   * `Authorization` header is the ordinary spelling in every HTTP client, and its value is a
   * credential this process never registered, so no other layer would catch it.
   */
  it.each(['Authorization', 'AUTHORIZATION', 'authoriZation'])(
    'blanks a %s header whatever its case',
    (field) => {
      const sink = capture();

      sink.logger.info({ headers: { [field]: `Bearer ${OPAQUE_CREDENTIAL}` } }, 'req');

      expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
      expect(sink.records()[0]?.msg).toBe('req');
    },
  );

  /**
   * The `*` wildcard in a redact path spans exactly one level, so anything nested deeper was
   * written in full. Request context is routinely two or three levels down.
   */
  it('blanks a sensitive field nested deeper than the redact paths reach', () => {
    const sink = capture();

    sink.logger.info(
      { outer: { inner: { headers: { authorization: `Bearer ${OPAQUE_CREDENTIAL}` } } } },
      'req',
    );

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * Every name the logger claims to protect must actually be protected at depth and in a
   * different case. This is the lockstep guard: adding a name to one list and not the other, or
   * adding a redact path without a matching value pattern, fails here rather than in production.
   */
  it.each([...SENSITIVE_FIELD_NAMES])('blanks %s at depth in an unexpected case', (field) => {
    const sink = capture();
    const shouted = field.toUpperCase();
    const nested: Record<string, unknown> = { deep: { [shouted]: OPAQUE_CREDENTIAL } };

    sink.logger.info(nested, 'record');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * Only the value is replaced, never the quotes or the comma around it, so the line a consumer
   * parses is still a record and the untouched fields are still readable.
   */
  it('keeps the line parseable and the other fields intact when it blanks a value', () => {
    const sink = capture();

    sink.logger.info(
      { requestId: 'abc-123', headers: { Authorization: OPAQUE_CREDENTIAL } },
      'req',
    );

    const record = sink.records()[0];
    expect(record?.requestId).toBe('abc-123');
    expect(record?.msg).toBe('req');
    expect((record?.headers as Record<string, unknown>).Authorization).toBe(REDACTED_TOKEN);
  });

  /**
   * A value carrying an escaped quote must be blanked whole; stopping at the escape would leave
   * the tail of the credential in the output.
   */
  it('blanks a value that contains an escaped quote', () => {
    const sink = capture();

    sink.logger.info({ headers: { Authorization: `a"${OPAQUE_CREDENTIAL}` } }, 'req');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * A field whose name merely ends with a protected name is a different field; blanking it would
   * destroy ordinary diagnostics for no gain.
   */
  it('leaves a field whose name only ends with a protected name alone', () => {
    const sink = capture();

    sink.logger.info({ tokenCount: 42, refreshTokenIssuedAt: 'yesterday' }, 'stats');

    const record = sink.records()[0];
    expect(record?.tokenCount).toBe(42);
    expect(record?.refreshTokenIssuedAt).toBe('yesterday');
  });

  /**
   * A credential does not stop being one because it was wrapped. The finished-line pass matches
   * quote-delimited values, so an object or an array under a protected name slipped past it; the
   * whole value has to go, not the strings inside it.
   */
  it.each([
    ['object', { raw: OPAQUE_CREDENTIAL }],
    ['array', [OPAQUE_CREDENTIAL]],
    ['nested object', { a: { b: OPAQUE_CREDENTIAL } }],
  ])('blanks a %s value under a protected name', (_label, wrapped) => {
    const sink = capture();

    sink.logger.info({ deep: { TOKEN: wrapped } }, 'req');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
    expect((sink.records()[0]?.deep as Record<string, unknown>).TOKEN).toBe(REDACTED_TOKEN);
  });

  /**
   * A list of request contexts is an ordinary shape, and the protected field sits inside the
   * elements rather than under the array itself, so the walk has to descend through the array.
   */
  it('blanks a protected field inside an array element', () => {
    const sink = capture();

    sink.logger.info({ items: [{ id: 1 }, { Authorization: OPAQUE_CREDENTIAL }] }, 'batch');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
    // Still a list, and still in order. Rebuilt as a record instead, an array becomes an object
    // keyed by its indices — the credential is gone either way, and every consumer of the line
    // now reads a shape that is not the one that was logged.
    expect(sink.records()[0]?.items).toStrictEqual([{ id: 1 }, { Authorization: REDACTED_TOKEN }]);
  });

  /**
   * Two references to the same object are not a cycle. The walk remembers what is on the path it
   * is currently following and has to forget it on the way back out; a record that only ever grows
   * reports the second sibling as circular, and a reader is told a value was recursive when it was
   * merely repeated.
   */
  it('renders the same object twice when it appears twice side by side', () => {
    const sink = capture();
    const shared = { id: 7 };

    sink.logger.info({ left: shared, right: shared }, 'twice');

    expect(sink.records()[0]?.left).toStrictEqual({ id: 7 });
    expect(sink.records()[0]?.right).toStrictEqual({ id: 7 });
  });

  /**
   * The same on the array path, which keeps its own book of what it has entered: a list holding
   * one object twice is a list of two readable entries.
   */
  it('renders the same object twice when a list holds it twice', () => {
    const sink = capture();
    const shared = { id: 7 };

    sink.logger.info({ items: [shared, shared] }, 'twice');

    expect(sink.records()[0]?.items).toStrictEqual([{ id: 7 }, { id: 7 }]);
  });

  /** A list that contains itself has to terminate on the array path as it does on the record one. */
  it('terminates on a list that contains itself', () => {
    const sink = capture();
    const items: unknown[] = [{ id: 1 }];
    items.push(items);

    sink.logger.info({ items }, 'cyclic list');

    expect(sink.records()[0]?.items).toStrictEqual([{ id: 1 }, CIRCULAR_TOKEN]);
  });

  /**
   * A null-prototype record is still a bare record — `Object.create(null)` is a common way to build
   * a header bag — so it must be walked rather than mistaken for a class instance.
   */
  it('blanks a protected field inside a null-prototype record', () => {
    const sink = capture();
    const bag: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // An object rather than a string, and two levels down: the scrub of the finished line replaces
    // string values and pino's own paths reach one level, so walking the bag is the only thing
    // that can reach this. Mistaken for a class instance it is returned as it came in.
    bag.Authorization = { raw: OPAQUE_CREDENTIAL };

    sink.logger.info({ outer: { bag } }, 'req');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * pino replaces the bindings formatter on a child instance, so the configured one never sees
   * child bindings, and its own redact paths reach them with the same case and depth limits as
   * everywhere else. A grandchild must be covered too, or one `child()` call would shed the
   * protection.
   */
  it('blanks a protected field in a child and in a grandchild binding', () => {
    const sink = capture();

    sink.logger.child({ ctx: { TOKEN: { raw: OPAQUE_CREDENTIAL } } }).info('child');
    sink.logger
      .child({ a: 1 })
      .child({ ctx: { ApiKey: { raw: OPAQUE_CREDENTIAL } } })
      .info('grand');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
    expect(sink.records()).toHaveLength(2);
  });

  /**
   * `child` takes an options argument as well; the overload that passes it must keep scrubbing
   * rather than fall back to the untouched pino implementation.
   */
  it('blanks a child binding when child is called with options', () => {
    const sink = capture();

    sink.logger.child({ ctx: { TOKEN: OPAQUE_CREDENTIAL } }, { level: 'info' }).info('child');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * A child logger must still behave like a logger: its bindings reach the record and its level
   * option is honoured.
   */
  it('keeps ordinary child bindings and options working', () => {
    const sink = capture();

    const child = sink.logger.child({ chatId: 'c1' }, { level: 'warn' });
    child.info('filtered out');
    child.warn('kept');

    expect(sink.records()).toHaveLength(1);
    expect(sink.records()[0]?.chatId).toBe('c1');
    expect(sink.records()[0]?.msg).toBe('kept');
  });

  /**
   * Serializers run after `formatters.log`, so the record the error serializer produces is never
   * seen by the structural pass over the merge object. A library that attaches a credential-bearing
   * context object to the error it throws would otherwise publish it whole.
   */
  it('blanks a protected field inside a serialised error', () => {
    const sink = capture();

    sink.logger.error(
      { err: Object.assign(new Error('boom'), { ctx: { TOKEN: { raw: OPAQUE_CREDENTIAL } } }) },
      'failed',
    );

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
    expect((sink.records()[0]?.err as Record<string, unknown>).message).toBe('boom');
  });

  /**
   * An interpolation argument is folded into `msg` and becomes text, so nothing after the argument
   * hook could take it apart again to find the protected name inside it.
   */
  it('blanks a protected field inside an interpolation argument', () => {
    const sink = capture();

    sink.logger.info('saw %o', { deep: { TOKEN: { raw: OPAQUE_CREDENTIAL } } });

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * The structural pass rebuilds objects, so it needs its own cycle guard: a record that refers
   * back to itself must terminate and still lose the protected field.
   */
  it('terminates on a cyclic record and still blanks the protected field', () => {
    const sink = capture();
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    cyclic.deep = { TOKEN: { raw: OPAQUE_CREDENTIAL } };

    sink.logger.info(cyclic, 'cycle');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
    expect(sink.records()[0]?.name).toBe('root');
  });

  /**
   * A list inside a list is still a list. The walk keeps its own book of what it has entered on
   * the array path as well as the record one, and the same list logged twice side by side is two
   * readable entries rather than one and a note that the second was circular.
   */
  it('renders the same list twice when it appears twice side by side', () => {
    const sink = capture();
    const shared = [{ id: 7 }];

    sink.logger.info({ left: shared, right: shared }, 'twice');

    expect(sink.records()[0]?.left).toStrictEqual([{ id: 7 }]);
    expect(sink.records()[0]?.right).toStrictEqual([{ id: 7 }]);
  });

  /**
   * A credential under a protected name inside a list element, deep enough that pino's own paths
   * do not name it and shaped so the scrub of the finished line cannot reach it either — that
   * scrub replaces string values, and this one is an object. Only walking the list finds it, and a
   * walk that does not recognise a list hands it back exactly as it arrived.
   */
  it('blanks a protected field inside a list element the other passes cannot reach', () => {
    const sink = capture();

    sink.logger.info({ outer: { items: [{ token: { raw: OPAQUE_CREDENTIAL } }] } }, 'batch');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * A record may carry a field that is explicitly nothing, and the walk has to answer for it
   * before it asks anything about its prototype — there is nothing there to ask.
   */
  it('logs a record carrying an explicitly absent field', () => {
    const sink = capture();

    sink.logger.info({ present: 1, absent: undefined }, 'note');

    expect(sink.records()[0]?.present).toBe(1);
  });

  /**
   * A rejection reason that is a list is not an error record, and pino hands it back untouched
   * rather than rebuilding it. Read as one anyway it is copied entry by entry into a plain object,
   * and what the reader is shown is a list turned into a record keyed by its own indices.
   */
  it('keeps a list logged as err a list', () => {
    const sink = capture();

    sink.logger.error({ err: ['first', 'second'] }, 'failed');

    expect(sink.records()[0]?.err).toStrictEqual(['first', 'second']);
  });

  /**
   * A bare record — `Object.create(null)` is the usual way to build a header bag — is still a
   * record and has to be walked rather than mistaken for something with a class behind it. Proved
   * through the base bindings because they are scrubbed exactly once: on the way through a logging
   * call the record is walked, serialised and walked again, and the serialisation alone gives it
   * an ordinary prototype, so the second walk covers for the first however the first behaved.
   */
  it('walks a bare record in the base bindings rather than handing it back', () => {
    const bag: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    // An object, so the scrub of the finished line cannot stand in for the walk: that pass
    // replaces string values and would blank a credential here whatever the walk did.
    bag.Authorization = { raw: OPAQUE_CREDENTIAL };
    const sink = capture({ base: { outer: { bag } } });

    sink.logger.info('note');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * The base bindings are the one record the logging hook never sees: they are handed to the
   * factory rather than to a call, so the bindings formatter is the only thing in front of them.
   * Deep enough that pino's own paths do not name it, and an object so the finished-line scrub
   * cannot reach it either.
   */
  it('blanks a protected field in the base bindings', () => {
    const sink = capture({ base: { deep: { inner: { token: { raw: OPAQUE_CREDENTIAL } } } } });

    sink.logger.info('note');

    expect(sink.text()).not.toContain(OPAQUE_CREDENTIAL);
  });

  /**
   * A credential parked on a class instance is invisible to the structural walk, but pino still
   * serialises the instance's own fields; the final scrub of the written line closes that gap.
   */
  it('redacts a credential carried by a value the walk cannot rebuild', () => {
    const sink = capture();
    class Holder {
      constructor(readonly value: string) {}
    }

    sink.logger.info({ holder: new Holder(GITHUB_CANARY) }, 'opaque');

    assertNoCanary(sink.text());
    expect(sink.text()).toContain(REDACTED_TOKEN);
  });

  /**
   * The last-resort scrub must never emit a broken line: if redaction leaves something that is no
   * longer JSON, the line is dropped in favour of a fixed notice.
   */
  it('drops a line that redaction would leave as invalid JSON', () => {
    const breaking: LoggerRedactor = {
      redact: (value) => value.replaceAll('}', ''),
      redactJson: (value) => value,
    };
    const sink = capture({ redactor: breaking });

    sink.logger.info('anything');

    expect(sink.records()[0]?.msg).toBe(
      'A log line was dropped: redaction left it as invalid JSON.',
    );
  });

  /**
   * Over-redaction would make transcripts useless, so text that carries nothing credential-shaped
   * must come through exactly as written.
   */
  it('leaves ordinary text untouched', () => {
    const sink = capture();

    sink.logger.info({ repo: 'octocat/hello-world' }, 'workspace ready');

    expect(sink.records()[0]?.msg).toBe('workspace ready');
    expect(sink.records()[0]?.repo).toBe('octocat/hello-world');
  });

  /**
   * The level comes from configuration; a record below it must not be serialised at all, and
   * `silent` must write nothing whatsoever.
   */
  it.each([
    ['warn', 1],
    ['silent', 0],
  ])('honours level %s', (level, expected) => {
    const sink = capture({ level });

    sink.logger.info('dropped');
    sink.logger.warn('kept');

    expect(sink.lines()).toHaveLength(expected);
  });

  /**
   * Processes share one log stream, so the name and the caller's base fields are what tell their
   * records apart.
   */
  it('attaches the name and the base fields', () => {
    const sink = capture({ name: 'worker', base: { service: 'turns' } });

    sink.logger.info('hello');

    expect(sink.records()[0]?.name).toBe('worker');
    expect(sink.records()[0]?.service).toBe('turns');
  });

  /**
   * The default base is empty on purpose: a hostname and a process id are personal data this app
   * has no reason to record.
   */
  it('records no hostname or process id by default', () => {
    const sink = capture();

    sink.logger.info('hello');

    const record = sink.records()[0] ?? {};
    expect(record).not.toHaveProperty('hostname');
    expect(record).not.toHaveProperty('pid');
  });

  /**
   * Every line is one JSON object with an ISO timestamp, which is what makes the output greppable
   * and machine-readable in the first place.
   */
  it('writes one JSON object per line with an ISO timestamp', () => {
    const sink = capture();

    sink.logger.info('hello');

    expect(String(sink.records()[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    expect(sink.records()[0]?.level).toBe(30);
  });

  /**
   * Omitting the destination is the production case: pino falls back to standard output, and the
   * factory must still return a usable logger.
   */
  it('falls back to the standard output stream', () => {
    const redactor = createRedactor();

    const logger = createLogger({ level: 'silent', redactor });

    expect(typeof logger.info).toBe('function');
  });

  /**
   * The path list is part of the contract other modules rely on; it names both the root and the
   * one-level-down spelling of every sensitive field.
   */
  it('exposes root and wildcard spellings of every sensitive path', () => {
    for (const path of LOG_REDACT_PATHS.filter((entry) => !entry.startsWith('*.'))) {
      expect(LOG_REDACT_PATHS).toContain(`*.${path}`);
    }
  });

  /**
   * Written out here rather than read from the module, which is the whole point: every other check
   * in this file walks these two lists to build its cases, so a list that had lost its entries
   * would produce no cases at all and every one of those checks would pass by having nothing left
   * to do. Stated independently, an entry that goes missing is a difference between two lists.
   */
  it('protects exactly these paths and these field names', () => {
    expect(LOG_REDACT_PATHS).toStrictEqual([
      'env.GITHUB_TOKEN',
      'env.OPENAI_API_KEY',
      '*.env.GITHUB_TOKEN',
      '*.env.OPENAI_API_KEY',
      'headers.authorization',
      '*.headers.authorization',
      'secret',
      '*.secret',
      'plaintext',
      '*.plaintext',
      'apiKey',
      '*.apiKey',
      'token',
      '*.token',
    ]);
    expect(SENSITIVE_FIELD_NAMES).toStrictEqual([
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'authorization',
      'secret',
      'plaintext',
      'apiKey',
      'token',
    ]);
  });

  /**
   * One case per protected name, spelt out rather than generated from the list, so a name that
   * disappears from the module leaves a case behind that fails instead of a case that is never
   * built.
   */
  it.each([
    ['GITHUB_TOKEN'],
    ['OPENAI_API_KEY'],
    ['authorization'],
    ['secret'],
    ['plaintext'],
    ['apiKey'],
    ['token'],
  ])('blanks a field named %s wherever it sits', (field) => {
    const { logger, lines } = capture();

    logger.info({ deep: { [field]: 'a value nobody may read' } }, 'note');

    const line = lines()[0] ?? '';
    expect(line).not.toContain('a value nobody may read');
    expect(line).toContain(REDACTED_TOKEN);
  });

  /**
   * The one case the last-resort scrub of the finished line is the only net for. The structural
   * pass rebuilds plain objects and leaves a class instance as it found it; pino's own paths reach
   * one level below the root and this sits two levels down; so the credential arrives in the line
   * as an ordinary string field and nothing before this has touched it. pino writes its records
   * with no space after the colon, which is why the pattern allows none — one that demands a
   * space matches nothing it was written for.
   */
  it.each([
    ['GITHUB_TOKEN'],
    ['OPENAI_API_KEY'],
    ['authorization'],
    ['secret'],
    ['plaintext'],
    ['apiKey'],
    ['token'],
  ])('blanks %s when the structural pass and the redact paths both miss it', (field) => {
    // A prototype of its own, so the structural pass returns it as it found it, and two levels
    // down, so pino's one-level paths do not name it. The value is several characters long because
    // a pattern that stops after one would leave the rest of the credential in the line.
    const carrier: Record<string, unknown> = Object.create({ kind: 'request-context' }) as Record<
      string,
      unknown
    >;
    carrier[field] = 'a value nobody may read';
    const { logger, records } = capture();

    logger.info({ outer: { ctx: carrier } }, 'note');

    // Read as the value of that field rather than as text absent from the line: a pattern that
    // stops after one character leaves the rest of the credential where it was, and a line that no
    // longer contains the whole value looks scrubbed while still carrying nearly all of it.
    const outer = records()[0]?.outer as { ctx: Record<string, unknown> } | undefined;
    expect(outer?.ctx[field]).toBe(REDACTED_TOKEN);
  });

  /**
   * The structural pass rebuilds plain objects and arrays and leaves anything else alone, because
   * rebuilding a class instance would lose what it is. pino's own path redaction is what reaches
   * inside one, and it is the only layer that can: the finished-line scrub replaces string values
   * and this credential is an object.
   */
  it('blanks a protected field inside a value the structural pass will not rebuild', () => {
    class RequestContext {
      readonly token = { header: 'a value nobody may read' };
    }
    const { logger, lines } = capture();

    logger.info({ ctx: new RequestContext() }, 'note');

    const line = lines()[0] ?? '';
    expect(line).not.toContain('a value nobody may read');
    expect(line).toContain(REDACTED_TOKEN);
  });
});
