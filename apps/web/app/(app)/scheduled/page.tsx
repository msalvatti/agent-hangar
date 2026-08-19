/**
 * Scheduled jobs route — placeholder until the scheduled feature lands.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Scheduled' };

/** Placeholder page for `/scheduled`. */
export default function ScheduledPage() {
  return (
    <section className="px-6 py-10">
      <h1 className="text-[28px] font-semibold tracking-tight" data-testid="placeholder-scheduled">
        Scheduled
      </h1>
    </section>
  );
}
