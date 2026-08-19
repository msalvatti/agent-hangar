/**
 * TypeScript types of the agent protocol, derived from the Zod schemas in `./schemas.ts`.
 *
 * Layer: contract.
 */
import type { z } from 'zod';

import type {
  agentEventSchema,
  conversationItemSchema,
  protocolErrorEventSchema,
  protocolErrorReasonSchema,
  toolNameSchema,
  toolResultStatusSchema,
  turnLimitsSchema,
  turnRepoSchema,
  turnRequestSchema,
  turnUsageSchema,
} from './schemas.js';

/** Tools the agent runtime exposes to the model. */
export type ToolName = z.infer<typeof toolNameSchema>;

/** One conversation item as carried by the protocol (structurally equal to the model contract's). */
export type ProtocolConversationItem = z.infer<typeof conversationItemSchema>;

/** Repository section of a {@link TurnRequest}. */
export type TurnRepo = z.infer<typeof turnRepoSchema>;

/** Limits section of a {@link TurnRequest}. */
export type TurnLimits = z.infer<typeof turnLimitsSchema>;

/** Token usage reported at the end of a turn. */
export type TurnUsage = z.infer<typeof turnUsageSchema>;

/** The single object written to the runtime's stdin. */
export type TurnRequest = z.infer<typeof turnRequestSchema>;

/** Result status of a tool call. */
export type ToolResultStatus = z.infer<typeof toolResultStatusSchema>;

/** Every event the runtime streams on stdout. */
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** Discriminator values of {@link AgentEvent}. */
export type AgentEventType = AgentEvent['type'];

/** Why the NDJSON parser rejected a line. */
export type ProtocolErrorReason = z.infer<typeof protocolErrorReasonSchema>;

/** The event the NDJSON parser yields for an invalid line. */
export type ProtocolErrorEvent = z.infer<typeof protocolErrorEventSchema>;

/** Narrows an {@link AgentEvent} union to one variant by its `type`. */
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
