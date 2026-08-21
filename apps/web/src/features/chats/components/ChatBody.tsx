/**
 * Everything below the chat header: the transcript, the failure card and the follow-up composer.
 *
 * Layer: feature (component).
 */
'use client';

import type { RefObject } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { useHealth } from '@/shared/health';
import { Transcript } from '@/shared/transcript';
import type { TranscriptItem, TurnPhase } from '@/shared/transcript';

import { Composer } from './Composer';
import { InfraDownNotice } from './InfraDownNotice';
import { TurnErrorCard } from './TurnErrorCard';

/** Props of {@link ChatBody}. */
export interface ChatBodyProps {
  items: readonly TranscriptItem[];
  phase: TurnPhase;
  /** `true` for an archived chat: the transcript is read-only and the composer is locked. */
  archived: boolean;
  onRetry: () => void;
  /** `true` while a retry request is in flight, which disables the Retry button. */
  retrying: boolean;
  /**
   * Turn whose failure row may still be acted on, or `null` when the chat has no turn to retry.
   *
   * A reloaded chat rebuilds a failure row for every turn that failed, and the API accepts a retry
   * only for the newest one — every other id is answered `TURN_NOT_RETRYABLE`. So the older rows
   * report what happened and offer nothing, and this is what tells them apart.
   */
  retryableTurnId: string | null;
  /** Lets the header scroll the failure card into view. */
  errorRef: RefObject<HTMLDivElement | null>;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSubmit: () => void;
  /** `true` while the follow-up is being posted, or the retry request is in flight. */
  sending: boolean;
  /**
   * Why the last send or retry request itself was refused, or `undefined` when none was.
   *
   * Distinct from an `error` row of the transcript, which reports a turn that ran and failed. This
   * one is the request never having been accepted, so there is no turn to attach it to and nothing
   * else on screen would change — without it, pressing Send or Retry against a missing credential
   * would look like nothing at all had happened.
   */
  actionError: string | undefined;
  /** `true` while a turn is still producing events, which locks the composer. */
  turnLive: boolean;
  /** Model id shown in the composer; `undefined` renders a skeleton. */
  model: string | undefined;
}

/**
 * Renders the scrolling transcript, any turn failure, and the composer that continues the chat.
 *
 * A failure is one row of the transcript, live or reloaded from history, so it is rendered there
 * and nowhere else. The chat's newest failure carries the retry and the code-specific next step,
 * which is what makes a failed turn actionable again after a reload; an earlier turn's failure is
 * history and is rendered as the record of it, because retrying it is not something the API
 * allows and a button that is refused is worse than no button.
 *
 * Infrastructure that is down locks the composer and says which dependency is missing. An archived
 * chat is not told: its composer is already locked for a reason of its own, and the banner above
 * states it.
 *
 * @param props - The transcript, the draft and the lock state.
 */
export function ChatBody({
  items,
  phase,
  archived,
  onRetry,
  retrying,
  retryableTurnId,
  errorRef,
  draft,
  onDraftChange,
  onSubmit,
  sending,
  actionError,
  turnLive,
  model,
}: ChatBodyProps) {
  const health = useHealth();
  // A report that has not arrived yet leaves the composer open: the send itself is what proves
  // the environment, and locking on an unanswered probe would block a working instance.
  const infraDown = health.data !== undefined && health.failingChecks.length > 0;

  return (
    <>
      <Transcript
        items={items}
        phase={phase}
        readOnly={archived}
        className="min-h-0 flex-1"
        renderError={(item) =>
          // `undefined` is a row the live stream produced, and the stream follows one turn: the
          // one that is still there to retry.
          item.turnId === undefined || item.turnId === retryableTurnId ? (
            <div ref={errorRef}>
              <TurnErrorCard error={item} onRetry={onRetry} busy={retrying} />
            </div>
          ) : (
            <ErrorCard title="Error" message={item.message} code={item.code} variant="compact" />
          )
        }
      />
      <div className="px-6 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {actionError !== undefined && (
          <ErrorCard
            title="Could not start the turn"
            message={actionError}
            variant="compact"
            className="mb-2"
          />
        )}
        {!archived && <InfraDownNotice failing={health.failingChecks} className="mb-2" />}
        <Composer
          mode="followup"
          value={draft}
          onChange={onDraftChange}
          onSubmit={onSubmit}
          busy={sending}
          disabled={archived || turnLive || infraDown}
          model={model}
        />
      </div>
    </>
  );
}
