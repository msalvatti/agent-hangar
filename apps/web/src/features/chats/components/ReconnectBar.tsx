/**
 * Thin bar shown while the event stream is reconnecting.
 *
 * Layer: feature (component).
 */
import { Loader2 } from 'lucide-react';

/**
 * A quiet, non-blocking notice: the replay fills the gap silently once the stream is back.
 */
export function ReconnectBar() {
  return (
    <div
      role="status"
      className="bg-warning/15 text-warning flex items-center justify-center gap-1.5 px-3 py-1 text-xs transition-opacity duration-200"
    >
      <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
      Reconnecting…
    </div>
  );
}
