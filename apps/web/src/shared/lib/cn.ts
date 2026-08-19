/**
 * Class-name helper: conditional classes (clsx) merged with Tailwind conflict resolution.
 *
 * Layer: utility.
 */
import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and resolves Tailwind conflicts (last one wins).
 *
 * @param inputs - Strings, arrays, objects or falsy values.
 * @returns The merged class string.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
