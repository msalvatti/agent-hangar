/**
 * Repository picker: a trigger button that opens a searchable command palette over
 * `GET /api/repos`.
 *
 * Layer: shared (component).
 *
 * Opens as a `CommandDialog` (a centred modal built on shadcn's `Dialog`) rather than an anchored
 * popover: the generated `@/shared/ui` set has no `Popover` primitive, and adding one would be a
 * new dependency outside this lane's manifest. A modal command palette is the same pattern VS
 * Code and GitHub use for this exact interaction.
 */
'use client';

import type { RepoSummary } from '@agent-hangar/core';
import { Box, Check, ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/ui/command';
import { Skeleton } from '@/shared/ui/skeleton';

import { getRecentRepos, pushRecentRepo } from './recent';
import { useRepos } from './useRepos';

/** Props of {@link RepoPicker}. */
export interface RepoPickerProps {
  /** The chosen repository's `fullName`, or `null` before one is chosen. */
  value: string | null;
  onChange: (repo: RepoSummary | null) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/** A repo row: name, muted default branch, and a check mark when selected. */
function RepoRow({
  repo,
  selected,
  onSelect,
}: {
  repo: RepoSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem value={repo.fullName} onSelect={onSelect}>
      <span className="flex-1 truncate">{repo.fullName}</span>
      <span className="text-muted-foreground shrink-0 text-xs">{repo.defaultBranch}</span>
      {selected && <Check aria-hidden="true" className="size-4 shrink-0" />}
    </CommandItem>
  );
}

/**
 * Command-palette repository picker. Lists recently-used repos first (from `localStorage`), then
 * the rest of the search results from `GET /api/repos`.
 *
 * @param props - Value, change handler, disabled, size, className.
 */
export function RepoPicker({
  value,
  onChange,
  disabled = false,
  size = 'md',
  className,
}: RepoPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { status, data, error, refetch } = useRepos(query);
  const repos = data?.repos ?? [];
  const recentNames = getRecentRepos();
  const recentRepos = recentNames
    .map((name) => repos.find((repo) => repo.fullName === name))
    .filter((repo): repo is RepoSummary => repo !== undefined);
  const recentSet = new Set(recentRepos.map((repo) => repo.fullName));
  const otherRepos = repos.filter((repo) => !recentSet.has(repo.fullName));

  function select(repo: RepoSummary): void {
    onChange(repo);
    pushRecentRepo(repo.fullName);
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size === 'sm' ? 'sm' : 'default'}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
        className={cn('min-w-0 justify-between', className)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Box aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{value ?? 'Choose repository'}</span>
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Choose repository"
        description="Search repositories"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search repositories…"
            aria-label="Search repositories"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {status === 'loading' && (
              <div className="space-y-1 p-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            )}
            {status === 'error' && (
              <div className="space-y-2 p-4 text-center text-sm">
                {/* `error` is always set once `status === 'error'` (`useApiQuery` sets both
                    together in the same catch block), so there is no real fallback case to
                    render text for — `?.` alone satisfies the type without one. */}
                <p className="text-destructive">{error?.message}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void refetch();
                  }}
                >
                  Retry
                </Button>
              </div>
            )}
            {status === 'success' && repos.length === 0 && (
              <CommandEmpty>No repositories match.</CommandEmpty>
            )}
            {status === 'success' && recentRepos.length > 0 && (
              <CommandGroup heading="Recent">
                {recentRepos.map((repo) => (
                  <RepoRow
                    key={repo.fullName}
                    repo={repo}
                    selected={value === repo.fullName}
                    onSelect={() => {
                      select(repo);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
            {status === 'success' && otherRepos.length > 0 && (
              <CommandGroup heading="Repositories">
                {otherRepos.map((repo) => (
                  <RepoRow
                    key={repo.fullName}
                    repo={repo}
                    selected={value === repo.fullName}
                    onSelect={() => {
                      select(repo);
                    }}
                  />
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
