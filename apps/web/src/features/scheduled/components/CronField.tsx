/**
 * Cron input with a debounced live preview and quick-fill examples.
 *
 * Layer: component.
 */
'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';

import { CronPreview } from './CronPreview';
import { FormField } from './FormField';

/** One quick-fill example offered below the cron input. */
interface CronExample {
  label: string;
  cron: string;
}

const EXAMPLES: readonly CronExample[] = [
  { label: 'Every day 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
];

const DEBOUNCE_MS = 150;

/** Props of {@link CronField}. */
export interface CronFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  timezone: string;
  error?: string | undefined;
}

/**
 * The job dialog's cron field: mono input, quick-fill examples, and a debounced live preview.
 *
 * @param props - Current value, change/blur handlers, the timezone the preview resolves in, and
 *   a validation error.
 */
export function CronField({ value, onChange, onBlur, timezone, error }: CronFieldProps) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebounced(value);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [value]);

  return (
    <FormField id="job-cron" label="Cron" error={error}>
      {({ id, describedBy, invalid }) => (
        <div className="flex flex-col gap-1.5">
          <Input
            id={id}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onBlur={onBlur}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            autoComplete="off"
            inputMode="text"
            className="font-mono text-[13px]"
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <Button
                key={example.cron}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  onChange(example.cron);
                }}
              >
                {example.label}
              </Button>
            ))}
          </div>
          <CronPreview cron={debounced} timezone={timezone} />
        </div>
      )}
    </FormField>
  );
}
