/**
 * New chat route (home).
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

import { NewChatView } from '@/features/chats';

export const metadata: Metadata = { title: 'New chat' };

/** Renders the home composition. */
export default function NewChatPage() {
  return <NewChatView />;
}
