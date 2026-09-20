import { ReactNode } from 'react';
import { Spinner, EmptyState } from './ui';

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyHint?: string;
  emptyAction?: ReactNode;
  rowKey?: (row: T) => string;
}

export function DataTable<T extends Record<string, any>>({
  columns,
  rows,
  loading,
  onRowClick,
  emptyTitle = 'No records',
  emptyHint,
  emptyAction,
  rowKey,
}: Props<T>) {
  if (loading) return <Spinner />;
  if (!rows || rows.length === 0)
    return <EmptyState title={emptyTitle} hint={emptyHint} action={emptyAction} />;

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="th">{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row) : row.id ?? i}
                className={onRowClick ? 'cursor-pointer hover:bg-slate-50' : ''}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`td ${c.className ?? ''}`}>
                    {c.render ? c.render(row) : row[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
