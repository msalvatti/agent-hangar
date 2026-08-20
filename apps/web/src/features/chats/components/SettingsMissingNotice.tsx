/**
 * Replaces the composer while a credential is missing.
 *
 * Layer: feature (component).
 */
import { KeyRound } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { Card, CardContent } from '@/shared/ui/card';

/** Props of {@link SettingsMissingNotice}. */
export interface SettingsMissingNoticeProps {
  className?: string;
}

/**
 * A status card pointing at Settings; no chat can start without both credentials.
 *
 * @param props - Optional class name.
 */
export function SettingsMissingNotice({ className }: SettingsMissingNoticeProps) {
  return (
    <Card role="status" className={cn('w-full', className)}>
      <CardContent className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <KeyRound aria-hidden="true" className="text-warning size-[18px] shrink-0" />
        <p className="flex-1 text-sm">Add your GitHub token and OpenAI key in Settings to start.</p>
        <Button render={<Link href="/settings" />} variant="outline" size="sm">
          Open Settings
        </Button>
      </CardContent>
    </Card>
  );
}
