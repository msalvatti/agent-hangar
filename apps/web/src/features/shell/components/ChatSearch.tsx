/**
 * The ⌘K command palette over the chat titles.
 *
 * Layer: feature (component).
 */
'use client';

import type { ChatSummary } from '@agent-hangar/core';
import { useRouter } from 'next/navigation';

import { maskSecretShapes } from '@/shared/transcript';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/shared/ui/command';

import { useChats } from '../hooks/useChats';

/** Props of {@link ChatSearch}. */
export interface ChatSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A searchable list of every chat; choosing one navigates to it and closes the palette.
 *
 * Filtering is left to `cmdk`, which matches on each item's value — the chat title, masked for
 * secret shapes so neither the rendered label nor the `data-value` attribute can carry one.
 *
 * @param props - Open state and its setter.
 */
export function ChatSearch({ open, onOpenChange }: ChatSearchProps) {
  const router = useRouter();
  const { active, archived } = useChats();

  function choose(chat: ChatSummary): void {
    onOpenChange(false);
    router.push(`/chats/${chat.id}`);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search chats"
      description="Find a chat by title"
    >
      <Command>
        <CommandInput placeholder="Search chats…" aria-label="Search chats" />
        <CommandList>
          <CommandEmpty>No chats found.</CommandEmpty>
          {active.length > 0 && (
            <CommandGroup heading="Chats">
              {active.map((chat) => (
                <CommandItem
                  key={chat.id}
                  value={maskSecretShapes(chat.title)}
                  onSelect={() => {
                    choose(chat);
                  }}
                >
                  {maskSecretShapes(chat.title)}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {archived.length > 0 && (
            <CommandGroup heading="Archived">
              {archived.map((chat) => (
                <CommandItem
                  key={chat.id}
                  value={maskSecretShapes(chat.title)}
                  onSelect={() => {
                    choose(chat);
                  }}
                >
                  {maskSecretShapes(chat.title)}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
