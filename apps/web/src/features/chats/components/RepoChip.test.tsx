/**
 * Tests for `RepoChip`: the repository and branch shown in the chat header.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RepoChip } from './RepoChip';

describe('RepoChip', () => {
  // Before the agent branches, the chip shows the base branch.
  it('shows the base branch', () => {
    render(<RepoChip repoUrl="https://github.com/acme/api" baseBranch="main" workBranch={null} />);
    expect(screen.getByText('acme/api · main')).toBeInTheDocument();
  });

  // Once a work branch exists it is the one that matters.
  it('prefers the work branch', () => {
    render(
      <RepoChip repoUrl="https://github.com/acme/api" baseBranch="main" workBranch="agent/k3x9" />,
    );
    expect(screen.getByText('acme/api · agent/k3x9')).toBeInTheDocument();
  });

  // A URL that is not a plain GitHub repository is shown as-is rather than dropped.
  it('falls back to the raw URL', () => {
    render(<RepoChip repoUrl="https://example.com/x" baseBranch="main" workBranch={null} />);
    expect(screen.getByText('https://example.com/x · main')).toBeInTheDocument();
  });
});
