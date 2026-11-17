/** Page size used when collecting every row for an export (the backend maximum). */
export const EXPORT_PAGE_LIMIT = 1000;

/** Safety cap on the number of pages fetched for one export. */
export const EXPORT_MAX_PAGES = 50;

/**
 * Collects the items of every page of a paginated endpoint, for CSV exports of server-mode
 * tables. Stops at the last page, on an empty page, or after `EXPORT_MAX_PAGES`.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, limit: number) => Promise<{ items: readonly T[]; total_pages: number }>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= EXPORT_MAX_PAGES; page++) {
    const result = await fetchPage(page, EXPORT_PAGE_LIMIT);
    items.push(...result.items);
    if (page >= result.total_pages || result.items.length === 0) {
      break;
    }
  }
  return items;
}
