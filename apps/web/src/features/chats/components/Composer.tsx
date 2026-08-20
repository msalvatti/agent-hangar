/**
 * The prompt composer: repository and branch pickers, an auto-growing textarea, the model label
 * and the Send button.
 *
 * Layer: feature (component).
 *
 * One component serves both placements: `new` on the home screen (with the pickers, because the
 * repository is still being chosen) and `followup` inside a chat (without them, because the chat
 * already has one). The two placements are a discriminated union rather than optional props, so
 * a `new` composer cannot be rendered without the selection it needs to submit.
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import { ArrowUp, Loader2 } from 'lucide-react';
import type { RefObject } from 'react';
import { useId, useRef } from 'react';

import { cn } from '@/shared/lib/cn';
import { BranchPicker, RepoPicker } from '@/shared/repo-picker';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { Textarea } from '@/shared/ui/textarea';

import { useAutogrow } from '../hooks/useAutogrow';

/** Where the composer is placed, which decides whether the pickers are shown. */
export type ComposerMode = 'new' | 'followup';

/** Props shared by both placements. */
export interface ComposerBaseProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Locks the composer while a request is in flight and shows a spinner in Send. */
  busy?: boolean;
  /** Locks the composer for a reason other than a request (e.g. an archived chat). */
  disabled?: boolean;
  /** Model id shown bottom-left; `undefined` renders a skeleton, `null` renders nothing. */
  model?: string | null | undefined;
  placeholder?: string;
  /** Lets the parent focus the textarea (e.g. after a suggestion card is clicked). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  className?: string;
}

/** Props of {@link Composer}. */
export type ComposerProps = ComposerBaseProps &
  (
    | {
        mode: 'new';
        /** The chosen repository, or `null` while none is chosen. */
        repo: RepoSummary | null;
        onRepoChange: (repo: RepoSummary | null) => void;
        /** The chosen branch, or `null` until the picker defaults it. */
        branch: string | null;
        onBranchChange: (branch: string) => void;
      }
    | { mode: 'followup' }
  );

/** Props of {@link ComposerTargets}. */
interface ComposerTargetsProps {
  repo: RepoSummary | null;
  onRepoChange: (repo: RepoSummary | null) => void;
  branch: string | null;
  onBranchChange: (branch: string) => void;
  disabled: boolean;
}

/**
 * The top row of a `new` composer: which repository and which branch the chat starts from.
 *
 * @param props - The current selection, its handlers and the lock state.
 */
function ComposerTargets({
  repo,
  onRepoChange,
  branch,
  onBranchChange,
  disabled,
}: ComposerTargetsProps) {
  const fullName = repo?.fullName ?? null;
  return (
    <div className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <RepoPicker value={fullName} disabled={disabled} onChange={onRepoChange} />
      <BranchPicker
        repo={fullName}
        defaultBranch={repo?.defaultBranch ?? null}
        value={branch}
        disabled={disabled}
        onChange={onBranchChange}
      />
    </div>
  );
}

/** Placeholder per placement. */
const PLACEHOLDER: Record<ComposerMode, string> = {
  new: 'Describe a task or ask a question…',
  followup: 'Describe the next step…',
};

/**
 * What is still missing, one sentence per thing that can hold Send shut.
 *
 * Each names the specific thing rather than the form as a whole. "Complete the form" would leave
 * somebody who has chosen a repository and cannot get a branch exactly as stuck as no message at
 * all — and that is the case people actually hit, because a repository with no branch has none for
 * the picker to default to.
 */
const SUBMIT_HINT = {
  repo: 'Choose a repository to start this chat from.',
  branch:
    'Choose a branch to start from. A repository with no branches has none to choose, and cannot be used until a branch is pushed to it.',
  prompt: 'Write a prompt to send.',
} as const;

/**
 * Why the composer cannot send yet.
 *
 * The Send button's `disabled` state is derived from this same answer rather than from a parallel
 * condition, so the button and its explanation cannot drift apart: whatever shuts the button is by
 * construction the thing the user is told about.
 *
 * A locked composer returns nothing. Being busy is already shown by the spinner, and the reason a
 * composer is `disabled` — an archived chat — is stated by the banner above it; repeating either
 * one here would announce a change that has not happened.
 *
 * The checks run in the order the composer is filled in, and only the first is reported: with no
 * repository chosen there is no branch either, and naming both would bury the one action to take.
 *
 * @param props - The composer's props, whose placement decides whether targets are required.
 * @param locked - Whether the composer is busy or externally disabled.
 * @returns The sentence to announce, or `null` when nothing is missing.
 */
