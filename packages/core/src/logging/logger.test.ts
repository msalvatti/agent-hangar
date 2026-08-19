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

import { createRedactor } from '../redaction/redactor.js';
import { REDACTED_TOKEN } from '../secrets/types.js';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.js';

import type { CreateLoggerOptions, LoggerRedactor } from './logger.js';
import { LOG_REDACT_PATHS, createLogger } from './logger.js';

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
   * The path list is part of the contract other lanes rely on; it names both the root and the
   * one-level-down spelling of every sensitive field.
   */
  it('exposes root and wildcard spellings of every sensitive path', () => {
    for (const path of LOG_REDACT_PATHS.filter((entry) => !entry.startsWith('*.'))) {
      expect(LOG_REDACT_PATHS).toContain(`*.${path}`);
    }
  });
});
