/**
 * Root route: the home of the app is the new-chat composition.
 *
 * Layer: screen.
 */
import { redirect } from 'next/navigation';

/** Redirects `/` to `/chats/new`. */
export default function HomePage(): never {
  redirect('/chats/new');
}
