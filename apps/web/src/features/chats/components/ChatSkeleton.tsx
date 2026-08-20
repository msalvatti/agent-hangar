/**
 * Layout-matching placeholder shown while a chat loads.
 *
 * Layer: feature (component).
 */
import { Skeleton } from '@/shared/ui/skeleton';

/** How many transcript blocks the placeholder reserves. */
const BLOCKS = 3;

/**
 * Reserves the header row and three transcript blocks so the page does not shift on arrival.
 */
export function ChatSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="chat-skeleton">
      <Skeleton className="h-12 w-full rounded-none" />
      <div className="flex flex-col gap-4 px-6">
        {Array.from({ length: BLOCKS }, (_unused, index) => (
          <Skeleton key={index} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}
