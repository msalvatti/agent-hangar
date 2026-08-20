/**
 * Repository and branch the chat runs against, shown in the header.
 *
 * Layer: feature (component).
 */
import { Box } from 'lucide-react';

import { Badge } from '@/shared/ui/badge';

import { parseRepoUrl } from '../lib/repo-url';

/** Props of {@link RepoChip}. */
export interface RepoChipProps {
  repoUrl: string;
  baseBranch: string;
  /** Branch the agent pushes to, once one exists. */
  workBranch: string | null;
}

/**
 * Renders `owner/repo · branch`, preferring the work branch once the agent has created one.
 *
 * @param props - The chat's repository URL and its two branches.
 */
export function RepoChip({ repoUrl, baseBranch, workBranch }: RepoChipProps) {
  const parsed = parseRepoUrl(repoUrl);
  const branch = workBranch ?? baseBranch;
  return (
    <Badge variant="outline" title={repoUrl} className="font-mono text-xs font-normal">
      <Box aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">
        {parsed?.fullName ?? repoUrl} · {branch}
      </span>
    </Badge>
  );
}
