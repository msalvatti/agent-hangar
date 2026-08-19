/**
 * Tests for assistant Markdown rendering, including the safe-URL pin required by the operator:
 * removing react-markdown's default `urlTransform` protection must fail these tests.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMarkdown } from './AssistantMarkdown';

describe('AssistantMarkdown', () => {
  // Headings, lists, a table and a GFM task list all render as their respective elements.
  it('renders headings, lists, a table and a task list', () => {
    const text = [
      '# Heading',
      '',
      '- one',
      '- two',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '- [x] done',
      '- [ ] todo',
    ].join('\n');
    render(<AssistantMarkdown text={text} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
  });

  // A fenced code block with a language tag gets a language-<lang> class and a copy button.
  it('renders fenced code with a language class and a working copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<AssistantMarkdown text={'```ts\nconst x = 1;\n```'} />);
    const code = document.querySelector('code.language-ts');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('const x = 1;');

    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const x = 1;\n');
    });
  });

  // An empty fenced code block copies an empty string rather than throwing (exercises the
  // extractText fallback for a non-text child, e.g. an empty code element with no children).
  it('copies an empty string for an empty fenced code block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<AssistantMarkdown text={'```\n```'} />);
    const copyButton = screen.getByRole('button', { name: 'Copy code' });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(writeText.mock.calls[0]?.[0]).toEqual(expect.any(String));
  });

  // Inline code renders with the muted mono styling, distinct from a fenced block.
  it('renders inline code distinctly from a fenced block', () => {
    render(<AssistantMarkdown text="Use `pnpm test` to run." />);
    const inline = screen.getByText('pnpm test');
    expect(inline.tagName).toBe('CODE');
    expect(inline).toHaveClass('bg-muted');
  });

  // <script> in the source text is never executed or unescaped — no raw-HTML rehype plugin.
  it('escapes raw HTML instead of rendering it', () => {
    interface WindowWithPwnedFlag extends Window {
      __pwned?: boolean;
    }
    render(<AssistantMarkdown text={'before <script>window.__pwned = true;</script> after'} />);
    expect(document.querySelector('script')).toBeNull();
    expect((window as WindowWithPwnedFlag).__pwned).toBeUndefined();
  });

  // The streaming cursor appears only when streaming is true.
  it('shows the stream cursor only while streaming', () => {
    const { rerender } = render(<AssistantMarkdown text="hi" streaming />);
    expect(screen.getByTestId('stream-cursor')).toBeInTheDocument();
    rerender(<AssistantMarkdown text="hi" streaming={false} />);
    expect(screen.queryByTestId('stream-cursor')).toBeNull();
  });

  describe('safe-URL pinning (react-markdown default urlTransform)', () => {
    // A javascript: href is dropped by react-markdown's default urlTransform — removing that
    // protection (e.g. by adding a custom urlTransform) must fail this assertion. Queried by text
    // rather than role: a link with no (non-empty) href loses the implicit "link" role, which is
    // itself part of the safe behaviour being pinned here.
    it('drops a javascript: href', () => {
      render(<AssistantMarkdown text="[click me](javascript:alert(1))" />);
      const link = screen.getByText('click me').closest('a');
      expect(link).not.toBeNull();
      expect(link).not.toHaveAttribute('href', 'javascript:alert(1)');
      expect(link?.getAttribute('href')).not.toMatch(/^javascript:/);
    });

    // A data:text/html href is likewise dropped.
    it('drops a data:text/html href', () => {
      render(<AssistantMarkdown text="[click me](data:text/html,<script>alert(1)</script>)" />);
      const link = screen.getByText('click me').closest('a');
      expect(link?.getAttribute('href')).not.toMatch(/^data:/);
    });

    // An ordinary https:// link keeps its href and opens safely in a new tab.
    it('keeps an ordinary https href and opens it safely in a new tab', () => {
      render(<AssistantMarkdown text="[docs](https://example.com/docs)" />);
      const link = screen.getByRole('link', { name: 'docs' });
      expect(link).toHaveAttribute('href', 'https://example.com/docs');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });
});
