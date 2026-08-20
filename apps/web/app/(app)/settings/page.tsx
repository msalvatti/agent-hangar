/**
 * Settings route.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

import { SettingsView } from '@/features/settings';

export const metadata: Metadata = { title: 'Settings — Agent Hangar' };

/** Renders the settings screen for `/settings`. */
export default function SettingsPage() {
  return <SettingsView />;
}
