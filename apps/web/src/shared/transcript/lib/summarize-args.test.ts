/**
 * Tests for the collapsed-row tool call argument summary.
 */
import { GITHUB_CANARY } from '@agent-hangar/core/testing';
import { describe, expect, it } from 'vitest';

import { summarizeArgs } from './summarize-args';

describe('summarizeArgs', () => {
  // run_shell shows the command string.
  it('shows the command for run_shell', () => {
    expect(summarizeArgs('run_shell', { command: 'pnpm test' })).toBe('pnpm test');
  });

  // run_shell without a command field falls back to a clamped JSON dump.
  it('falls back to JSON for run_shell with an unexpected shape', () => {
    expect(summarizeArgs('run_shell', { unexpected: true })).toBe('{ "unexpected": true }');
  });

  // read_file with line bounds shows path:start-end.
  it('shows path:start-end for read_file with line bounds', () => {
    const args = { path: 'tests/auth/login.test.ts', startLine: 1, endLine: 80 };
    expect(summarizeArgs('read_file', args)).toBe('tests/auth/login.test.ts:1-80');
  });

  // read_file without line bounds shows the bare path.
  it('shows the bare path for read_file without line bounds', () => {
    expect(summarizeArgs('read_file', { path: 'README.md' })).toBe('README.md');
  });

  // read_file without a path falls back to JSON.
  it('falls back to JSON for read_file with an unexpected shape', () => {
    expect(summarizeArgs('read_file', {})).toBe('{}');
  });

  // write_file shows the path.
  it('shows the path for write_file', () => {
    expect(summarizeArgs('write_file', { path: 'src/index.ts', content: 'x' })).toBe(
      'src/index.ts',
    );
  });

  // write_file without a path falls back to JSON.
  it('falls back to JSON for write_file with an unexpected shape', () => {
    expect(summarizeArgs('write_file', { content: 'x' })).toBe('{ "content": "x" }');
  });

  // list_dir shows the path.
  it('shows the path for list_dir', () => {
    expect(summarizeArgs('list_dir', { path: 'src' })).toBe('src');
  });

  // list_dir with no path defaults to the root marker.
  it('defaults to "/" for list_dir with no path', () => {
    expect(summarizeArgs('list_dir', {})).toBe('/');
  });

  // A secret shape embedded in the arguments is masked before display.
  it('masks a secret shape in the arguments', () => {
    const summary = summarizeArgs('run_shell', {
      command: `curl -H "Authorization: Bearer ${GITHUB_CANARY}"`,
    });
    expect(summary).not.toContain(GITHUB_CANARY);
    expect(summary).toContain('[REDACTED]');
  });

  // A summary longer than 96 characters is truncated with an ellipsis.
  it('truncates a long summary to 96 characters with an ellipsis', () => {
    const command = 'x'.repeat(200);
    const summary = summarizeArgs('run_shell', { command });
    expect(summary).toHaveLength(97);
    expect(summary.endsWith('…')).toBe(true);
  });

  // A summary at or under the limit is returned unchanged.
  it('does not truncate a summary at the limit', () => {
    const command = 'x'.repeat(96);
    expect(summarizeArgs('run_shell', { command })).toBe(command);
  });

  // Non-object arguments (a defensive case: the protocol types args as unknown) fall back to a
  // JSON dump rather than throwing.
  it('falls back to JSON when args is not an object', () => {
    expect(summarizeArgs('run_shell', 'not an object')).toBe('"not an object"');
    expect(summarizeArgs('list_dir', null)).toBe('/');
  });
});
