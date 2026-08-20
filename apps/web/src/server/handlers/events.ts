/**
 * The two event-stream routes: a chat's current turn, and one scheduled-job run.
 *
 * Layer: service (server).
 *
 * Both resolve which stream to read and then hand off to the stream factory. Neither carries the
 * same-origin guard: they are reads, `EventSource` is same-origin by construction, and the browser
 * already stops a cross-origin page from reading the body.
 *
 * The resume point comes from the `Last-Event-ID` header the browser resends on its own
 * reconnects, or from `?from=` when the page was reloaded. The header wins, because it is the one
 * the browser maintains; a malformed value in either is ignored rather than refused, since the
 * cost of ignoring it is one replayed transcript and the cost of refusing it is a stream that
 * never opens.
 */
import { turnEventsStreamKey } from '@agent-hangar/core';
import { z } from 'zod';

import type { ServerContainer } from '../container';
import { ResourceNotFoundError } from '../errors';
import { parseQuery, withErrorHandling } from '../http';
import { createSseResponse } from '../sse';

import { isLive } from './guards';

/** Shape of a Redis Stream entry id. */
export const STREAM_ID_PATTERN = /^\d+-\d+$/;

/** Query accepted by both event routes. */
const eventsQuery = z.object({ from: z.string().regex(STREAM_ID_PATTERN).optional() });

/** Path parameters of the event routes. */
export interface EventsParams {
  id: string;
}

/**
 * Reads the resume point from the request.
 *
 * @param request - The incoming request.
 * @param from - The validated `?from=` value, when there was one.
 * @returns The entry id to resume after, or `undefined` to replay everything.
 */
function resumePoint(request: Request, from: string | undefined): string | undefined {
  const header = request.headers.get('last-event-id');
  if (header !== null && STREAM_ID_PATTERN.test(header)) {
    return header;
  }
  return from;
}

/**
 * `GET /api/chats/:id/events` — the live events of the chat's most recent turn.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns A `text/event-stream` response, or `404` when the chat has no turn to stream.
 */
export function chatEvents(
  container: ServerContainer,
  request: Request,
  params: EventsParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    const query = parseQuery(request.url, eventsQuery);
    if ((await container.repos.chats.getById(params.id)) === null) {
      throw new ResourceNotFoundError('Chat not found');
    }
    const turns = await container.repos.turns.listByChat(params.id);
    const turn = turns.at(-1);
    if (turn === undefined) {
      throw new ResourceNotFoundError('Chat has no turns yet');
    }
    return createSseResponse({
      redis: container.redis,
      streamKey: turnEventsStreamKey(turn.id),
      ...withResumePoint(resumePoint(request, query.from)),
      isFinished: async () => !isLive((await container.repos.turns.get(turn.id))?.status),
      signal: request.signal,
      heartbeatMs: container.sse.heartbeatMs,
      blockMs: container.sse.blockMs,
      logger: container.logger,
    });
  });
}

/**
 * `GET /api/runs/:id/events` — the live events of one scheduled-job run.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns A `text/event-stream` response, or `404` when the run is unknown.
 */
export function runEvents(
  container: ServerContainer,
  request: Request,
  params: EventsParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    const query = parseQuery(request.url, eventsQuery);
    const run = await container.repos.jobRuns.get(params.id);
    if (run === null) {
      throw new ResourceNotFoundError('Run not found');
    }
    return createSseResponse({
      redis: container.redis,
      streamKey: turnEventsStreamKey(run.id),
      ...withResumePoint(resumePoint(request, query.from)),
      isFinished: async () => !isLive((await container.repos.jobRuns.get(run.id))?.status),
      signal: request.signal,
      heartbeatMs: container.sse.heartbeatMs,
      blockMs: container.sse.blockMs,
      logger: container.logger,
    });
  });
}

/**
 * Narrows an optional resume point to a spreadable object.
 *
 * Under `exactOptionalPropertyTypes` an absent resume point has to be an absent property rather
 * than one set to `undefined`, because the two mean different things to the stream factory.
 *
 * @param lastEventId - The resume point, when there is one.
 * @returns `{ lastEventId }` or `{}`.
 */
function withResumePoint(lastEventId: string | undefined): { lastEventId?: string } {
  return lastEventId === undefined ? {} : { lastEventId };
}
