/**
 * New chat route (home) — placeholder until the chats feature lands.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'New chat' };

/** Placeholder page for `/chats/new`. */
export default function NewChatPage() {
  return (
    <section className="mx-auto max-w-210 px-6 py-10">
      <h1 className="text-[28px] font-semibold tracking-tight" data-testid="placeholder-chats-new">
        New chat
      </h1>
    </section>
  );
}
