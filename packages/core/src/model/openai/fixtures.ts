/**
 * Loader for the recorded Responses API streams under `packages/core/fixtures/openai/`.
 *
 * Layer: test support.
 *
 * The fixtures let provider, worker and runtime tests replay realistic streams without a network
 * call or an API key. Reading is done through an injected {@link FixtureReader} so this module owns
 * no file-system access of its own; the name is restricted to a closed list, so no caller can steer
 * the read at a path of its choosing.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

/** Every fixture stream, by file base name. */
export const OPENAI_FIXTURE_NAMES = [
  'text',
  'tool-call',
  'text-and-tool-call',
  'refusal',
  'failed',
  'incomplete',
  'error-event',
] as const;

/** Name of one fixture stream. */
export type OpenAIFixtureName = (typeof OPENAI_FIXTURE_NAMES)[number];

/** Reads a UTF-8 file; injected so this module performs no file-system access it does not own. */
export type FixtureReader = (path: string, encoding: 'utf8') => Promise<string>;

/**
 * Resolves the fixture directory relative to this module.
 *
 * Works from `src/` and from `dist/` because both are three levels below the package root.
 *
 * @returns Absolute path of the fixture directory, with a trailing separator.
 */
export function openAIFixturesDir(): string {
  return fileURLToPath(new URL('../../../fixtures/openai/', import.meta.url));
}

/**
 * Parses one NDJSON fixture body.
 *
 * @param body - File contents; blank lines are ignored.
 * @param source - Name reported when a line is not an event object.
 * @returns The events in file order.
 * @throws Error naming the offending line when it does not parse as an event.
 */
export function parseOpenAIFixture(body: string, source: string): ResponseStreamEvent[] {
  const events: ResponseStreamEvent[] = [];
  const lines = body.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof Reflect.get(parsed, 'type') !== 'string'
    ) {
      throw new Error(`Fixture ${source} line ${String(index + 1)} is not a stream event`);
    }
    events.push(parsed as ResponseStreamEvent);
  }
  return events;
}

/**
 * Loads one recorded stream.
 *
 * @param name - Fixture base name; must be a member of {@link OPENAI_FIXTURE_NAMES}.
 * @param read - File reader; defaults to Node's UTF-8 reader.
 * @returns The events of that stream, in order.
 * @throws Error listing the valid names when `name` is not one of them.
 */
export async function loadOpenAIFixture(
  name: OpenAIFixtureName,
  read: FixtureReader = readFile,
): Promise<ResponseStreamEvent[]> {
  if (!(OPENAI_FIXTURE_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `Unknown OpenAI fixture "${name}" (expected one of: ${OPENAI_FIXTURE_NAMES.join(', ')})`,
    );
  }
  const body = await read(`${openAIFixturesDir()}${name}.ndjson`, 'utf8');
  return parseOpenAIFixture(body, name);
}
