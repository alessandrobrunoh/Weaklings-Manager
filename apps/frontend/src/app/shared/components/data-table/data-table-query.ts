import type { ParamMap } from '@angular/router';

import type { DataTablePageChange, SortState } from './data-table-column';

export const DATA_TABLE_SEARCH_PARAM = 'search';
export const DATA_TABLE_PAGE_PARAM = 'page';
export const DATA_TABLE_SIZE_PARAM = 'size';
export const DATA_TABLE_SORT_PARAM = 'sort';

const RESERVED_FILTER_KEYS = new Set([
  DATA_TABLE_SEARCH_PARAM,
  DATA_TABLE_PAGE_PARAM,
  DATA_TABLE_SIZE_PARAM,
  DATA_TABLE_SORT_PARAM,
]);

export interface ParseDataTableQueryOptions {
  readonly prefix?: string;
  readonly defaultPageSize?: number;
  readonly filterKeys?: readonly string[];
}

/** Builds a query-param name, namespaced when several tables share a page. */
export function dataTableQueryKey(name: string, prefix = ''): string {
  return prefix ? `${prefix}.${name}` : name;
}

/**
 * Column filters use the column key directly (`status`, `role`) so existing
 * deep-links such as `/admin/transactions?status=pending` keep working.
 * Reserved pagination keys are prefixed with `f.` to avoid collisions.
 */
export function dataTableFilterQueryKey(columnKey: string, prefix = ''): string {
  const name = RESERVED_FILTER_KEYS.has(columnKey) ? `f.${columnKey}` : columnKey;
  return dataTableQueryKey(name, prefix);
}

export function emptyDataTableQuery(pageSize = 10): DataTablePageChange {
  return { page: 1, pageSize, search: '', sort: null, columnFilters: {} };
}

export function parseDataTableQuery(
  params: ParamMap,
  options: ParseDataTableQueryOptions = {},
): DataTablePageChange {
  const prefix = options.prefix ?? '';
  const defaultPageSize = options.defaultPageSize ?? 10;
  const search = params.get(dataTableQueryKey(DATA_TABLE_SEARCH_PARAM, prefix)) ?? '';
  const page = parsePositiveInt(params.get(dataTableQueryKey(DATA_TABLE_PAGE_PARAM, prefix)), 1);
  const pageSize = parsePositiveInt(
    params.get(dataTableQueryKey(DATA_TABLE_SIZE_PARAM, prefix)),
    defaultPageSize,
  );
  const sort = parseSort(params.get(dataTableQueryKey(DATA_TABLE_SORT_PARAM, prefix)));
  const columnFilters: Record<string, string> = {};
  for (const key of options.filterKeys ?? []) {
    const value = params.get(dataTableFilterQueryKey(key, prefix));
    if (value) {
      columnFilters[key] = value;
    }
  }
  return { page, pageSize, search, sort, columnFilters };
}

/**
 * Values to merge into the current URL. `null` removes a key so a shared link
 * does not keep a stale filter after the user clears it.
 */
export function serializeDataTableQuery(
  state: DataTablePageChange,
  options: ParseDataTableQueryOptions = {},
): Record<string, string | null> {
  const prefix = options.prefix ?? '';
  const defaultPageSize = options.defaultPageSize ?? 10;
  const query: Record<string, string | null> = {
    [dataTableQueryKey(DATA_TABLE_SEARCH_PARAM, prefix)]: state.search.trim() || null,
    [dataTableQueryKey(DATA_TABLE_PAGE_PARAM, prefix)]: state.page > 1 ? String(state.page) : null,
    [dataTableQueryKey(DATA_TABLE_SIZE_PARAM, prefix)]:
      state.pageSize !== defaultPageSize ? String(state.pageSize) : null,
    [dataTableQueryKey(DATA_TABLE_SORT_PARAM, prefix)]: serializeSort(state.sort),
  };
  const filterKeys = options.filterKeys ?? Object.keys(state.columnFilters);
  for (const key of filterKeys) {
    query[dataTableFilterQueryKey(key, prefix)] = state.columnFilters[key] || null;
  }
  return query;
}

export function dataTableQueriesEqual(a: DataTablePageChange, b: DataTablePageChange): boolean {
  if (a.page !== b.page || a.pageSize !== b.pageSize || a.search !== b.search) {
    return false;
  }
  if ((a.sort?.columnKey ?? '') !== (b.sort?.columnKey ?? '')) {
    return false;
  }
  if ((a.sort?.direction ?? '') !== (b.sort?.direction ?? '')) {
    return false;
  }
  return filtersEqual(a.columnFilters, b.columnFilters);
}

export function dataTableQueryMatchesParams(
  params: ParamMap,
  serialized: Readonly<Record<string, string | null>>,
): boolean {
  for (const [key, value] of Object.entries(serialized)) {
    const current = params.get(key);
    if (value === null || value === '') {
      if (current) {
        return false;
      }
      continue;
    }
    if (current !== value) {
      return false;
    }
  }
  return true;
}

function filtersEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => left[key]);
  const rightKeys = Object.keys(right).filter((key) => right[key]);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseSort(raw: string | null): SortState | null {
  if (!raw) {
    return null;
  }
  if (raw.startsWith('-')) {
    const columnKey = raw.slice(1);
    return columnKey ? { columnKey, direction: 'desc' } : null;
  }
  return { columnKey: raw, direction: 'asc' };
}

function serializeSort(sort: SortState | null): string | null {
  if (!sort?.columnKey) {
    return null;
  }
  return sort.direction === 'desc' ? `-${sort.columnKey}` : sort.columnKey;
}
