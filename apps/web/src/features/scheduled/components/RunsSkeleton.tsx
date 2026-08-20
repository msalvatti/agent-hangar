/**
 * Loading placeholder for the runs table: 5 skeleton rows over the same columns.
 *
 * Layer: component.
 */
import { Skeleton } from '@/shared/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/shared/ui/table';

const COLUMN_COUNT = 5;
const ROW_COUNT = 5;

/** Renders 5 skeleton rows matching the runs table's column count. */
export function RunsSkeleton() {
  return (
    <Table data-testid="runs-skeleton">
      <TableBody>
        {Array.from({ length: ROW_COUNT }, (_, rowIndex) => (
          <TableRow key={rowIndex} className="h-11">
            {Array.from({ length: COLUMN_COUNT }, (_, columnIndex) => (
              <TableCell key={columnIndex}>
                <Skeleton className="h-4 w-full max-w-24" />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
