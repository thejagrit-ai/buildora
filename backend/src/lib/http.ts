import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 50;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(DEFAULT_PAGE_SIZE),
  sort: z.string().optional(), // "field:asc" | "field:desc"
  q: z.string().optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export function paginate(query: ListQuery) {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

export function orderBy(sort?: string, fallback: Record<string, 'asc' | 'desc'> = { createdAt: 'desc' }) {
  if (!sort) return fallback;
  const [field, dir] = sort.split(':');
  return { [field]: dir === 'asc' ? 'asc' : 'desc' } as Record<string, 'asc' | 'desc'>;
}

export function pageMeta(total: number, query: ListQuery) {
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}
