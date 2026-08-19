/**
 * One chat row of the sidebar list.
 *
 * Layer: feature (component).
 */
import type { ChatSummary } from '@agent-hangar/core';
import Link from 'next/link';

import { cn } from '@/shared/lib/cn';

/** How the trailing dot renders per last-turn status. */
const DOT_BY_STATUS = {
  QUEUED: { className: 'bg-accent animate-pulse motion-reduce:animate-none', label: 'queued' },
  PREPARING: {
    className: 'bg-accent animate-pulse motion-reduce:animate-none',
    label: 'preparing',
  },
  RUNNING: { className: 'bg-accent animate-pulse motion-reduce:animate-none', label: 'running' },
  FAILED: { className: 'bg-destructive', label: 'failed' },
} as const;

/** Last-turn statuses that show a dot. */
type DottedStatus = keyof typeof DOT_BY_STATUS;

/**
 * Whether a chat's last turn status has a dot.
 *
 * @param status - The chat's `lastTurnStatus`.
 * @returns `true` when a dot should be shown.
 */
function hasDot(status: ChatSummary['lastTurnStatus']): status is DottedStatus {
  return status !== null && status in DOT_BY_STATUS;
}

/** Props of {@link ChatListItem}. */
export interface ChatListItemProps {
  chat: ChatSummary;
  /** `true` when this chat is the one open in the main column. */
  active: boolean;
  /** Roving tabindex: only the focused row is reachable with Tab. */
  tabIndex: number;
  onFocus: () => void;
}

/**
 * A 36 px row: the truncated title plus a status dot with text for assistive technology.
 *
 * @param props - The chat, whether it is open, and the roving tabindex wiring.
 */
export function ChatListItem({ chat, active, tabIndex, onFocus }: ChatListItemProps) {
  const dot = hasDot(chat.lastTurnStatus) ? DOT_BY_STATUS[chat.lastTurnStatus] : null;
  return (
    <li role="listitem">
      <Link
        href={`/chats/${chat.id}`}
        tabIndex={tabIndex}
        onFocus={onFocus}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'focus-visible:ring-ring flex h-9 items-center gap-2 rounded-lg px-2 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none',
          active ? 'bg-muted' : 'hover:bg-muted/60',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
        {dot !== null && (
          <>
            <span
              aria-hidden="true"
              className={cn('size-1.5 shrink-0 rounded-full', dot.className)}
            />
            <span className="sr-only">{dot.label}</span>
          </>
        )}
      </Link>
    </li>
  );
}
