/**
 * Chat route.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

import { ChatView } from '@/features/chats';

export const metadata: Metadata = { title: 'Chat' };

/**
 * Renders one chat.
 *
 * @param props - Route params (`id`).
 */
export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView chatId={id} />;
}
