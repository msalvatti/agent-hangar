/**
 * Scroll container that renders a full transcript: auto-follows the live edge, offers a
 * "Jump to latest" pill when scrolled away, and dispatches each item to its row component.
 *
 * Layer: shared (component).
 *
 * Virtualisation for very long transcripts (> 500 rows) is out of scope here; rows are memoised
 * so a later wave can add it without touching this component's public shape.
 */
'use client';

import { Fragment, memo, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { cn } from '@/shared/lib/cn';

import { assertPresent } from '../lib/assert';
import type { ErrorTranscriptItem, TranscriptItem, TurnPhase } from '../types';

import { AssistantMarkdown } from './AssistantMarkdown';
import { JumpToLatest } from './JumpToLatest';
import { StreamCursor } from './StreamCursor';
import { SystemNotice } from './SystemNotice';
import { ToolCallRow } from './ToolCallRow';
import { UserMessage } from './UserMessage';

/** Distance (px) from the bottom still considered "at the live edge". */
const AT_BOTTOM_THRESHOLD_PX = 24;

/** Props of {@link Transcript}. */
export interface TranscriptProps {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  /** Hides tool Stop buttons when `true` (e.g. an archived chat). */
  readOnly?: boolean;
  /** Called with a tool's `callId` when its Stop button is clicked. */
  onStopTool?: (callId: string) => void;
  /** Shown when `items` is empty and `phase` is `idle` (default: "No messages yet."). */
  emptyText?: string;
  /**
   * Replaces the default presentation of an `error` row, so a caller that has an action to offer
   * (a retry, a link to Settings) renders the failure once, with its buttons attached.
   */
  renderError?: (item: ErrorTranscriptItem) => ReactNode;
  className?: string;
}

interface TranscriptRowProps {
  item: TranscriptItem;
  readOnly: boolean;
  onStopTool: ((callId: string) => void) | undefined;
}

const TranscriptRow = memo(function TranscriptRow({
  item,
  readOnly,
  onStopTool,
}: TranscriptRowProps) {
  switch (item.kind) {
    case 'user':
      return <UserMessage text={item.text} {...(item.at !== undefined ? { at: item.at } : {})} />;
    case 'assistant':
      return <AssistantMarkdown text={item.text} streaming={item.streaming} />;
    case 'tool':
      return (
        <ToolCallRow
          item={item}
          {...(!readOnly && item.status === 'running' && onStopTool !== undefined
            ? {
                onStop: () => {
                  onStopTool(item.callId);
                },
              }
            : {})}
        />
      );
    case 'notice':
      return (
        <SystemNotice
          tone={item.tone}
          text={item.text}
          {...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {})}
        />
      );
    case 'error':
      return <ErrorCard title="Error" message={item.message} code={item.code} variant="compact" />;
  }
});

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_THRESHOLD_PX;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Renders a full transcript with auto-follow scrolling.
 *
 * @param props - Items, turn phase, read-only flag, stop handler, empty text.
 */
export function Transcript({
  items,
  phase,
  readOnly = false,
  onStopTool,
  emptyText = 'No messages yet.',
  renderError,
  className,
}: TranscriptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  function handleScroll(): void {
    // Always attached: this only runs as the onScroll handler of the element the ref points to.
    setAtBottom(
      isAtBottom(assertPresent(containerRef.current, 'Transcript container ref not attached')),
    );
  }

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (element !== null && atBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }, [items, atBottom]);

  function jumpToLatest(): void {
    // Always attached here: this only runs from the Jump-to-latest button's onClick, and that
    // button is rendered inside this same container element.
    const element = assertPresent(containerRef.current, 'Transcript container ref not attached');
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    setAtBottom(true);
  }

  const isEmpty = items.length === 0;
  const lastItem = items[items.length - 1];
  const isLastItemStreamingAssistant = lastItem?.kind === 'assistant' && lastItem.streaming;
  const showBareCursor =
    (phase === 'preparing' || phase === 'running') && !isLastItemStreamingAssistant;

  return (
    <div
      ref={containerRef}
      data-testid="transcript"
      role="region"
      aria-label="Transcript"
      onScroll={handleScroll}
      className={cn('relative h-full overflow-y-auto', className)}
    >
      <div className="mx-auto flex max-w-210 flex-col gap-4 px-6 py-4">
        {isEmpty && phase === 'idle' ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{emptyText}</p>
        ) : (
          items.map((item) =>
            // Handled here rather than inside the memoized row so a caller-supplied renderer, whose
            // closure changes identity every render, cannot defeat the memoization of every other
            // row in the list.
            item.kind === 'error' && renderError !== undefined ? (
              <Fragment key={item.id}>{renderError(item)}</Fragment>
            ) : (
              <TranscriptRow
                key={item.id}
                item={item}
                readOnly={readOnly}
                onStopTool={onStopTool}
              />
            ),
          )
        )}
        {showBareCursor && <StreamCursor />}
      </div>
      {!atBottom && items.length > 0 && <JumpToLatest onClick={jumpToLatest} />}
    </div>
  );
}
