/**
 * Turns a failed turn's error into the copy and the next action the UI offers.
 *
 * Layer: feature (lib).
 */
import { maskSecretShapes } from '@/shared/transcript';

/** What the error card offers the operator next. */
export type TurnErrorAction = 'retry' | 'settings' | 'readme';

/** Anchor of the workspace-image section of the setup guide. */
export const README_IMAGE_ANCHOR = '#workspace-image';

/**
 * Link the `readme` action points at.
 *
 * The published location of the setup guide is decided when the docs ship (W3-A); until then the
 * link is the anchor on the site root, which keeps it same-origin and never dangling off-site.
 */
export const README_IMAGE_HREF = `/${README_IMAGE_ANCHOR}`;

/** Presentation of one failed turn. */
export interface TurnErrorDescription {
  title: string;
  /** Redacted message, safe to render. */
  message: string;
  action: TurnErrorAction;
}

/** Title and next action per error code the runtime reports. */
const BY_CODE: Readonly<Record<string, { title: string; action: TurnErrorAction }>> = {
  auth: { title: 'OpenAI rejected the key', action: 'settings' },
  WORKSPACE_IMAGE_MISSING: { title: 'Workspace image missing', action: 'readme' },
  image_missing: { title: 'Workspace image missing', action: 'readme' },
  context_length: { title: 'The conversation grew too long', action: 'retry' },
  rate_limit: { title: 'The model is rate limiting', action: 'retry' },
  network: { title: 'The model could not be reached', action: 'retry' },
};

/** Used for any code the runtime has not declared here. */
const FALLBACK = { title: 'The turn failed', action: 'retry' } as const;

/**
 * Describes a failed turn for {@link TurnErrorCard}.
 *
 * @param error - The `turn.failed` payload.
 * @returns Title, redacted message and the action to offer.
 */
export function describeTurnError(error: { code: string; message: string }): TurnErrorDescription {
  const known = BY_CODE[error.code] ?? FALLBACK;
  return { title: known.title, message: maskSecretShapes(error.message), action: known.action };
}
