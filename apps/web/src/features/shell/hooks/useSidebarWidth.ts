/**
 * Reads and writes whether the sidebar is shown as the full column or as the icon rail.
 *
 * Layer: feature (hook).
 *
 * The viewport picks the shape until someone says otherwise; from then on the stored choice picks
 * it, so a rail on a screen that cannot be widened is not a one-way door. The choice is read
 * through the same `localStorage`-backed store the theme preference uses: the server pass answers
 * `auto` instead of guessing at storage it cannot read, and the browser corrects the answer through
 * the store rather than through an effect, which is what keeps the two passes reconciled by React.
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';

import { readPersisted, subscribePersisted, writePersisted } from '../lib/persisted';

/** A shape someone can pick; `auto` is the absence of a pick, so it is not one of these. */
export type SidebarWidthChoice = 'rail' | 'column';

/** Stored shape of the sidebar; `auto` leaves the shape to the viewport. */
export type SidebarWidth = 'auto' | SidebarWidthChoice;

/** `localStorage` key remembering an explicitly chosen sidebar shape. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'ah-sidebar-width';

/** Result of {@link useSidebarWidth}. */
export interface UseSidebarWidthResult {
  /** The stored shape, or `auto` while nothing has been chosen. */
  width: SidebarWidth;
  /** Stores an explicit shape and notifies every subscriber. */
  setWidth: (width: SidebarWidthChoice) => void;
}

/**
 * Reads the stored shape, treating anything unrecognised as `auto`.
 *
 * @returns The stored shape.
 */
function readStoredWidth(): SidebarWidth {
  const stored = readPersisted(SIDEBAR_WIDTH_STORAGE_KEY);
  return stored === 'rail' || stored === 'column' ? stored : 'auto';
}

/**
 * Shape assumed while server-rendering, where no storage is readable.
 *
 * @returns `auto`.
 */
function automatic(): SidebarWidth {
  return 'auto';
}

/**
 * Whether the sidebar renders as the icon rail rather than the full column.
 *
 * Only asked once the viewport has room for at least the rail; narrower than that the drawer is
 * the only shape and neither answer applies.
 *
 * @param width - The stored shape.
 * @param roomForColumn - Whether the viewport is wide enough to seat the column by default.
 * @returns `true` when the rail is the shape to render.
 */
export function railShape(width: SidebarWidth, roomForColumn: boolean): boolean {
  return width === 'auto' ? !roomForColumn : width === 'rail';
}

/**
 * Exposes the stored sidebar shape and the writer the toggle needs.
 *
 * @returns The stored shape and its setter.
 */
export function useSidebarWidth(): UseSidebarWidthResult {
  const width = useSyncExternalStore(subscribePersisted, readStoredWidth, automatic);
  const setWidth = useCallback((next: SidebarWidthChoice) => {
    writePersisted(SIDEBAR_WIDTH_STORAGE_KEY, next);
  }, []);
  return { width, setWidth };
}
