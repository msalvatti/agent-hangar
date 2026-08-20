/**
 * Tests for the root route.
 *
 * Layer: unit.
 * Goal: `/` is not a screen of its own — it hands the reader to the composition that starts a chat.
 * Mocks: `next/navigation`, whose `redirect` throws in the app the same way it does here.
 */
import { describe, expect, it, vi } from 'vitest';

import HomePage from './page';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect }));

describe('HomePage', () => {
  /**
   * Opening the app lands on the new-chat composition rather than on an index of chats: the
   * product's first action is asking something, and the chat list is already in the sidebar.
   * `redirect` throws to unwind the render, which is why the route is typed as returning `never`
   * and why nothing may follow the call.
   */
  it('sends the root path to the new-chat composition', () => {
    expect(() => HomePage()).toThrow('NEXT_REDIRECT:/chats/new');
    expect(redirect).toHaveBeenCalledWith('/chats/new');
  });
});
