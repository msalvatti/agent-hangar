/**
 * Resolves which modifier spelling the shortcuts should use, without touching server-rendered
 * markup.
 *
 * Layer: feature (hook).
 */
'use client';

import { useClientOnly } from '@/shared/lib/client-only';

import type { ShortcutPlatform } from '../lib/shortcuts';
import { platformFromUserAgent } from '../lib/shortcuts';

/**
 * Reads the platform from the browser's user agent.
 *
 * @returns `mac` on an Apple platform, `other` everywhere else.
 */
function readShortcutPlatform(): ShortcutPlatform {
  return platformFromUserAgent(globalThis.navigator.userAgent);
}

/**
 * The platform whose modifier the shortcut labels should name.
 *
 * @returns `mac` or `other` in the browser, `null` while server-rendering and hydrating.
 */
export function useShortcutPlatform(): ShortcutPlatform | null {
  return useClientOnly(readShortcutPlatform);
}
