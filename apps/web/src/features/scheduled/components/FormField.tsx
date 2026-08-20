/**
 * Labelled form field wrapper: uniform aria wiring (label, hint, error) for every dialog field.
 *
 * Layer: component.
 */
import type { ReactNode } from 'react';

/** Render-prop payload passed to {@link FormField}'s `children`. */
export interface FormFieldRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

/** Props of {@link FormField}. */
export interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  /**
   * `true` when the field is a composite widget — a trigger button plus the palette it opens —
   * rather than a single labelable control. `<label for>` may only point at a form element, so a
   * composite field is wrapped in a named group instead of being given a dangling label.
   */
  composite?: boolean;
  children: (props: FormFieldRenderProps) => ReactNode;
}

/**
 * Renders a label, the field (via render prop), an optional hint, and an optional error — wiring
 * `aria-describedby`/`aria-invalid` consistently across every dialog field.
 *
 * @param props - Field id/label/hint/error, whether the control is a composite widget, and the
 *   field's own render prop.
 */
export function FormField({ id, label, hint, error, composite = false, children }: FormFieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedByParts = [hintId, errorId].filter((part): part is string => part !== undefined);
  const describedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;
  const labelId = `${id}-label`;
  const field = children({ id, describedBy, invalid: error !== undefined });

  return (
    <div className="flex flex-col gap-1.5">
      {composite ? (
        <span id={labelId} className="text-sm font-medium">
          {label}
        </span>
      ) : (
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      )}
      {composite ? (
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
          {field}
        </div>
      ) : (
        field
      )}
      {hint !== undefined && (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
