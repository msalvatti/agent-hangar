/**
 * The shape a chat takes once it has loaded, shared by the screen and its inner view.
 *
 * Layer: feature (types).
 */
import type { ChatSummary } from '@agent-hangar/core';

import type { MappedChat } from '../lib/map-chat-detail';

/** A chat whose detail request succeeded. */
export interface LoadedChat {
  chat: ChatSummary;
  mapped: MappedChat;
  /** Newest persisted turn, which is the one a failure loaded from history belongs to. */
  lastTurnId: string | null;
  refetch: () => Promise<void>;
}
