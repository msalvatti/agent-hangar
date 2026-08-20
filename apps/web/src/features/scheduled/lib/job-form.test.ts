/**
 * Unit tests for the job form model.
 *
 * Layer: unit.
 * Goal: `emptyJobForm`/`jobToForm` construct the right values, `pickedRepoUrl`/`repoDisplayName`
 * keep the URL and its label in step, `pickedRepoDefault` carries the repository's default branch
 * with the URL it belongs to, `formToRequest` maps to the contract shape, and `validateJobForm`
 * covers every validation rule plus the schema fallback.
 * Mocks: none.
 */
import type { JobSummary } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import {
  emptyJobForm,
  formFieldForIssue,
  formToRequest,
  jobToForm,
  pickedRepoDefault,
  pickedRepoUrl,
  repoDisplayName,
  validateJobForm,
} from './job-form';
import type { JobFormValues } from './job-form';

const job: JobSummary = {
  id: 'job-1',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run the suite.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

function validForm(): JobFormValues {
  return {
    name: 'Nightly tests',
    repoUrl: 'https://github.com/acme/api',
    branch: 'main',
    cron: '0 2 * * *',
    timezone: 'UTC',
    prompt: 'Run the suite.',
    enabled: true,
  };
}

describe('emptyJobForm', () => {
  /** Starts enabled, blank fields, timezone defaulted to the system zone. */
  it('builds a blank, enabled form', () => {
    const form = emptyJobForm();
    expect(form.enabled).toBe(true);
    expect(form.name).toBe('');
    expect(form.repoUrl).toBeNull();
    expect(form.timezone.length).toBeGreaterThan(0);
  });
});

describe('jobToForm', () => {
  /** Prefills every field from the job, keeping the stored repository URL verbatim. */
  it('prefills from a job', () => {
    const form = jobToForm(job);
    expect(form.repoUrl).toBe('https://github.com/acme/api');
    expect(form.branch).toBe('main');
    expect(form.cron).toBe(job.cron);
    expect(form.enabled).toBe(true);
  });

  /**
   * Rule this protects: editing a job never rewrites which forge it runs against. The form used
   * to keep only `owner/name` and rebuild the URL against a hard-coded github.com on save, which
   * silently moved a job on any other forge.
   */
  it('keeps the repository URL of a job on any origin', () => {
    const form = jobToForm({ ...job, repoUrl: 'https://git.acme.test/acme/infra' });
    expect(form.repoUrl).toBe('https://git.acme.test/acme/infra');
    expect(formToRequest(form).repoUrl).toBe('https://git.acme.test/acme/infra');
  });
});

describe('formToRequest', () => {
  /** Maps every field to the contract's request shape. */
  it('maps the form to the request body', () => {
    const request = formToRequest(validForm());
    expect(request).toEqual({
      name: 'Nightly tests',
      cron: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'Run the suite.',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      enabled: true,
    });
  });

  /** A null repository/branch maps to an empty string (the field checks catch it as invalid). */
  it('maps a null repository URL and branch to empty strings', () => {
    const request = formToRequest({ ...validForm(), repoUrl: null, branch: null });
    expect(request.repoUrl).toBe('');
    expect(request.branch).toBe('');
  });
});

describe('validateJobForm', () => {
  /** A fully valid form has no errors. */
  it('accepts a valid form', () => {
    expect(validateJobForm(validForm())).toEqual({});
  });

  /** An empty name is rejected. */
  it('rejects an empty name', () => {
    expect(validateJobForm({ ...validForm(), name: '   ' }).name).toBeDefined();
  });

  /** A name longer than the UI limit is rejected. */
  it('rejects a name that is too long', () => {
    expect(validateJobForm({ ...validForm(), name: 'x'.repeat(81) }).name).toBeDefined();
  });

  /** A missing repository is rejected. */
  it('rejects a missing repository', () => {
    expect(validateJobForm({ ...validForm(), repoUrl: null }).repoUrl).toBeDefined();
  });

  /**
   * Rule this protects: the form does not second-guess the operator's forge list. A repository on
   * another origin is as valid here as one on github.com; a host outside `ALLOWED_REPO_HOSTS` is
   * refused by the server, which is the only side that knows the list.
   */
  it('accepts a repository on any origin', () => {
    expect(
      validateJobForm({ ...validForm(), repoUrl: 'https://git.acme.test/acme/infra' }),
    ).toEqual({});
  });

  /** A missing branch is rejected. */
  it('rejects a missing branch', () => {
    expect(validateJobForm({ ...validForm(), branch: '' }).branch).toBeDefined();
  });

  /** An invalid cron expression is rejected with the adapter's reason. */
  it('rejects an invalid cron expression', () => {
    expect(validateJobForm({ ...validForm(), cron: 'nope' }).cron).toBeDefined();
  });

  /** An unknown timezone is rejected. */
  it('rejects an unknown timezone', () => {
    expect(validateJobForm({ ...validForm(), timezone: 'Not/AZone' }).timezone).toBeDefined();
  });

  /** An empty prompt is rejected. */
  it('rejects an empty prompt', () => {
    expect(validateJobForm({ ...validForm(), prompt: '' }).prompt).toBeDefined();
  });

  /** A prompt longer than the UI limit is rejected. */
  it('rejects a prompt that is too long', () => {
    expect(validateJobForm({ ...validForm(), prompt: 'x'.repeat(4001) }).prompt).toBeDefined();
  });

  /**
   * A repository URL that passes the "chosen" field check but that the shared schema rejects
   * (more than owner and repository, say) falls through to the schema-level error — reported
   * under the repository field, which is the input the user can act on, not under whichever
   * field happens to be last.
   */
  it('reports a schema rejection under the field it belongs to', () => {
    const errors = validateJobForm({
      ...validForm(),
      repoUrl: 'https://github.com/acme/api/tree/main',
    });
    expect(errors.repoUrl).toBeDefined();
    expect(errors.prompt).toBeUndefined();
  });
});

describe('pickedRepoUrl', () => {
  /**
   * Rule this protects: what the form stores is the repository's own URL, so a repository on a
   * self-hosted forge is saved where it actually lives rather than under a rebuilt github URL.
   */
  it('stores the URL a picked repository reported', () => {
    expect(
      pickedRepoUrl({
        fullName: 'acme/infra',
        url: 'https://git.acme.test/acme/infra',
        defaultBranch: 'trunk',
        private: false,
        description: null,
      }),
    ).toBe('https://git.acme.test/acme/infra');
  });

  /** Clearing the choice clears the field, so validation reports the repository as required. */
  it('maps a cleared choice to null', () => {
    expect(pickedRepoUrl(null)).toBeNull();
  });
});

describe('repoDisplayName', () => {
  /** The pickers work in `owner/name`, derived from the stored URL on whatever origin it names. */
  it('derives the short form from the stored URL', () => {
    expect(repoDisplayName('https://git.acme.test/acme/infra')).toBe('acme/infra');
  });

  /** No repository chosen yet leaves the pickers empty rather than showing a placeholder name. */
  it('maps no repository to null', () => {
    expect(repoDisplayName(null)).toBeNull();
  });
});

describe('formFieldForIssue', () => {
  /** A request field the form renders under a different name still points at its own input. */
  it('maps a request field to the form field that renders it', () => {
    expect(formFieldForIssue(['repoUrl'])).toBe('repoUrl');
    expect(formFieldForIssue(['cron'])).toBe('cron');
  });

  /**
   * A path naming nothing the form renders still has to surface somewhere: it lands on the
   * prompt rather than being silently dropped, leaving the dialog unsavable with no explanation.
   */
  it('falls back to the prompt for a path that names no field', () => {
    expect(formFieldForIssue(['somethingElse'])).toBe('prompt');
    expect(formFieldForIssue([])).toBe('prompt');
  });
});

describe('pickedRepoDefault', () => {
  /*
   * The branch default is only trustworthy for the repository it was read from, so it is carried
   * with that repository's URL rather than on its own — the form compares the pair against the
   * repository it currently holds, and a default left over from an earlier choice cannot match.
   */
  it('carries the default branch with the repository URL', () => {
    expect(
      pickedRepoDefault({
        fullName: 'acme/api',
        url: 'https://github.com/acme/api',
        defaultBranch: 'main',
        private: false,
        description: null,
      }),
    ).toEqual({ repoUrl: 'https://github.com/acme/api', defaultBranch: 'main' });
  });

  /** A cleared choice has no repository, so it has no default either. */
  it('reports nothing when the choice was cleared', () => {
    expect(pickedRepoDefault(null)).toBeNull();
  });
});
