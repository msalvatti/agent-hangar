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
      <BranchPicker repo={fullName} value={branch} disabled={disabled} onChange={onBranchChange} />
    </div>
  );
}

/** Placeholder per placement. */
const PLACEHOLDER: Record<ComposerMode, string> = {
  new: 'Describe a task or ask a question…',
  followup: 'Describe the next step…',
};

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
  const missingTarget = props.mode === 'new' && (props.repo === null || props.branch === null);
  const canSubmit = !locked && value.trim().length > 0 && !missingTarget;

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
        onChange={(event) => {
          onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
        className="min-h-0 resize-none border-0 bg-transparent px-3 py-2.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center justify-end gap-3 px-3 pb-2">
        {model === undefined && <Skeleton className="h-4 w-24" data-testid="model-skeleton" />}
        {typeof model === 'string' && (
          <span className="text-muted-foreground font-mono text-xs">{model}</span>
        )}
        <Button
          type="button"
          size="icon"
          aria-label="Send"
          title="Send (⌘↵)"
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
