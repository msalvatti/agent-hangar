/**
 * Telling an infrastructure failure apart from a failure of the work itself, and from a row that a
 * concurrent delete removed.
 *
 * Layer: utility.
 *
 * The distinction decides whether a processor rejects or resolves, and rejecting is about who is
 * told rather than about running the work again: nothing redelivers a rejected job here.
 * `attempts` defaults to zero, no producer sets it and no default job options are declared, so the
 * only redelivery configured anywhere is stalled recovery, for a job whose worker stopped renewing
 * its lock. A Docker daemon that is not listening is therefore reported as a failed job, which is
 * how the operator learns the daemon is down and is not something the user did; a runtime that
 * exited non-zero is a result of the work itself, so the job resolves and the turn carries the
 * failure. Either way the turn is recorded and its stream is ended before the processor returns —
 * a rejection that left the turn open would strand it, because no second delivery is coming.
 *
 * Security: classification is a membership test against literals written in this file. No pattern
 * can separate a driver code from a credential — `SUPERSECRETPW` is as much a bare identifier as
 * `ECONNREFUSED` — so nothing carried in by the error is ever echoed, only matched.
 */
import { NotFoundError } from '@agent-hangar/core';

/**
 * Error codes that mean the worker could not reach the Docker daemon.
 *
 * These are the errnos a local socket connection produces: the daemon is down, the socket path is
 * wrong, the user is not in the `docker` group, or the connection dropped mid-request. A remote
 * daemon adds the DNS and routing errnos.
 *
 * Typed over `unknown` so that membership is the only narrowing: a `code` that is not a string is
 * simply not in the set, and no separate type test exists alongside it whose removal would leave
 * every answer unchanged.
 */
export const TRANSPORT_ERROR_CODES: ReadonlySet<unknown> = new Set([
  'EACCES',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

/** How far the `cause` chain is walked; a cycle or a deep chain must not hang the worker. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Reads the `code` a rejected value offers, without trusting it to be readable.
 *
 * Read through the property descriptor rather than through the property: a `code` defined as a
 * getter is never invoked, so a hostile value gets no chance to run code here — and what such a
 * getter throws could itself be the driver error carrying the connection string. That is the whole
 * of the defence, and it needs no `try`: a descriptor read answers for a string, a number and an
 * object alike, and the two values it refuses — `null` and `undefined` — are named below. What is
 * left is a `Proxy` whose own descriptor trap throws, and nothing in this worker's reach produces
 * one: every failure classified here comes from dockerode, Prisma, BullMQ or Node itself.
 *
 * @param error - The value something rejected with.
 * @returns Its `code`, whatever type it turns out to be, or `undefined`.
 */
function readCode(error: unknown): unknown {
  return error === null || error === undefined
    ? undefined
    : Object.getOwnPropertyDescriptor(error, 'code')?.value;
}

/**
 * Reports whether a failure is the infrastructure being unreachable.
 *
 * Walks the `cause` chain, because the Docker runner wraps daemon failures in its own typed error
 * and puts the socket error underneath.
 *
 * @param error - The value a runner call rejected with.
 * @returns `true` when the worker should reject the job, reporting infrastructure rather than
 *   work; nothing redelivers it.
 */
export function isTransportError(error: unknown): boolean {
  let current: unknown = error;
  // The depth is the only bound. A chain that ends early carries `undefined` from there on, which
  // is in neither the set nor the `Error` branch below, so the remaining turns of the loop are
  // decided by the same two tests as every other one rather than by a third test of their own.
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (TRANSPORT_ERROR_CODES.has(readCode(current))) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Reports whether a failure is exactly "the row this write named is no longer there".
 *
 * The entity and the identifier are compared, never only the error type: a not-found raised about
 * some other row is a failure like any other, and treating it as the expected one would swallow
 * a write that went to the wrong place. It is the same test `handlers/jobs.ts` applies before it
 * calls a delete already done.
 *
 * @param error - The value a repository rejected with.
 * @param entity - Entity type the caller was writing to, e.g. `ScheduledJob`.
 * @param id - Identifier the caller named.
 * @returns `true` when the repository reported that exact row as missing.
 */
export function isMissingRow(error: unknown, entity: string, id: string): boolean {
  return error instanceof NotFoundError && error.entity === entity && error.id === id;
}
