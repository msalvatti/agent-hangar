/**
 * Searchable timezone picker.
 *
 * Layer: component.
 *
 * Spec 10 §4.3 calls for a `Command` inside a `Popover`; `@/shared/ui` has no `Popover`
 * primitive, so this uses the dialog-based `Command` composition instead — same searchable,
 * keyboard-navigable behaviour, with a modal trigger rather than an anchored popover.
 */
'use client';

import { Globe } from 'lucide-react';
import { useState } from 'react';

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

import { listTimezones, systemTimezone } from '../lib/timezones';

/** Props of {@link TimezoneCombobox}. */
export interface TimezoneComboboxProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * A searchable timezone picker: a trigger button opening a command dialog listing every IANA
 * timezone, the system zone pinned first.
 *
 * @param props - Current value, change handler, and disabled state.
 */
export function TimezoneCombobox({ value, onChange, disabled }: TimezoneComboboxProps) {
  const [open, setOpen] = useState(false);
  const system = systemTimezone();
  const others = listTimezones().filter((zone) => zone !== system);

  const select = (zone: string) => {
    onChange(zone);
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        aria-label="Timezone"
        aria-haspopup="listbox"
        className="justify-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Globe className="size-3.5" aria-hidden="true" />
        {value}
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Timezone"
        description="Search timezones"
      >
        <Command>
          <CommandInput placeholder="Search timezones…" />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup heading="System">
              <CommandItem
                value={system}
                data-checked={system === value}
                onSelect={() => {
                  select(system);
                }}
              >
                {system}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="All timezones">
              {others.map((zone) => (
                <CommandItem
                  key={zone}
                  value={zone}
                  data-checked={zone === value}
                  onSelect={() => {
                    select(zone);
                  }}
                >
                  {zone}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
