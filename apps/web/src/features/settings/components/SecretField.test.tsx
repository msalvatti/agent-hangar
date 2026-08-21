/**
 * Unit tests for `SecretField`.
 *
 * Layer: unit.
 * Goal: every state renders correctly (loading, unset, set, replacing, saving, error); Save is
 * disabled until the input is valid and Enter submits; after a save the input clears and the mask
 * shows the new last4 while the full secret never appears in the DOM; Replace switches to an
 * input that takes the focus, and Cancel returns to the mask; Remove opens the confirmation dialog; the error is wired
 * via `aria-describedby`/`aria-invalid`; the input is `type="password"` with `autoComplete="off"`.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SECRET_FIELDS } from '../lib/secrets';
import type { SecretStatusView } from '../lib/secrets';

import { SecretField } from './SecretField';

const field = SECRET_FIELDS[0];
if (field === undefined) {
  throw new Error('expected at least one secret field');
}

const setStatus: SecretStatusView = {
  set: true,
  last4: 'ab12',
  updatedAt: '2020-01-01T00:00:00.000Z',
};

describe('SecretField — loading', () => {
  /** Shows a skeleton while loading. */
  it('shows a skeleton', () => {
    render(
      <SecretField
        field={field}
        status={undefined}
        loading
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId(`secret-field-${field.key}`).querySelector('[data-slot="skeleton"]'),
    ).not.toBeNull();
  });
});

describe('SecretField — unset', () => {
  /** Save is disabled until the input is a valid value; typing a value enables it. */
  it('disables Save until the input is valid', async () => {
    const user = userEvent.setup();
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText(field.placeholder), GITHUB_CANARY);
    expect(save).toBeEnabled();
  });

  /** `status={undefined}` (not yet known) is treated the same as unset. */
  it('treats an undefined status as unset', () => {
    render(
      <SecretField
        field={field}
        status={undefined}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText(field.placeholder)).toBeInTheDocument();
  });

  /** The input is `type="password"` with autocomplete and spellcheck disabled. */
  it('renders a password input with autocomplete/spellcheck off', () => {
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText(field.placeholder);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  /** Enter in the input submits, calling onSave with the trimmed value. */
  it('submits on Enter', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={onSave}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText(field.placeholder), `${GITHUB_CANARY}{Enter}`);
    expect(onSave).toHaveBeenCalledWith(GITHUB_CANARY);
  });

  /** Enter with an invalid (whitespace-only) value does not submit. */
  it('does not submit on Enter with an invalid value', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={onSave}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    await user.type(screen.getByPlaceholderText(field.placeholder), '  {Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  /** While saving, the input and Save button are disabled and a spinner shows. */
  it('disables the input and Save while saving', () => {
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending="saving"
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText(field.placeholder)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('SecretField — error', () => {
  /** The error is rendered and wired via aria-describedby/aria-invalid; typing clears it. */
  it('wires the error via aria and clears it on input', async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error="Enter a value."
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={onClearError}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value.');
    const input = screen.getByPlaceholderText(field.placeholder);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby') ?? '';
    expect(describedBy.split(' ').length).toBe(2);
    await user.type(input, 'x');
    expect(onClearError).toHaveBeenCalled();
  });
});

describe('SecretField — set', () => {
  /** Shows the mask with the last4, an "updated <relative>" label, and Replace/Remove. */
  it('shows the mask and updated label', () => {
    render(
      <SecretField
        field={field}
        status={setStatus}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    const mask = screen.getByTestId(`secret-mask-${field.key}`);
    expect(mask).toHaveTextContent('••••••••ab12');
    expect(mask).toHaveAttribute('aria-label', `${field.label} ending in ab12`);
    expect(screen.getByText(/updated/)).toBeInTheDocument();
  });

  /** A set secret with no last4 (the type allows it, even if the server never sends it) still
   * renders a mask and an aria-label without crashing. */
  it('renders a mask and aria-label when last4 is absent', () => {
    render(
      <SecretField
        field={field}
        status={{ set: true }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    const mask = screen.getByTestId(`secret-mask-${field.key}`);
    expect(mask).toHaveTextContent('••••••••');
    expect(mask).toHaveAttribute('aria-label', `${field.label} ending in `);
  });

  /** A set secret with no updatedAt shows "set" instead of a relative time. */
  it('shows "set" when there is no updatedAt', () => {
    render(
      <SecretField
        field={field}
        status={{ set: true, last4: 'ab12' }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByText('set')).toBeInTheDocument();
  });

  /** Replace switches to an input; Cancel returns to the mask without saving. */
  it('Replace switches to an input, Cancel returns to the mask', async () => {
    const user = userEvent.setup();
    render(
      <SecretField
        field={field}
        status={setStatus}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    const input = screen.getByPlaceholderText(field.placeholder);
    // Replace is a request to type, and the button that was under the pointer is gone once it is
    // pressed. A keyboard path that ended there would have to hunt for the field it just asked
    // for, so the field takes the focus itself.
    expect(input).toHaveFocus();
    await user.type(input, GITHUB_CANARY);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByPlaceholderText(field.placeholder)).not.toBeInTheDocument();
    expect(screen.getByTestId(`secret-mask-${field.key}`)).toBeInTheDocument();
  });

  /** Remove opens the confirmation dialog. */
  it('Remove opens the confirmation dialog', async () => {
    const user = userEvent.setup();
    render(
      <SecretField
        field={field}
        status={setStatus}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(`Remove ${field.label}?`)).toBeInTheDocument();
  });

  /** Confirming inside the dialog calls onRemove and closes it. */
  it('confirming the dialog calls onRemove', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <SecretField
        field={field}
        status={setStatus}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={onRemove}
        onClearError={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  /** After a save (status.last4 changes), the input clears and replace mode exits. */
  it('clears the input and exits replace mode after a save', () => {
    const { rerender } = render(
      <SecretField
        field={field}
        status={{ set: false }}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    rerender(
      <SecretField
        field={field}
        status={setStatus}
        loading={false}
        pending={undefined}
        error={undefined}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.queryByPlaceholderText(field.placeholder)).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(GITHUB_CANARY);
  });
});
