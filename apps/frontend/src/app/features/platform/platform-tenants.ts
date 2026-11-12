import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';

type KindFilter = 'all' | 'guild' | 'alliance';
type StatusFilter = 'all' | 'active' | 'suspended' | 'provisioning';

/**
 * Control-plane tenant list: register, suspend, and resume Discord servers (guilds and alliances).
 *
 * The page owns the search and facet state and filters the rows it already loaded; the summary
 * band counts every tenant, not the filtered subset. Each name links to the tenant detail page.
 */
@Component({
  selector: 'app-platform-tenants',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    FilterBar,
    Icon,
    Menu,
    PageHeader,
    PageStack,
    RouterLink,
    StatusChip,
    SummaryBand,
  ],
  template: `
    <app-page-header [title]="t('platform.tenants.title')" [subtitle]="t('platform.tenants.subtitle')">
      <button
        type="button"
        class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
        (click)="createOpen.set(true)"
      >
        <app-icon name="plus" size="0.875rem" />
        {{ t('platform.tenants.create') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <app-summary-band [ariaLabel]="t('platform.tenants.summary.label')" [items]="summary()" />

      <app-filter-bar
        [searchLabel]="t('platform.tenants.searchLabel')"
        [searchPlaceholder]="t('platform.tenants.searchPlaceholder')"
        [query]="query()"
        [activeCount]="activeFilterCount()"
        (queryChange)="query.set($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('platform.tenants.filterKind') }}</span>
          <select class="select select--sm" [value]="kindFilter()" (change)="onKindChange($event)">
            <option value="all">{{ t('common.all') }}</option>
            <option value="guild">{{ t('platform.tenants.kind.guild') }}</option>
            <option value="alliance">{{ t('platform.tenants.kind.alliance') }}</option>
          </select>
        </label>
        <label class="filter-field">
          <span class="filter-field__label">{{ t('platform.tenants.filterStatus') }}</span>
          <select class="select select--sm" [value]="statusFilter()" (change)="onStatusChange($event)">
            <option value="all">{{ t('common.all') }}</option>
            <option value="active">{{ t('platform.tenants.status.active') }}</option>
            <option value="suspended">{{ t('platform.tenants.status.suspended') }}</option>
            <option value="provisioning">{{ t('platform.tenants.status.provisioning') }}</option>
          </select>
        </label>
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="visibleRows()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [hideSearch]="true"
        [emptyLabel]="emptyLabel()"
        emptyIcon="users"
        [pageSize]="25"
        [ariaLabel]="t('platform.tenants.title')"
      >
        <ng-template dataTableCell="name" let-row>
          <a
            class="font-medium text-(--color-text) no-underline hover:underline"
            [routerLink]="['/platform/tenants', row.id]"
          >
            {{ row.name }}
          </a>
          <span class="block font-mono text-xs" style="color: var(--color-text-secondary)">{{ row.id }}</span>
        </ng-template>
        <ng-template dataTableCell="kind" let-row>
          <span class="text-sm">{{ kindLabel(row.kind) }}</span>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
        </ng-template>
        <ng-template dataTableCell="created" let-row>
          <span class="num text-sm">{{ formatDate(row.created_at) }}</span>
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex justify-end">
            <app-menu
              [items]="rowMenu(row)"
              [label]="t('platform.tenants.rowActions', { name: row.name })"
              (itemSelect)="onRowAction(row, $event)"
            />
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog
        [title]="t('platform.tenants.createTitle')"
        [subtitle]="t('platform.tenants.createHint')"
        size="sm"
        (closed)="createOpen.set(false)"
      >
        <form id="create-tenant-form" class="grid gap-4" (submit)="onCreate($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('validation.requiredLegend') }}
          </p>
          <label class="block" for="tenant-id">
            <span class="label">
              {{ t('platform.tenants.id') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              id="tenant-id"
              class="input"
              name="id"
              type="text"
              inputmode="numeric"
              pattern="[0-9]+"
              required
              autocomplete="off"
              [value]="newId()"
              (input)="onText(newId, $event)"
            />
          </label>
          <label class="block" for="tenant-name">
            <span class="label">
              {{ t('platform.tenants.name') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              id="tenant-name"
              class="input"
              name="name"
              type="text"
              required
              autocomplete="off"
              [value]="newName()"
              (input)="onText(newName, $event)"
            />
          </label>
          <label class="block" for="tenant-slug">
            <span class="label">{{ t('platform.tenants.slug') }} ({{ t('common.optional') }})</span>
            <input
              id="tenant-slug"
              class="input"
              name="slug"
              type="text"
              autocomplete="off"
              [value]="newSlug()"
              (input)="onText(newSlug, $event)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="createOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-tenant-form"
            [disabled]="creating()"
          >
            {{ creating() ? t('common.loading') : t('platform.tenants.create') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class PlatformTenants {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tenants = signal<PlatformTenant[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly newId = signal('');
  protected readonly newName = signal('');
  protected readonly newSlug = signal('');

  protected readonly query = signal('');
  protected readonly kindFilter = signal<KindFilter>('all');
  protected readonly statusFilter = signal<StatusFilter>('all');

  protected readonly activeFilterCount = computed(
    () => (this.kindFilter() === 'all' ? 0 : 1) + (this.statusFilter() === 'all' ? 0 : 1),
  );

  /** Rows that pass the search text and both facets. */
  protected readonly visibleRows = computed<readonly PlatformTenant[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const kind = this.kindFilter();
    const status = this.statusFilter();
    return this.tenants().filter((row) => {
      if (kind !== 'all' && row.kind !== kind) {
        return false;
      }
      if (status !== 'all' && row.status !== status) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return [row.name, row.id, row.slug, row.owner_discord_id, row.rank_name].some((field) =>
        field?.toLowerCase().includes(needle),
      );
    });
  });

  /** Counts over every loaded tenant; null while loading so a zero never reads as a result. */
  protected readonly summary = computed<readonly SummaryItem[]>(() => {
    const loaded = !this.loading();
    const rows = this.tenants();
    const count = (predicate: (row: PlatformTenant) => boolean): number | null =>
      loaded ? rows.filter(predicate).length : null;
    return [
      { label: this.t('platform.tenants.summary.total'), value: count(() => true) },
      { label: this.t('platform.tenants.kind.guild'), value: count((row) => row.kind === 'guild') },
      { label: this.t('platform.tenants.kind.alliance'), value: count((row) => row.kind === 'alliance') },
      {
        label: this.t('platform.tenants.status.suspended'),
        value: count((row) => row.status === 'suspended'),
        hint: this.t('platform.tenants.summary.suspendedHint'),
        tone: 'warning',
      },
    ];
  });

  protected readonly emptyLabel = computed<TranslationKey>(() =>
    this.query().trim() || this.activeFilterCount() > 0 ? 'ui.table.noMatches' : 'platform.tenants.empty',
  );

  protected readonly columns = computed<readonly DataTableColumn<PlatformTenant>[]>(() => [
    { key: 'name', label: 'platform.tenants.name', accessor: (row) => row.name },
    { key: 'kind', label: 'platform.tenants.kind', accessor: (row) => row.kind ?? '' },
    { key: 'status', label: 'platform.tenants.status', accessor: (row) => row.status },
    { key: 'created', label: 'platform.tenants.created', accessor: (row) => row.created_at ?? '' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly trackById = (row: PlatformTenant) => row.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  protected onKindChange(event: Event): void {
    this.kindFilter.set((event.target as HTMLSelectElement).value as KindFilter);
  }

  protected onStatusChange(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value as StatusFilter);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.kindFilter.set('all');
    this.statusFilter.set('all');
  }

  constructor() {
    void this.load();
  }

  protected kindLabel(kind: string | undefined): string {
    if (kind === 'guild') {
      return this.t('platform.tenants.kind.guild');
    }
    if (kind === 'alliance') {
      return this.t('platform.tenants.kind.alliance');
    }
    return '—';
  }

  protected statusLabel(status: string): string {
    if (status === 'active') {
      return this.t('platform.tenants.status.active');
    }
    if (status === 'suspended') {
      return this.t('platform.tenants.status.suspended');
    }
    if (status === 'provisioning') {
      return this.t('platform.tenants.status.provisioning');
    }
    return status;
  }

  protected formatDate(value: string | null): string {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return '—';
    }
    return new Intl.DateTimeFormat(this.translate.locale(), { dateStyle: 'medium' }).format(date);
  }

  /** Row actions: suspend an active tenant, resume a suspended one. */
  protected rowMenu(row: PlatformTenant): readonly MenuItem[] {
    const busy = this.busyId() === row.id;
    if (row.status === 'active') {
      return [{ id: 'suspend', label: this.t('platform.tenants.suspend'), danger: true, disabled: busy }];
    }
    if (row.status === 'suspended') {
      return [{ id: 'resume', label: this.t('platform.tenants.resume'), disabled: busy }];
    }
    return [];
  }

  protected onRowAction(row: PlatformTenant, id: string): void {
    if (id === 'suspend') {
      void this.setStatus(row, 'suspended');
    } else if (id === 'resume') {
      void this.setStatus(row, 'active');
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const rows = await firstValueFrom(this.api.get<PlatformTenant[]>('api/platform/tenants'));
      this.tenants.set(rows);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async setStatus(row: PlatformTenant, status: 'active' | 'suspended'): Promise<void> {
    this.busyId.set(row.id);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${row.id}`, { status }),
      );
      this.tenants.update((list) => list.map((item) => (item.id === updated.id ? updated : item)));
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async onCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = this.newId().trim();
    const name = this.newName().trim();
    const slug = this.newSlug().trim();
    if (!id || !name) {
      return;
    }
    this.creating.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<PlatformTenant>('api/platform/tenants', {
          id,
          name,
          slug: slug || undefined,
        }),
      );
      this.tenants.update((list) => [...list, created]);
      this.createOpen.set(false);
      this.newId.set('');
      this.newName.set('');
      this.newSlug.set('');
      this.toasts.success(this.t('platform.tenants.createdToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }
}
