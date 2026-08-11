/**
 * Column descriptor used by `DataTable` to render cells, sort rows and filter by field.
 *
 * The descriptor keeps presentation concerns (label, align) decoupled from data
 * concerns (accessor + comparator), so the same column can be reused across
 * server and client side tables. The comparator is only required when the
 * column is declared `sortable`.
 *
 * @example
 * ```ts
 * const nameColumn: DataTableColumn<UserProfile> = {
 *   key: 'username',
 *   label: 'common.username',
 *   sortable: true,
 *   accessor: (u) => u.username,
 *   comparator: (a, b) => a.username.localeCompare(b.username),
 * };
 * ```
 */
import type { TranslationKey } from '../../../i18n/en';

export interface DataTableColumn<T> {
  /** Stable identifier persisted in the URL / state. */
  readonly key: string;
  /** i18n translation key rendered in the header cell. Empty string hides the header label. */
  readonly label: TranslationKey | '';
  /** Whether the user can sort by this column. Defaults to `false`. */
  readonly sortable?: boolean;
  /** Whether the column participates in the global search. */
  readonly searchable?: boolean;
  /** Optional comparator implementing the Strategy pattern for sorting. */
  readonly comparator?: (a: T, b: T) => number;
  /** Optional accessor used by both the global search and the per-column text filter. */
  readonly accessor?: (row: T) => string | number | null | undefined;
  /** Optional filter options. When provided, renders a dropdown for this column. */
  readonly filterOptions?: readonly DataTableFilterOption[];
  /** Optional alignment for the rendered cell. Defaults to `left`. */
  readonly align?: 'left' | 'right' | 'center';
}

/**
 * Option for the column dropdown filter.
 *
 * @example
 * ```ts
 * const statusFilter: DataTableFilterOption = { value: 'paid', label: 'Paid' };
 * ```
 */
export interface DataTableFilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Sortable direction, kept as a primitive so it serializes cleanly into URL params.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Snapshot of the current sort state. `null` means the table is unsorted.
 */
export interface SortState {
  readonly columnKey: string;
  readonly direction: SortDirection;
}

/**
 * Page metadata emitted to the host for server-driven tables.
 *
 * @example
 * ```ts
 * host.onChange({ page: 2, pageSize: 10, search: 'john', sort: { columnKey: 'username', direction: 'asc' } });
 * ```
 */
export interface DataTablePageChange {
  readonly page: number;
  readonly pageSize: number;
  readonly search: string;
  readonly sort: SortState | null;
  readonly columnFilters: Readonly<Record<string, string>>;
}
