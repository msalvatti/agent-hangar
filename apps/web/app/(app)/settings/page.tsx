/**
 * Settings route — placeholder until the settings feature lands.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings' };

/** Placeholder page for `/settings`. */
export default function SettingsPage() {
  return (
    <section className="px-6 py-10">
      <h1 className="text-[28px] font-semibold tracking-tight" data-testid="placeholder-settings">
        Settings
      </h1>
    </section>
  );
}
