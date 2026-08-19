/**
 * A keyboard-navigable list of chat rows with a roving tabindex.
 *
 * Layer: feature (component).
 *
 * Only one row is in the tab order at a time; Arrow/Home/End move the focus inside the list, as
 * spec 10 §8 requires for sidebar lists.
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';
import { useRef, useState } from 'react';

import { ChatListItem } from './ChatListItem';

/** Props of {@link ChatRovingList}. */
export interface ChatRovingListProps {
  chats: readonly ChatSummary[];
  /** Id of the chat currently open in the main column, if any. */
  activeId: string | null;
  /** Accessible name of the list. */
  label: string;
}

/**
 * Index the given key moves the focus to.
 *
 * @param key - The pressed key.
 * @param current - The currently focused index.
 * @param count - How many rows the list has.
 * @returns The next index, or `null` when the key does not navigate.
 */
function nextIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return Math.min(current + 1, count - 1);
    case 'ArrowUp':
      return Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Renders the rows and owns which of them is reachable with Tab.
 *
 * @param props - The chats, the open chat's id and the list's accessible name.
 */
export function ChatRovingList({ chats, activeId, label }: ChatRovingListProps) {
  const [focused, setFocused] = useState(0);
  const ref = useRef<HTMLUListElement>(null);

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>): void {
    const target = nextIndex(event.key, focused, chats.length);
    if (target === null) {
      return;
    }
    event.preventDefault();
    setFocused(target);
    ref.current?.querySelectorAll('a')[target]?.focus();
  }

  return (
    <ul ref={ref} aria-label={label} className="flex flex-col gap-0.5" onKeyDown={handleKeyDown}>
      {chats.map((chat, index) => (
        <ChatListItem
          key={chat.id}
          chat={chat}
          active={chat.id === activeId}
          tabIndex={index === focused ? 0 : -1}
          onFocus={() => {
            setFocused(index);
          }}
        />
      ))}
    </ul>
  );
}
