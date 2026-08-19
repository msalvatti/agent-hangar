/**
 * Branch picker: a trigger button that opens a searchable command palette over
 * `GET /api/repos/branches`, disabled until a repository is chosen.
 *
 * Layer: shared (component).
 */
'use client';

import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
 * a repository is chosen; once branches load, auto-selects the repository's default branch if
 * nothing is chosen yet.
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

  const autoSelectedForRepo = useRef<string | null>(null);
  useEffect(() => {
    if (repo === null || value !== null || autoSelectedForRepo.current === repo) {
      return;
    }
    // `noUncheckedIndexedAccess` types this access as possibly `undefined` regardless of a prior
    // `branches.length` check, so the length check is folded into this one instead of duplicated:
    // an empty list and a present-but-empty first entry both mean "nothing to auto-select yet".
    const defaultBranch = branches[0];
    if (defaultBranch === undefined) {
      return;
    }
    autoSelectedForRepo.current = repo;
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
            {status === 'success' && branches.length === 0 && (
              <CommandEmpty>No branches found.</CommandEmpty>
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
