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
  children: (props: FormFieldRenderProps) => ReactNode;
}

/**
 * Renders a `<label>`, the field (via render prop), an optional hint, and an optional error —
 * wiring `aria-describedby`/`aria-invalid` consistently across every dialog field.
 *
 * @param props - Field id/label/hint/error and the field's own render prop.
 */
export function FormField({ id, label, hint, error, children }: FormFieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined ? undefined : `${id}-error`;
  const describedByParts = [hintId, errorId].filter((part): part is string => part !== undefined);
  const describedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
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
