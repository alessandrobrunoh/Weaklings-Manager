import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { EmptyState } from '../empty-state/empty-state';
import { ErrorState } from '../error-state/error-state';
import { type IconName } from '../icon/icon';
import { Loading } from '../loading/loading';
import { DataTableCell } from './data-table-cell';
export type {
  DataTableColumn,
  DataTableFilterOption,
  DataTablePageChange,
  SortDirection,
  SortState,
} from './data-table-column';
import type {
  DataTableColumn,
  DataTablePageChange,
  SortDirection,
  SortState,
} from './data-table-column';

const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

/**
 * Generic, reusable data table with built-in pagination, search, per-column
 * filters and column sorting.
 *
 * Operates in two modes:
 * - **Client mode** (default): pass the full dataset via `rows`. The component
 *   handles slicing, sorting and filtering in memory.
 * - **Server mode**: set `serverMode = true` and provide `totalItems`. The
 *   component becomes stateless for data, emitting `pageChange` whenever the
 *   user moves the page, types a search, picks a filter or sorts a column.
 *
 * The component is intentionally presentational: it never owns data fetching,
 * so it can be reused across the battles, events, bank, siphoned and users
 * features without coupling to their respective API services.
 *
 * @example
 * ```html
 * <app-data-table
 *   [columns]="columns"
 *   [rows]="users()"
 *   [trackBy]="trackById"
 * />
 * ```
 *
 * @example Server-side pagination
 * ```html
 * <app-data-table
 *   [columns]="columns"
 *   [rows]="users()"
 *   [serverMode]="true"
 *   [totalItems]="totalItems()"
 *   [loading]="isLoading()"
 *   (pageChange)="loadPage($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-data-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Loading, NgTemplateOutlet],
  templateUrl: './data-table.html',
  styleUrl: './data-table.css',
})
export class DataTable<T> {
  private readonly translate = inject(TranslateService);

  /** Column descriptors that drive rendering, sorting and filtering. */
  readonly columns = input.required<readonly DataTableColumn<T>[]>();

  /** Source rows. In `serverMode` only the current page should be passed. */
  readonly rows = input.required<readonly T[]>();

  /** Optional loading flag rendered instead of the table body. */
  readonly loading = input(false);

  /**
   * Set when the load that would have populated `rows` failed. Takes
   * precedence over the empty state so a failed fetch never reads as "there
   * is nothing here" — see `ErrorState`. Clear it before retrying so the
   * table falls back to its normal loading/empty/data states.
   */
  readonly error = input(false);

  /** Emitted when the user presses retry on the error state. */
  readonly retry = output<void>();

  /** Optional empty state message. */
  readonly emptyLabel = input<TranslationKey>('common.empty');

  /** Optional empty state icon. */
  readonly emptyIcon = input<IconName>('sparkles');

  /** Total number of items in the dataset. Ignored in client mode. */
  readonly totalItems = input<number>(0);

  /** Page size. Defaults to 10. */
  readonly pageSize = input<number>(DEFAULT_PAGE_SIZE);

  /** Available page size options shown in the size selector. */
  readonly pageSizeOptions = input<readonly number[]>(DEFAULT_PAGE_SIZES);

  /**
   * When `true`, the table becomes stateless and emits `pageChange` for every
   * interaction. The host is responsible for re-supplying `rows`.
   */
  readonly serverMode = input(false);

  /** When `true`, hides the search box. */
  readonly hideSearch = input(false);

  /** When `true`, hides the page size selector. */
  readonly hidePageSize = input(false);

  /** Stable identity function used by `@for` track. Required for change detection. */
  readonly trackBy = input.required<(row: T) => unknown>();

  /** Emitted whenever any state relevant to data fetching changes. */
  readonly pageChange = output<DataTablePageChange>();

  /**
   * When true, body rows are clickable and emit `rowClick`. Officers use this
   * on the members table to open the XP adjust drawer; members never see it.
   */
  readonly rowClickable = input(false);

  /** Emitted when a clickable row is activated (click or Enter/Space). */
  readonly rowClick = output<T>();

  /** Per-column projected cell templates (`*dataTableCell="'key'"`). */
  readonly cellDirectives = contentChildren(DataTableCell);

  /** Map of column key -> projected cell template for O(1) lookup in the view. */
  protected readonly cellTemplates = computed(() => {
    const map = new Map<string, DataTableCell>();
    for (const directive of this.cellDirectives()) {
      map.set(directive.columnKey(), directive);
    }
    return map;
  });

  /** Internal state signals. */
  protected readonly page = signal(1);
  protected readonly currentPageSize = signal(DEFAULT_PAGE_SIZE);
  protected readonly search = signal('');
  protected readonly sort = signal<SortState | null>(null);
  protected readonly columnFilters = signal<Readonly<Record<string, string>>>({});

  protected readonly t = (key: TranslationKey | '') => (key === '' ? '' : this.translate.t(key));

  constructor() {
    // Synchronise the page size signal with the input.
    effect(() => this.currentPageSize.set(this.pageSize()));

    // Reset to first page whenever structural inputs change. In server mode the
    // host keeps responsibility for resetting on its own data changes.
    effect(() => {
      this.columns();
      this.currentPageSize.set(this.pageSize());
      this.page.set(1);
      this.search.set('');
      this.sort.set(null);
      this.columnFilters.set({});
    });
  }

  /** Filtered, sorted and sliced rows shown in the current page (client mode). */
  protected readonly processedRows = computed<readonly T[]>(() => {
    if (this.serverMode()) {
      return this.rows();
    }
    const filtered = this.applyFilters(this.rows());
    const sorted = this.applySort(filtered);
    return this.applyPagination(sorted);
  });

  /** Total items after client-side filtering, used to compute page count. */
  protected readonly visibleTotal = computed<number>(() => {
    if (this.serverMode()) {
      return Math.max(0, this.totalItems());
    }
    return this.applyFilters(this.rows()).length;
  });

  protected readonly totalPages = computed<number>(() => {
    const total = this.visibleTotal();
    if (total === 0) {
      return 1;
    }
    return Math.max(1, Math.ceil(total / this.currentPageSize()));
  });

  /** True when at least one column exposes filter options. */
  protected readonly hasColumnFilters = computed(() =>
    this.columns().some((column) => column.filterOptions && column.filterOptions.length > 0),
  );

  protected readonly showToolbar = computed(() => !this.hideSearch() || this.hasColumnFilters());

  /**
   * Returns the next direction when toggling the same column.
   * Order is asc -> desc -> none.
   */
  protected nextDirection(columnKey: string, current: SortState | null): SortState | null {
    if (!current || current.columnKey !== columnKey) {
      return { columnKey, direction: 'asc' };
    }
    if (current.direction === 'asc') {
      return { columnKey, direction: 'desc' };
    }
    return null;
  }

  protected toggleSort(column: DataTableColumn<T>): void {
    if (!column.sortable) {
      return;
    }
    this.sort.set(this.nextDirection(column.key, this.sort()));
    this.page.set(1);
    this.emitChange();
  }

  protected onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    this.page.set(1);
    this.emitChange();
  }

  protected onColumnFilter(columnKey: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.columnFilters.update((filters) => ({ ...filters, [columnKey]: value }));
    this.page.set(1);
    this.emitChange();
  }

  protected onPageSize(event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    this.currentPageSize.set(value);
    this.page.set(1);
    this.emitChange();
  }

  protected nextPage(): void {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => Math.min(this.totalPages(), p + 1));
    this.emitChange();
  }

  protected prevPage(): void {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => Math.max(1, p - 1));
    this.emitChange();
  }

  protected columnFilterValue(columnKey: string): string {
    return this.columnFilters()[columnKey] ?? '';
  }

  protected sortIndicator(columnKey: string): string {
    const current = this.sort();
    if (!current || current.columnKey !== columnKey) {
      return '';
    }
    return current.direction === 'asc' ? '▲' : '▼';
  }

  protected onRowClick(row: T): void {
    if (!this.rowClickable()) {
      return;
    }
    this.rowClick.emit(row);
  }

  protected onRowKeydown(event: KeyboardEvent, row: T): void {
    if (!this.rowClickable()) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.rowClick.emit(row);
    }
  }

  protected columnAlign(column: DataTableColumn<T>): string {
    const align = column.align ?? 'left';
    return `data-table__cell--${align}`;
  }

  /** Fallback textual rendering used when no per-column template is provided. */
  protected renderCell(row: T, column: DataTableColumn<T>): string {
    const value = column.accessor
      ? column.accessor(row)
      : (row as Record<string, unknown>)[column.key];
    if (value === null || value === undefined) {
      return '';
    }
    return String(value);
  }

  private applyFilters(rows: readonly T[]): T[] {
    const search = this.search().trim().toLowerCase();
    const columnFilters = this.columnFilters();
    const searchableColumns = this.columns().filter(
      (column) => column.searchable && column.accessor,
    );
    return rows.filter((row) => {
      if (search && searchableColumns.length > 0) {
        const matches = searchableColumns.some((column) => {
          const value = column.accessor!(row);
          return (
            value !== null && value !== undefined && String(value).toLowerCase().includes(search)
          );
        });
        if (!matches) {
          return false;
        }
      }
      for (const [key, value] of Object.entries(columnFilters)) {
        if (!value) {
          continue;
        }
        const column = this.columns().find((current) => current.key === key);
        if (!column?.accessor) {
          continue;
        }
        const cell = String(column.accessor(row) ?? '');
        if (cell !== value) {
          return false;
        }
      }
      return true;
    });
  }

  private applySort(rows: readonly T[]): T[] {
    const state = this.sort();
    if (!state) {
      return [...rows];
    }
    const column = this.columns().find((current) => current.key === state.columnKey);
    if (!column?.comparator) {
      return [...rows];
    }
    const direction: SortDirection = state.direction;
    const copy: T[] = [...rows];
    copy.sort(column.comparator);
    if (direction === 'desc') {
      copy.reverse();
    }
    return copy;
  }

  private applyPagination(rows: readonly T[]): T[] {
    if (this.serverMode()) {
      return [...rows];
    }
    const start = (this.page() - 1) * this.currentPageSize();
    return [...rows].slice(start, start + this.currentPageSize());
  }

  private emitChange(): void {
    this.pageChange.emit({
      page: this.page(),
      pageSize: this.currentPageSize(),
      search: this.search(),
      sort: this.sort(),
      columnFilters: this.columnFilters(),
    });
  }
}
