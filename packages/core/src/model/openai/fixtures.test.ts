/**
 * Unit tests of the OpenAI fixture loader and of the committed fixture files.
 *
 * Layer: test.
 *
 * The file assertions are the gate that keeps the fixtures usable: every line has to parse, every
 * event type has to be one the SDK declares, and no line may carry credential-shaped material.
 */
import { describe, expect, it } from 'vitest';

import { SECRET_SHAPE_PATTERNS } from '../../secrets/types.js';
import { OPENAI_CANARY, assertNoCanary } from '../../testing/canaries.js';

import {
  OPENAI_FIXTURE_NAMES,
  loadOpenAIFixture,
  openAIFixturesDir,
  parseOpenAIFixture,
} from './fixtures.js';
import type { OpenAIFixtureName } from './fixtures.js';
import { LIFECYCLE_EVENT_TYPES, VERIFIED_EVENT_TYPES } from './mapping.js';

/** Every event type a committed fixture is allowed to contain. */
const ALLOWED_TYPES = new Set<string>([...VERIFIED_EVENT_TYPES, ...LIFECYCLE_EVENT_TYPES]);

describe('openAIFixturesDir', () => {
  it('points at the fixture folder of the package', () => {
    // Resolved from the module URL so the loader works from src/ and from dist/ alike.
    expect(openAIFixturesDir().endsWith('/fixtures/openai/')).toBe(true);
  });
});

describe('parseOpenAIFixture', () => {
  it('ignores blank lines', () => {
    // Trailing newlines are normal in a text file and must not become an empty event.
    const body = '{"type":"error","message":"x"}\n\n';
    expect(parseOpenAIFixture(body, 'inline')).toHaveLength(1);
  });

  it('rejects a line that is not JSON without repeating it', () => {
    // The platform parser quotes its input in the error it raises; the fixture body never is.
    expect(() => parseOpenAIFixture('{"broken"\n', 'inline')).toThrow('Fixture line is not JSON');
  });

  it('rejects a line that is not an event object', () => {
    // A malformed fixture must fail loudly instead of replaying as `undefined`.
    expect(() => parseOpenAIFixture('42\n', 'inline')).toThrow(
      'Fixture inline line 1 is not a stream event',
    );
    expect(() => parseOpenAIFixture('null\n', 'inline')).toThrow(/not a stream event/);
    expect(() => parseOpenAIFixture('{"nope":1}\n', 'inline')).toThrow(/not a stream event/);
  });
});

describe('loadOpenAIFixture', () => {
  it('rejects a name that is not a committed fixture without repeating it', () => {
    // The name is the only caller-supplied part of the path, so it stays a closed list, and the
    // rejected value is never echoed back into the error.
    const unknown = OPENAI_CANARY as OpenAIFixtureName;
    return expect(loadOpenAIFixture(unknown)).rejects.toThrow(
      'Unknown OpenAI fixture (expected one of: text, tool-call, text-and-tool-call, refusal, failed, incomplete, error-event)',
    );
  });

  it('reads through the injected reader', () => {
    // The loader owns no file-system access; a test can replay a fixture from memory.
    const read = (path: string): Promise<string> =>
      Promise.resolve(`{"type":"error","message":"${path.endsWith('text.ndjson') ? 'ok' : 'no'}"}`);
    return expect(loadOpenAIFixture('text', read)).resolves.toEqual([
      { type: 'error', message: 'ok' },
    ]);
  });

  it.each(OPENAI_FIXTURE_NAMES)('loads %s with only known event types', async (name) => {
    // A renamed SDK event would otherwise sit unnoticed in a fixture until a stream test failed.
    const events = await loadOpenAIFixture(name);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(ALLOWED_TYPES.has(event.type)).toBe(true);
      expect(typeof event.sequence_number).toBe('number');
    }
  });

  it.each(OPENAI_FIXTURE_NAMES)('keeps %s free of credential material', async (name) => {
    // Fixtures are committed files; a credential shape in one would be a leak in the repository.
    const events = await loadOpenAIFixture(name);
    const body = JSON.stringify(events);
    assertNoCanary(body);
    for (const pattern of SECRET_SHAPE_PATTERNS) {
      expect(pattern.test(body)).toBe(false);
    }
  });
});
