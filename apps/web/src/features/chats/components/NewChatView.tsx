/**
 * The home screen: product mark, headline, starter suggestions and the composer that creates a
 * chat.
 *
 * Layer: feature (screen).
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

import { PageHeader } from '@/shared/shell/PageHeader';
import { assertPresent } from '@/shared/transcript';

import { useCreateChat } from '../hooks/useCreateChat';
import { useSettingsStatus } from '../hooks/useSettingsStatus';

import { HomeComposer } from './HomeComposer';
import { LogoMark } from './LogoMark';
import { SuggestionGrid } from './SuggestionGrid';

/** Props of {@link NewChatView}. */
export interface NewChatViewProps {
  /** The shell's mobile drawer button, passed through to the page header. */
  navTrigger?: ReactNode;
}

/**
 * Composes the `/chats/new` screen and owns the draft prompt, repository and branch.
 *
 * The screen scrolls: the shell's main column clips its overflow, and on a narrow viewport the
 * suggestions plus the composer are taller than it. `m-auto` centres the column while it fits and
 * yields to the scroll box when it does not, which `justify-center` would not do — that clips the
 * overflowing top instead of letting it be reached.
 *
 * @param props - Optional nav trigger for the page header.
 */
export function NewChatView({ navTrigger }: NewChatViewProps) {
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const settings = useSettingsStatus();
  const { create, busy, error: createError } = useCreateChat();

  /**
   * Records the chosen repository and clears the branch so the picker defaults it again.
   *
   * @param selected - The repository chosen in the picker.
   */
  function handleRepoChange(selected: RepoSummary | null): void {
    setRepo(selected);
    setBranch(null);
  }

  /**
   * Sends the draft. The composer only enables Send once a repository and a branch are chosen,
   * so both are present here; the assertion states that invariant rather than hiding a silent
   * no-op branch behind a null check that can never be true.
   */
  function submit(): void {
    void create({
      repo: assertPresent(repo, 'A repository must be chosen before sending'),
      branch: assertPresent(branch, 'A branch must be chosen before sending'),
      prompt,
    });
  }

  return (
    <>
      <PageHeader
        title={
          // Below `md` the shell's own drawer trigger sits over this corner and the page is the
          // home screen, whose headline already says where the reader is; the words beside a
          // hamburger only crowd it. `sr-only` rather than `hidden`: the header is still the
          // page's name, and a reader who cannot see the headline has nothing else to go on.
          <span className="sr-only md:not-sr-only">New chat</span>
        }
        navTrigger={navTrigger}
      />
      <div
        data-testid="new-chat-scroll"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-10"
      >
        <div className="m-auto flex w-full max-w-[840px] flex-col items-center gap-8">
          <LogoMark />
          <h1 className="text-center text-[28px] font-semibold tracking-tight">
            What should we build?
          </h1>
          <SuggestionGrid
            onSelect={(starter) => {
              setPrompt(starter);
              textareaRef.current?.focus();
            }}
          />
          <HomeComposer
            settings={settings}
            repo={repo}
            onRepoChange={handleRepoChange}
            branch={branch}
            onBranchChange={setBranch}
            prompt={prompt}
            onPromptChange={setPrompt}
            onSubmit={submit}
            busy={busy}
            createError={createError}
            textareaRef={textareaRef}
          />
        </div>
      </div>
    </>
  );
}
