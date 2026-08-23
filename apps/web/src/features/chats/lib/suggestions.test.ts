/**
 * Tests for the starter suggestions: the fixed set the home screen renders.
 */
import { describe, expect, it } from 'vitest';

import { SUGGESTIONS } from './suggestions';

describe('SUGGESTIONS', () => {
  // The wireframe in spec 10 §4.1 is a four-up grid; the count is part of the layout.
  it('has exactly four entries', () => {
    expect(SUGGESTIONS).toHaveLength(4);
  });

  /**
   * Ids key the React list, so they are written out rather than only counted as distinct: an id
   * that changed — or emptied — makes React tear down and rebuild the card it belonged to, and two
   * cards sharing one collapse into a single rendered node.
   */
  it('names every entry, in display order', () => {
    expect(SUGGESTIONS.map((entry) => entry.id)).toEqual(['explore', 'build', 'review', 'fix']);
  });

  // Every card must carry a title, an icon, one of the four tones and a usable starter prompt.
  it('gives every entry a title, an icon, a tone and a non-empty prompt', () => {
    for (const entry of SUGGESTIONS) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.icon).toBeDefined();
      expect(['accent', 'warning', 'success', 'destructive']).toContain(entry.tone);
      expect(entry.prompt.trim().length).toBeGreaterThan(20);
    }
  });
});
