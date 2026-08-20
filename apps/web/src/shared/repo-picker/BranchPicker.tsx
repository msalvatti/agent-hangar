/**
 * Branch picker: a trigger button that opens a searchable command palette over
 * `GET /api/repos/branches`, disabled until a repository is chosen.
 *
 * Layer: shared (component).
 */
'use client';

import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { cn } from '@/shared/lib/cn';
import { assertPresent, maskSecretShapes } from '@/shared/transcript';
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

import { repoReadiness } from './readiness';
import { useBranches } from './useBranches';

/** Props of {@link BranchPicker}. */
export interface BranchPickerProps {
  repo: string | null;
  value: string | null;
  onChange: (branch: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Command-palette branch picker for `repo`. Disabled (with a native tooltip explaining why) until
 * a repository is chosen; whenever branches are loaded and no branch is chosen, auto-selects the
 * repository's default branch.
 *
 * @param props - Repo, value, change handler, disabled, className.
 */
export function BranchPicker({
  repo,
  value,
  onChange,
  disabled = false,
  className,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { status, data, error, refetch } = useBranches(repo);
  // Memoized: `data?.branches ?? []` would otherwise create a new array identity on every render
  // once `data` is undefined, defeating the auto-select effect's dependency comparison below.
  const branches = useMemo(() => data?.branches ?? [], [data]);
  const isDisabled = disabled || repo === null;

  // The condition is "a repository is chosen, no branch is, and branches are loaded" — not "this
  // repository has never been defaulted". Choosing the same repository again clears the branch, and
  // that selection has to be defaulted too or the composer stays disabled with no branch to send.
  useEffect(() => {
    if (repo === null || value !== null) {
      return;
    }
    // `noUncheckedIndexedAccess` types this access as possibly `undefined` regardless of a prior
    // `branches.length` check, so the length check is folded into this one instead of duplicated:
    // an empty list and a present-but-empty first entry both mean "nothing to auto-select yet".
    const defaultBranch = branches[0];
    if (defaultBranch === undefined) {
      return;
    }
    onChange(defaultBranch.name);
  }, [repo, branches, value, onChange]);

  function select(branchName: string): void {
    onChange(branchName);
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={isDisabled}
        title={repo === null ? 'Choose a repository first' : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
        }}
        className={cn('min-w-0 justify-between', className)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{value ?? 'Choose branch'}</span>
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Choose branch"
        description="Search branches"
      >
        <Command>
          <CommandInput
            placeholder="Search branches…"
            aria-label="Search branches"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {status === 'loading' && (
              <div className="space-y-1 p-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            )}
            {status === 'error' && (
              <div className="space-y-2 p-4 text-center text-sm">
                <p className="text-destructive">
                  {maskSecretShapes(
                    assertPresent(error, 'An error status carries an error').message,
                  )}
                </p>
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
            {status === 'success' && branches.length === 0 && (
              // An existing repository with no branches has no commits — GitHub creates the first
              // ref on the first push, and `default_branch` reports the configured name whether or
              // not that ref exists, so the empty listing is the only proof. Saying so here is the
              // whole fix: the send button stays disabled, which is correct, because cloning uses
              // `git clone --branch <name>` and a repository with no refs cannot satisfy it.
              // Enabling the button would move the failure into the container instead of fixing it.
              <CommandEmpty className="space-y-2 px-4">
                <p>No branches found.</p>
                <p className="text-muted-foreground text-xs">
                  {repoReadiness({ hasBranches: false }).reason}
                </p>
              </CommandEmpty>
            )}
            {status === 'success' && branches.length > 0 && (
              <CommandGroup heading="Branches">
                {branches.map((branch) => (
                  <CommandItem
                    key={branch.name}
                    value={branch.name}
                    onSelect={() => {
                      select(branch.name);
                    }}
                  >
                    <span className="flex-1 truncate">{branch.name}</span>
                    {value === branch.name && (
                      <Check aria-hidden="true" className="size-4 shrink-0" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
