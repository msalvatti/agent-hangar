/**
 * One tool call: a collapsed single-line summary that expands into redacted arguments and
 * capped output.
 *
 * Layer: shared (component).
 */
'use client';

import { ChevronRight, Square } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/shared/ui/collapsible';

import { useElapsed } from '../hooks/useElapsed';
import { formatBytes, formatDuration } from '../lib/format';
import { toDisplayJson } from '../lib/redact-display';
import { summarizeArgs } from '../lib/summarize-args';
import type { ToolTranscriptItem } from '../types';

import { CopyButton } from './CopyButton';

/** Props of {@link ToolCallRow}. */
export interface ToolCallRowProps {
  item: ToolTranscriptItem;
  /** Expanded on first render (default collapsed, per spec 10 §4.2). */
  defaultOpen?: boolean;
  /** Present only while `item.status === 'running'`: renders a Stop icon button. */
  onStop?: () => void;
  className?: string;
}

function StatusMeta({ item, elapsed }: { item: ToolTranscriptItem; elapsed: string }) {
  switch (item.status) {
    case 'running':
      return (
        <>
          <span
            aria-hidden="true"
            className="bg-accent size-1.5 animate-pulse rounded-full motion-reduce:animate-none"
          />
          <span>{elapsed}</span>
        </>
      );
    case 'succeeded':
      return (
        <span>
          exit {item.exitCode} · {formatDuration(item.durationMs ?? 0)}
          {item.name === 'write_file' && item.totalBytes !== null
            ? ` · ${formatBytes(item.totalBytes)}`
            : ''}
        </span>
      );
    case 'failed':
      return (
        <span className="text-destructive">
          exit {item.exitCode} · {formatDuration(item.durationMs ?? 0)}
        </span>
      );
    case 'timed_out':
      return <span className="text-destructive">timed out</span>;
  }
}

/**
 * One collapsible row per tool call. Expanded content shows redacted arguments and the first
 * {@link TOOL_OUTPUT_DISPLAY_LIMIT_BYTES} of output; a footer names the remainder when the
 * runtime produced more than what is shown.
 */
export function ToolCallRow({ item, defaultOpen = false, onStop, className }: ToolCallRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const elapsed = useElapsed(item.startedAt, item.status === 'running');
  const summary = summarizeArgs(item.name, item.args);
  const outputText = item.stdout + item.stderr;
  const isTruncated = item.totalBytes !== null && item.totalBytes > item.shownBytes;

  return (
    <div
      data-item-kind="tool"
      data-tool-status={item.status}
      className={cn('text-[13px]', className)}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="hover:bg-muted/50 flex h-11 items-center gap-2 rounded-md px-2 transition-colors">
          <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                'size-3.5 shrink-0 transition-transform duration-150',
                open && 'rotate-90',
              )}
            />
            <span className="text-accent shrink-0 font-mono">{item.name}</span>
            <span className="text-muted-foreground truncate">{summary}</span>
          </CollapsibleTrigger>
          <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            <StatusMeta item={item} elapsed={elapsed} />
            {item.status === 'running' && onStop !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Stop tool"
                onClick={onStop}
              >
                <Square aria-hidden="true" />
              </Button>
            )}
          </span>
        </div>
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] data-closed:h-0 motion-reduce:transition-none">
          <div className="space-y-3 px-2 py-2">
            <section>
              <h4 className="text-muted-foreground mb-1 text-[11px] tracking-[0.06em] uppercase">
                Arguments
              </h4>
              <pre className="bg-muted overflow-x-auto rounded p-2 font-mono text-[13px]">
                {toDisplayJson(item.args)}
              </pre>
            </section>
            <section>
              <div className="mb-1 flex items-center justify-between">
                <h4 className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
                  Output
                </h4>
                {outputText.length > 0 && <CopyButton value={outputText} label="Copy output" />}
              </div>
              {outputText.length === 0 ? (
                <p className="text-muted-foreground">No output.</p>
              ) : (
                <div
                  role="log"
                  aria-live="polite"
                  className="bg-muted max-h-104 overflow-y-auto rounded p-2 font-mono text-[13px] leading-[1.6]"
                >
                  {item.stdout.length > 0 && (
                    <pre className="whitespace-pre-wrap">{item.stdout}</pre>
                  )}
                  {item.stderr.length > 0 && (
                    <pre className="border-destructive border-l-2 pl-2 whitespace-pre-wrap">
                      {item.stderr}
                    </pre>
                  )}
                </div>
              )}
              {isTruncated && item.totalBytes !== null && (
                <p className="text-muted-foreground mt-1 text-[11px]">
                  truncated — {formatBytes(item.totalBytes)} total
                </p>
              )}
            </section>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
