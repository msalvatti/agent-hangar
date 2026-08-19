/**
 * Chat route — placeholder until the chats feature lands.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Chat' };

/**
 * Placeholder page for `/chats/:id`.
 *
 * @param props - Route params (`id`).
 */
export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section className="mx-auto max-w-210 px-6 py-10">
      <h1 className="text-[28px] font-semibold tracking-tight" data-testid="placeholder-chats-id">
        Chat
      </h1>
      <p className="text-muted-foreground mt-2 font-mono text-[13px]">{id}</p>
    </section>
  );
}
