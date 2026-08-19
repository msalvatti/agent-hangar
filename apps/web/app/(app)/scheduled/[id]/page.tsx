/**
 * Scheduled job detail route — placeholder until the scheduled feature lands.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Scheduled job' };

/**
 * Placeholder page for `/scheduled/:id`.
 *
 * @param props - Route params (`id`).
 */
export default async function ScheduledJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section className="px-6 py-10">
      <h1
        className="text-[28px] font-semibold tracking-tight"
        data-testid="placeholder-scheduled-id"
      >
        Scheduled job
      </h1>
      <p className="text-muted-foreground mt-2 font-mono text-[13px]">{id}</p>
    </section>
  );
}
