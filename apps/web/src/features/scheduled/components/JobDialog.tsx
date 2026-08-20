/**
 * Job create/edit dialog: name, repo/branch, cron with live preview, timezone, prompt, enabled.
 *
 * Layer: component.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { BranchPicker, RepoPicker } from '@/shared/repo-picker';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import { Textarea } from '@/shared/ui/textarea';

import { useJobForm } from '../hooks/useJobForm';
import { useJobMutations } from '../hooks/useJobMutations';
import { pickedRepoUrl, repoDisplayName } from '../lib/job-form';

import { CronField } from './CronField';
import { FormField } from './FormField';
import { TimezoneCombobox } from './TimezoneCombobox';

/** Props of {@link JobDialog}. */
export interface JobDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job?: JobSummary | null;
  onSaved?: (job: JobSummary) => void;
}

/**
 * The job create/edit dialog: name, repository/branch, cron with a live preview, timezone,
 * prompt, and the enabled switch.
 *
 * @param props - Open state, the job being edited (`null`/absent for create), and a save
 *   callback.
 */
export function JobDialog({ open, onOpenChange, job, onSaved }: JobDialogProps) {
  const editingJob = job ?? undefined;
  const { values, setField, errors, touched, touch, isValid, reset } = useJobForm(editingJob);
  const { save, busy, error, clearError } = useJobMutations();

  useEffect(() => {
    if (open) {
      reset();
      clearError();
    }
  }, [open, reset, clearError]);

  const handleSubmit = async () => {
    // The Save button is disabled while the form is invalid (below), so this only ever runs on a
    // valid form; touching every field keeps their errors visible if validity changes afterwards
    // (e.g. the server rejects a value the client-side rules missed).
    touch('name');
    touch('repoUrl');
    touch('branch');
    touch('cron');
    touch('timezone');
    touch('prompt');
    const saved = await save(values, editingJob?.id);
    if (saved !== null) {
      onSaved?.(saved);
      onOpenChange(false);
    }
  };

  const showError = (field: keyof typeof errors) => (touched[field] ? errors[field] : undefined);
  // The pickers work in `owner/name`; the form stores the URL the listing reported, so the short
  // form is derived here rather than kept as a second, divergeable field.
  const repoName = repoDisplayName(values.repoUrl);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editingJob === undefined ? 'New job' : 'Edit job'}</DialogTitle>
          <DialogDescription>
            Runs your prompt in a fresh workspace on a schedule.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <FormField id="job-name" label="Name" error={showError('name')}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                value={values.name}
                onChange={(event) => {
                  setField('name', event.target.value);
                }}
                onBlur={() => {
                  touch('name');
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField id="job-repo" label="Repository" composite error={showError('repoUrl')}>
              {() => (
                <RepoPicker
                  value={repoName}
                  onChange={(selected) => {
                    setField('repoUrl', pickedRepoUrl(selected));
                    setField('branch', null);
                  }}
                />
              )}
            </FormField>
            <FormField id="job-branch" label="Branch" composite error={showError('branch')}>
              {() => (
                <BranchPicker
                  repo={repoName}
                  value={values.branch}
                  onChange={(value) => {
                    setField('branch', value);
                  }}
                />
              )}
            </FormField>
          </div>
          <CronField
            value={values.cron}
            onChange={(value) => {
              setField('cron', value);
            }}
            onBlur={() => {
              touch('cron');
            }}
            timezone={values.timezone}
            error={showError('cron')}
          />
          <FormField id="job-timezone" label="Timezone" composite error={showError('timezone')}>
            {() => (
              <TimezoneCombobox
                value={values.timezone}
                onChange={(value) => {
                  setField('timezone', value);
                }}
              />
            )}
          </FormField>
          <FormField
            id="job-prompt"
            label="Prompt"
            hint="What the agent should do each run."
            error={showError('prompt')}
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                rows={6}
                value={values.prompt}
                onChange={(event) => {
                  setField('prompt', event.target.value);
                }}
                onBlur={() => {
                  touch('prompt');
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid}
              />
            )}
          </FormField>
          <div className="flex items-center gap-2">
            <Switch
              id="job-enabled"
              checked={values.enabled}
              onCheckedChange={(checked) => {
                setField('enabled', checked);
              }}
            />
            <div>
              <label htmlFor="job-enabled" className="text-sm font-medium">
                Enabled
              </label>
              <p className="text-muted-foreground text-xs">
                Disabled jobs keep their history but never run.
              </p>
            </div>
          </div>
          {error !== null && (
            <ErrorCard variant="compact" title="Could not save job" message={error} />
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!isValid || busy}
            onClick={() => {
              void handleSubmit();
            }}
          >
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
