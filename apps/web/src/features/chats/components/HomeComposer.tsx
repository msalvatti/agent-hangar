/**
 * The bottom half of the home screen: whichever of the composer, the credential notice or a
 * failure the settings status calls for.
 *
 * Layer: feature (component).
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import type { RefObject } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { assertPresent } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';

import type { UseSettingsStatusResult } from '../hooks/useSettingsStatus';

import { Composer } from './Composer';
import { SettingsMissingNotice } from './SettingsMissingNotice';

/** Props of {@link HomeComposer}. */
export interface HomeComposerProps {
  settings: UseSettingsStatusResult;
  repo: RepoSummary | null;
  onRepoChange: (repo: RepoSummary | null) => void;
  branch: string | null;
  onBranchChange: (branch: string) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  /** `true` while the chat is being created. */
  busy: boolean;
  /** Message of the last failed creation, or `undefined`. */
  createError: string | undefined;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Renders the composer once the credentials are known to be in place, and the state that stands
 * in for it otherwise.
 *
 * @param props - The settings query, the draft, the handlers and the create-flow state.
 */
export function HomeComposer({
  settings,
  repo,
  onRepoChange,
  branch,
  onBranchChange,
  prompt,
  onPromptChange,
  onSubmit,
  busy,
  createError,
  textareaRef,
}: HomeComposerProps) {
  if (settings.status === 'idle' || settings.status === 'loading') {
    return <Skeleton className="h-36 w-full rounded-xl" data-testid="composer-skeleton" />;
  }

  if (settings.status === 'error') {
    return (
      <ErrorCard
        title="Could not load settings"
        message={assertPresent(settings.error, 'An error status carries an error').message}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void settings.refetch();
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }

  if (settings.missing) {
    return <SettingsMissingNotice />;
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <Composer
        mode="new"
        repo={repo}
        onRepoChange={onRepoChange}
        branch={branch}
        onBranchChange={onBranchChange}
        value={prompt}
        onChange={onPromptChange}
        onSubmit={onSubmit}
        busy={busy}
        model={settings.data?.model}
        textareaRef={textareaRef}
      />
      {createError !== undefined && (
        <ErrorCard
          title="Could not start the chat"
          message={createError}
          actions={
            <Button type="button" variant="outline" size="sm" onClick={onSubmit}>
              Retry
            </Button>
          }
        />
      )}
    </div>
  );
}
