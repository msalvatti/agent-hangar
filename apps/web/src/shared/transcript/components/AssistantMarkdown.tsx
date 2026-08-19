/**
 * Renders assistant prose as Markdown: GFM, headings, lists, fenced code with a copy button.
 *
 * Layer: shared (component).
 *
 * Raw HTML is never enabled (no raw-HTML rehype plugin is in the `rehypePlugins` list below):
 * react-markdown's default `urlTransform` is the only thing keeping a `javascript:`/`data:` link
 * href out of the DOM, so `AssistantMarkdown.test.tsx` pins that behaviour directly rather than
 * trusting the default silently.
 */
import { Children, isValidElement } from 'react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

import { cn } from '@/shared/lib/cn';

import '../styles/highlight.css';

import { CopyButton } from './CopyButton';
import { StreamCursor } from './StreamCursor';

/** Props of {@link AssistantMarkdown}. */
export interface AssistantMarkdownProps {
  text: string;
  /** Appends a {@link StreamCursor} after the last block while `true`. */
  streaming?: boolean;
  className?: string;
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return '';
}

function AnchorRenderer({
  href,
  children,
  node: _node,
  ...rest
}: ComponentProps<'a'> & ExtraProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
      {...rest}
    >
      {children}
    </a>
  );
}

function TableRenderer({ children, node: _node, ...rest }: ComponentProps<'table'> & ExtraProps) {
  return (
    <div className="overflow-x-auto">
      <table {...rest}>{children}</table>
    </div>
  );
}

function CodeRenderer({
  className,
  children,
  node: _node,
  ...rest
}: ComponentProps<'code'> & ExtraProps) {
  const isFenced = typeof className === 'string' && className.includes('language-');
  if (isFenced) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <code className={cn('bg-muted rounded px-1 py-0.5 font-mono text-[13px]', className)} {...rest}>
      {children}
    </code>
  );
}

function PreRenderer({ children, node: _node, ...rest }: ComponentProps<'pre'> & ExtraProps) {
  // remark/rehype always wrap a fenced code block's content in exactly one <code> element, even
  // when that content is empty, so this cast reflects a real contract rather than an assumption.
  const codeElement = Children.toArray(children)[0] as ReactElement<{ className?: string }>;
  const language = /language-(\w+)/.exec(codeElement.props.className ?? '')?.[1] ?? 'text';
  const rawText = extractText(children);

  return (
    <div className="border-border bg-muted overflow-hidden rounded-lg border">
      <div className="border-border flex items-center justify-between border-b px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-xs">{language}</span>
        <CopyButton value={rawText} label="Copy code" />
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-[13px] leading-[1.6]" {...rest}>
        {children}
      </pre>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: AnchorRenderer,
  table: TableRenderer,
  code: CodeRenderer,
  pre: PreRenderer,
};

/**
 * Renders assistant text as Markdown (GFM tables/task lists, headings, lists, fenced code with a
 * copy button). No raw HTML is ever rendered — no raw-HTML rehype plugin is enabled, so any
 * literal HTML in the text is shown as escaped text rather than executed.
 *
 * @param props - Text, streaming flag and className.
 */
export function AssistantMarkdown({ text, streaming = false, className }: AssistantMarkdownProps) {
  return (
    <div
      data-item-kind="assistant"
      className={cn(
        'max-w-none space-y-3 text-[15px] leading-[1.6]',
        '[&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-[15px] [&_h3]:font-semibold',
        '[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
      {streaming && <StreamCursor />}
    </div>
  );
}