function submitBlockedReason(props: ComposerProps, locked: boolean): string | null {
  if (locked) {
    return null;
  }
  // Gated on the placement, not merely on the value: a follow-up inherits the chat's repository
  // and branch, so telling that user to choose a repository would be wrong as well as useless.
  if (props.mode === 'new' && props.repo === null) {
    return SUBMIT_HINT.repo;
  }
  if (props.mode === 'new' && props.branch === null) {
    return SUBMIT_HINT.branch;
  }
  if (props.value.trim().length === 0) {
    return SUBMIT_HINT.prompt;
  }
  return null;
}

/**
 * Renders the composer and reports submissions.
 *
 * @param props - Placement, repository/branch selection, value, handlers and lock state.
 */
export function Composer(props: ComposerProps) {
  const {
    value,
    onChange,
    onSubmit,
    busy = false,
    disabled = false,
    model,
    placeholder,
    textareaRef,
    className,
  } = props;
  const promptId = useId();
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? fallbackRef;
  useAutogrow(ref, value);

  const locked = busy || disabled;
  const blockedReason = submitBlockedReason(props, locked);
  const canSubmit = !locked && blockedReason === null;
  const hintId = `${promptId}-submit-hint`;

  function submit(): void {
    if (canSubmit) {
      onSubmit();
    }
  }

  return (
    <div className={cn('border-input bg-card w-full rounded-xl border', className)}>
      {props.mode === 'new' && (
        <ComposerTargets
          repo={props.repo}
          onRepoChange={props.onRepoChange}
          branch={props.branch}
          onBranchChange={props.onBranchChange}
          disabled={locked}
        />
      )}
      <label className="sr-only" htmlFor={promptId}>
        Prompt
      </label>
      <Textarea
        id={promptId}
        ref={ref}
        rows={1}
        value={value}
        disabled={locked}
        placeholder={placeholder ?? PLACEHOLDER[props.mode]}
        // Announced with the field, so the key that sends is discoverable without seeing the Send
        // button's tooltip.
        aria-keyshortcuts="Enter"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter sends and Shift+Enter inserts a newline, which is the arrangement of every chat
          // this one is read as. ⌘/Ctrl+Enter keeps working: it is the combination the Send
          // button's own tooltip taught, and a shortcut that is withdrawn without notice is worse
          // than one that is merely no longer the shortest path.
          //
          // `isComposing` is what keeps this usable with an input method: while a candidate is
          // being chosen, Enter commits the candidate and nothing else, so acting on it here would
          // send half a word in every language that needs an IME to type.
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          submit();
        }}
        className="min-h-0 resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center justify-end gap-3 px-3 pb-2">
        {/*
          Rendered in every state, empty when there is nothing to say. A live region has to be in
          the document before its content changes for the change to be announced, so this element
          may not appear and disappear with the message it carries.

          It is also the reason a `title` on the button is not the answer: a disabled button does
          not reliably emit the pointer events a native tooltip needs, so the one state that most
          needs explaining is the state where the tooltip never shows. The button points at this
          element with `aria-describedby` instead — the same wiring the dialog fields use — so the
          reason is part of the control rather than merely next to it.
        */}
        <p id={hintId} role="status" className="text-muted-foreground mr-auto text-xs">
          {blockedReason}
        </p>
        {model === undefined && <Skeleton className="h-4 w-24" data-testid="model-skeleton" />}
        {typeof model === 'string' && (
          <span className="text-muted-foreground font-mono text-xs">{model}</span>
        )}
        <Button
          type="button"
          size="icon"
          aria-label="Send"
          title="Send (↵)"
          aria-describedby={blockedReason === null ? undefined : hintId}
          disabled={!canSubmit}
          onClick={submit}
          className="size-10 cursor-pointer rounded-full"
        >
          {busy ? (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : (
            <ArrowUp aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
