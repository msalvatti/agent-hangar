/**
 * Overflow menu of the chat header.
 *
 * Layer: feature (component).
 */
'use client';

import { Archive, ArchiveRestore, Copy, Ellipsis, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';

import { ConfirmDialog } from './ConfirmDialog';

/** Props of {@link ChatMenu}. */
export interface ChatMenuProps {
  /** `true` when the chat is archived, which swaps Archive for Restore. */
  archived: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onCopyId: () => void;
  onDelete: () => void;
}

/**
 * Archive/Restore, Copy chat id and Delete, the last behind a confirmation.
 *
 * @param props - Whether the chat is archived and one handler per action.
 */
export function ChatMenu({ archived, onArchive, onRestore, onCopyId, onDelete }: ChatMenuProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Chat actions"
              className="cursor-pointer"
            />
          }
        >
          <Ellipsis aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {archived ? (
            <DropdownMenuItem onClick={onRestore}>
              <ArchiveRestore aria-hidden="true" />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onArchive}>
              <Archive aria-hidden="true" />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onCopyId}>
            <Copy aria-hidden="true" />
            Copy chat id
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => {
              setConfirmOpen(true);
            }}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete this chat?"
        description="This removes the chat, its messages and workspace. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        tone="destructive"
        onConfirm={onDelete}
      />
    </>
  );
}
