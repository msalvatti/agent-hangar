/**
 * Unit tests for `FormField`.
 *
 * Layer: unit.
 * Goal: the label connects to the rendered field id, hint/error ids compose into
 * `aria-describedby`, and `invalid` reflects whether an error is present.
 * Mocks: none.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField } from './FormField';

describe('FormField', () => {
  /** With no hint/error, describedBy is undefined and invalid is false. */
  it('renders a bare field with no aria-describedby', () => {
    render(
      <FormField id="f" label="Field">
        {({ id, describedBy, invalid }) => (
          <input
            id={id}
            data-testid="input"
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      </FormField>,
    );
    const input = screen.getByTestId('input');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByLabelText('Field')).toBe(input);
  });

  /** With a hint only, describedBy points at the hint id. */
  it('composes describedBy with a hint', () => {
    render(
      <FormField id="f" label="Field" hint="Helpful text">
        {({ describedBy }) => <input data-testid="input" aria-describedby={describedBy} />}
      </FormField>,
    );
    expect(screen.getByTestId('input')).toHaveAttribute('aria-describedby', 'f-hint');
    expect(screen.getByText('Helpful text')).toHaveAttribute('id', 'f-hint');
  });

  /** With an error, describedBy includes the error id and invalid is true. */
  it('composes describedBy with an error and marks invalid', () => {
    render(
      <FormField id="f" label="Field" hint="Helpful text" error="Required.">
        {({ describedBy, invalid }) => (
          <input data-testid="input" aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </FormField>,
    );
    expect(screen.getByTestId('input')).toHaveAttribute('aria-describedby', 'f-hint f-error');
    expect(screen.getByTestId('input')).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText('Required.');
    expect(error).toHaveAttribute('id', 'f-error');
    expect(error).toHaveAttribute('role', 'alert');
  });
});
