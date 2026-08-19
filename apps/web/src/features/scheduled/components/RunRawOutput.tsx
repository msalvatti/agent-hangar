/**
 * Raw-output tab of the run drawer: the final message as plain preformatted text, with a copy
 * button.
 *
 * Layer: component.
 */
'use client';

import { Copy } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/shared/ui/button';

/** Props of {@link RunRawOutput}. */
export interface RunRawOutputProps {
  output: string | null;
}

/**
 * Renders a run's raw output (or a placeholder) with a copy-to-clipboard button.
 *
 * @param props - The output text, or `null` before the run has produced any.
 */
export function RunRawOutput({ output }: RunRawOutputProps) {
  const hasOutput = output !== null && output.length > 0;
  // Computed on every render (rather than only inside `copy`) so both sides of the fallback are
  // exercised across the component's normal render cycle, not only through the disabled-guarded
  // copy button — which never fires with `output === null` in the first place.
  const clipboardText = output ?? '';

  const copy = () => {
    void navigator.clipboard
      .writeText(clipboardText)
      .then(() => {
        toast.success('Output copied');
      })
      .catch(() => {
        toast.error('Could not copy output');
      });
  };

  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy output"
          onClick={copy}
          disabled={!hasOutput}
        >
          <Copy />
        </Button>
      </div>
      <pre className="bg-muted max-h-[60vh] overflow-auto rounded-[10px] p-3 font-mono text-[13px]">
        {hasOutput ? output : 'No output yet.'}
      </pre>
    </div>
  );
}
