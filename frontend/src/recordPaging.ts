export type RecordPage<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
};
export type RfqFilters = {
  approval?: string;
  search?: string;
  status?: string;
  code?: string;
  type?: string;
  sort?: string;
};
export type ClaimFilters = {
  search?: string;
  status?: string;
  outcome?: string;
  company?: string;
  reason?: string;
  from?: string;
  to?: string;
  sla?: string;
};
export type ClaimSummary = {
  total: number;
  open: number;
  overdue: number;
  dueSoon: number;
  completed: number;
  rejected: number;
  averageAge: number;
  creditReceived: number;
  byStatus: Record<string, number>;
  byCompany: Record<string, number>;
};
export const EMPTY_CLAIM_SUMMARY: ClaimSummary = {
  total: 0,
  open: 0,
  overdue: 0,
  dueSoon: 0,
  completed: 0,
  rejected: 0,
  averageAge: 0,
  creditReceived: 0,
  byStatus: {},
  byCompany: {},
};

// Full retrieval is reserved for an explicit export, never list rendering.
export async function collectExportPages<T extends { id: string }>(
  load: (offset: number) => Promise<RecordPage<T>>,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  do {
    const page = await load(items.length);
    if (total !== undefined && page.total !== total)
      throw new Error(
        "Matching records changed during export. Please export again.",
      );
    total = page.total;
    if (!page.items.length && items.length < total)
      throw new Error(
        "The export could not load all matching records. Please try again.",
      );
    for (const item of page.items) {
      if (seen.has(item.id))
        throw new Error(
          "Matching records changed during export. Please export again.",
        );
      seen.add(item.id);
      items.push(item);
    }
  } while (items.length < total);
  return items;
}
