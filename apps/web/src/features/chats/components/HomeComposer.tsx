/**
 * The bottom half of the home screen: whichever of the composer, the credential notice or a
 * failure the settings status calls for.
 *
 * Layer: feature (component).
 *
 * Two things can hold a chat back, and they are not the same thing. Missing credentials replace
 * the composer, because nothing can be sent until they are entered. Infrastructure that is down
 * only locks it: the draft is still worth keeping while `pnpm infra:up` runs in another window.
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import type { RefObject } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { useHealth } from '@/shared/health';
import { assertPresent } from '@/shared/transcript';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';

import type { UseSettingsStatusResult } from '../hooks/useSettingsStatus';

import { Composer } from './Composer';
import { InfraDownNotice } from './InfraDownNotice';
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
  const health = useHealth();

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

  // A report that has not arrived yet leaves the composer open: the send itself is what proves
  // the environment, and locking on an unanswered probe would block a working instance.
  const infraDown = health.data !== undefined && health.failingChecks.length > 0;

  return (
    <div className="flex w-full flex-col gap-3">
      <InfraDownNotice failing={health.failingChecks} />
      <Composer
        mode="new"
        disabled={infraDown}
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
