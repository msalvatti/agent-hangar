/**
 * The chat title in the header, editable in place.
 *
 * Layer: feature (component).
 */
'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Input } from '@/shared/ui/input';

/** Longest title the contract accepts. */
const MAX_TITLE_LENGTH = 120;

/** Props of {@link ChatTitle}. */
export interface ChatTitleProps {
  title: string;
  /** `false` for an archived chat, which is read-only. */
  editable: boolean;
  onRename: (title: string) => Promise<void>;
  /** `true` while a rename is in flight. */
  busy?: boolean;
}

/**
 * Shows the title and, when editable, swaps it for an input on click or F2.
 *
 * Enter saves a trimmed, non-empty title; Escape restores the original; blurring saves too, so a
 * click elsewhere does not silently discard the edit.
 *
 * @param props - Title, whether it can be edited, the rename handler and its busy flag.
 */
export function ChatTitle({ title, editable, onRename, busy = false }: ChatTitleProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  function startEditing(): void {
    setDraft(title);
    setEditing(true);
  }

  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (next.length > 0 && next !== title) {
      void onRename(next);
    }
  }

  if (!editable) {
    return <h1 className="truncate text-[15px] font-semibold">{title}</h1>;
  }

  if (editing) {
    return (
      <Input
        autoFocus
        aria-label="Chat title"
        maxLength={MAX_TITLE_LENGTH}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            setEditing(false);
          }
        }}
        className="h-7 max-w-80"
      />
    );
  }

  return (
    <h1 className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold">
      <button
        type="button"
        onClick={startEditing}
        onKeyDown={(event) => {
          if (event.key === 'F2') {
            startEditing();
          }
        }}
        className="hover:bg-muted focus-visible:ring-ring cursor-pointer truncate rounded px-1 transition-colors duration-150 focus-visible:ring-2 focus-visible:outline-none"
      >
        {title}
      </button>
      {busy && (
        <Loader2 aria-hidden="true" className="text-muted-foreground size-3.5 animate-spin" />
      )}
    </h1>
  );
}
