/**
 * The four starter suggestions shown above the composer on the home screen.
 *
 * Layer: feature (lib).
 *
 * Each card carries the only decorative colour in the app (spec 10 §4.1): a Lucide icon tinted
 * with one status hue at 80 % opacity.
 */
import type { LucideIcon } from 'lucide-react';
import { Bug, Compass, GitPullRequestArrow, Hammer } from 'lucide-react';

/** Colour a suggestion card tints its icon with. */
export type SuggestionTone = 'accent' | 'warning' | 'success' | 'destructive';

/** One starter suggestion. */
export interface Suggestion {
  id: string;
  title: string;
  icon: LucideIcon;
  tone: SuggestionTone;
  /** Text the composer is filled with when the card is clicked. */
  prompt: string;
}

/** The four suggestions, in display order. */
export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'explore',
    title: 'Explore and understand code',
    icon: Compass,
    tone: 'accent',
    prompt:
      'Give me a tour of this repository. Start with how the code is organised, then walk me through the path a request takes from entry point to storage.',
  },
  {
    id: 'build',
    title: 'Build a new feature or tool',
    icon: Hammer,
    tone: 'warning',
    prompt:
      'Add a small feature to this repository. Follow the patterns already in use, cover the new code with tests, and tell me which files you changed and why.',
  },
  {
    id: 'review',
    title: 'Review code and suggest changes',
    icon: GitPullRequestArrow,
    tone: 'success',
    prompt:
      'Review the most recent changes on this branch. Point out correctness problems first, then anything that would be simpler or safer written another way.',
  },
  {
    id: 'fix',
    title: 'Fix issues and failures',
    icon: Bug,
    tone: 'destructive',
    prompt:
      'The test suite is failing. Run it, find the root cause rather than the first symptom, fix it, and show me the failing output before and after the fix.',
  },
];
