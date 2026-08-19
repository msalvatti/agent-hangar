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
      repo: assertPresent(repo, 'A repository must be chosen before sending').fullName,
      branch: assertPresent(branch, 'A branch must be chosen before sending'),
      prompt,
    });
  }

  return (
    <>
      <PageHeader title="New chat" navTrigger={navTrigger} />
      <div className="flex min-h-[calc(100dvh-48px)] items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-[840px] flex-col items-center gap-8">
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
