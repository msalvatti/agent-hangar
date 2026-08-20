/**
 * Unit tests for `CredentialsCard`.
 *
 * Layer: unit.
 * Goal: renders a field per secret plus the model line when settings are loaded, shows a
 * skeleton per field while loading (without the model line), shows an error card with retry on
 * failure, and tolerates a defined-but-not-loading state with no settings yet (before the query
 * starts) without rendering the model line.
 * Mocks: none — callbacks are `vi.fn()`.
 */
import type { SettingsStatus } from '@agent-hangar/core';
import { OPENAI_CANARY } from '@agent-hangar/core/testing';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CredentialsCard } from './CredentialsCard';

const settings: SettingsStatus = {
  githubPat: { set: true, last4: 'ab12', updatedAt: '2020-01-01T00:00:00.000Z' },
  openaiKey: { set: false },
  model: 'gpt-5-mini',
};

describe('CredentialsCard — loaded', () => {
  /** Renders both secret fields and the model line. */
  it('renders both fields and the model line', () => {
    render(
      <CredentialsCard
        settings={settings}
        loading={false}
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{}}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByTestId('secret-field-GITHUB_PAT')).toBeInTheDocument();
    expect(screen.getByTestId('secret-field-OPENAI_API_KEY')).toBeInTheDocument();
    expect(screen.getByText('gpt-5-mini')).toBeInTheDocument();
  });

  /** Saving a field forwards the key and value to onSave. */
  it('forwards a save to onSave with the field key', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <CredentialsCard
        settings={settings}
        loading={false}
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{}}
        onSave={onSave}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    const field = screen.getByTestId('secret-field-OPENAI_API_KEY');
    const input = field.querySelector('input');
    if (input === null) {
      throw new Error('expected an input in the unset OPENAI_API_KEY field');
    }
    await user.type(input, OPENAI_CANARY);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith('OPENAI_API_KEY', OPENAI_CANARY);
  });

  /** Confirming a field's Remove dialog forwards the field key to onRemove. */
  it('forwards a remove to onRemove with the field key', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <CredentialsCard
        settings={settings}
        loading={false}
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{}}
        onSave={vi.fn()}
        onRemove={onRemove}
        onClearError={vi.fn()}
      />,
    );
    const field = screen.getByTestId('secret-field-GITHUB_PAT');
    await user.click(within(field).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith('GITHUB_PAT');
  });

  /** Typing in a field with an existing error forwards a clear to onClearError with the key. */
  it('forwards a clear to onClearError with the field key', async () => {
    const user = userEvent.setup();
    const onClearError = vi.fn();
    render(
      <CredentialsCard
        settings={settings}
        loading={false}
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{ OPENAI_API_KEY: 'too short' }}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={onClearError}
      />,
    );
    const field = screen.getByTestId('secret-field-OPENAI_API_KEY');
    const input = field.querySelector('input');
    if (input === null) {
      throw new Error('expected an input in the unset OPENAI_API_KEY field');
    }
    await user.type(input, 'x');
    expect(onClearError).toHaveBeenCalledWith('OPENAI_API_KEY');
  });
});

describe('CredentialsCard — loading', () => {
  /** Shows a skeleton per field and no model line while loading. */
  it('shows skeletons and no model line while loading', () => {
    render(
      <CredentialsCard
        settings={undefined}
        loading
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{}}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.queryByText('gpt-5-mini')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(2);
  });
});

describe('CredentialsCard — error', () => {
  /** Shows an error card with a Retry action calling refetch. */
  it('shows an error card and retries', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    render(
      <CredentialsCard
        settings={undefined}
        loading={false}
        error="boom"
        refetch={refetch}
        pending={{}}
        fieldErrors={{}}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByText('Could not load credentials')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('CredentialsCard — settled but not yet loaded', () => {
  /** Before the query starts (not loading, no error, no data yet), the model line stays hidden. */
  it('renders the fields without a model line', () => {
    render(
      <CredentialsCard
        settings={undefined}
        loading={false}
        error={undefined}
        refetch={vi.fn()}
        pending={{}}
        fieldErrors={{}}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onClearError={vi.fn()}
      />,
    );
    expect(screen.getByTestId('secret-field-GITHUB_PAT')).toBeInTheDocument();
    expect(screen.queryByText(/from OPENAI_MODEL/)).not.toBeInTheDocument();
  });
});
