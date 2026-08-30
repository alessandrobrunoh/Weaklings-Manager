import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { SplitIsland, SplitIslandCity } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const ISLAND_CITIES: readonly SplitIslandCity[] = [
  'lymhurst',
  'bridgewatch',
  'martlock',
  'fort_sterling',
  'thetford',
  'caerleon',
  'brecilien',
];

/**
 * Island catalog: cities, islands, and loot tabs used when locating splits.
 *
 * Moved out of the splits page so members pick a location there and admins
 * maintain the catalog here (`splits.islands.manage`). Create uses the shared
 * native `<dialog>` shell so focus, Esc, and light-dismiss stay with the browser.
 */
@Component({
  selector: 'app-admin-islands',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, PageHeader, PageStack],
  template: `
    <app-page-header [title]="t('admin.islands.title')" [subtitle]="t('admin.islands.hint')">
      <button type="button" class="btn btn--primary" (click)="openCreate()">
        {{ t('admin.islands.create') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <app-data-table
        [columns]="columns()"
        [rows]="islands()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [emptyLabel]="'admin.islands.empty'"
        emptyIcon="swords"
        [pageSize]="25"
      >
        <ng-template dataTableCell="tabs" let-row>
          <div class="flex flex-col gap-2">
            <div class="flex flex-wrap gap-1.5">
              @for (tab of row.tabs; track tab.id) {
                <span class="chip">{{ tab.name }}</span>
              }
            </div>
            <form class="flex flex-wrap gap-2" (submit)="onAddTab($event, row.id)">
              <input
                class="input"
                style="max-width: 12rem"
                type="text"
                [value]="newTabNameByIsland()[row.id] ?? ''"
                (input)="onNewTabName(row.id, $event)"
                [attr.placeholder]="t('admin.islands.newTab')"
                [attr.aria-label]="t('admin.islands.newTab')"
              />
              <button
                type="submit"
                class="btn btn--outline btn--sm"
                [disabled]="addingTabId() === row.id"
              >
                {{ t('admin.islands.addTab') }}
              </button>
            </form>
          </div>
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <button
            type="button"
            class="btn btn--danger btn--sm"
            [disabled]="deletingId() === row.id"
            (click)="deleteIsland(row.id)"
          >
            {{ t('common.delete') }}
          </button>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('admin.islands.create')" (closed)="closeCreate()">
        <form id="create-island-form" class="grid gap-4" (submit)="onCreateIsland($event)">
          <label>
            <span class="label">{{ t('admin.islands.location') }}</span>
            <select class="select" [value]="newIslandCity()" (change)="onNewIslandCity($event)">
              @for (city of islandCities; track city) {
                <option [value]="city">{{ cityLabel(city) }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('admin.islands.island') }}</span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="newIslandName()"
              (input)="onNewIslandName($event)"
            />
          </label>
          <label>
            <span class="label">{{ t('admin.islands.tabs') }}</span>
            <input
              class="input"
              type="text"
              required
              [value]="newIslandTabs()"
              (input)="onNewIslandTabs($event)"
              [attr.placeholder]="t('admin.islands.tabsPlaceholder')"
            />
            <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
              {{ t('admin.islands.tabsHint') }}
            </span>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-island-form"
            [disabled]="catalogSaving()"
          >
            {{ t('admin.islands.create') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class AdminIslands {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly islandCities = ISLAND_CITIES;
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly catalogSaving = signal(false);
  protected readonly addingTabId = signal<number | null>(null);
  protected readonly deletingId = signal<number | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly newIslandCity = signal<SplitIslandCity>('lymhurst');
  protected readonly newIslandName = signal('');
  protected readonly newIslandTabs = signal('');
  protected readonly newTabNameByIsland = signal<Record<number, string>>({});

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly trackById = (row: SplitIsland): number => row.id;

  protected readonly columns = computed<readonly DataTableColumn<SplitIsland>[]>(() => [
    {
      key: 'city',
      label: 'admin.islands.location',
      sortable: true,
      searchable: true,
      accessor: (row) => this.cityLabel(row.city),
      comparator: (a, b) => this.cityLabel(a.city).localeCompare(this.cityLabel(b.city)),
      filterOptions: this.islandCities.map((city) => ({
        value: this.cityLabel(city),
        label: this.cityLabel(city),
      })),
    },
    {
      key: 'name',
      label: 'admin.islands.island',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    { key: 'tabs', label: 'admin.islands.tabs' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  constructor() {
    void this.load();
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected openCreate(): void {
    this.newIslandCity.set('lymhurst');
    this.newIslandName.set('');
    this.newIslandTabs.set('');
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  protected onNewIslandCity(event: Event): void {
    this.newIslandCity.set((event.target as HTMLSelectElement).value as SplitIslandCity);
  }

  protected onNewIslandName(event: Event): void {
    this.newIslandName.set((event.target as HTMLInputElement).value);
  }

  protected onNewIslandTabs(event: Event): void {
    this.newIslandTabs.set((event.target as HTMLInputElement).value);
  }

  protected onNewTabName(islandId: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.newTabNameByIsland.update((current) => ({ ...current, [islandId]: value }));
  }

  protected async onCreateIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = this.newIslandName().trim();
    const tabs = this.newIslandTabs()
      .split(',')
      .map((tab) => tab.trim())
      .filter((tab) => tab.length > 0);
    if (!name || tabs.length === 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    this.catalogSaving.set(true);
    try {
      await firstValueFrom(
        this.api.post<SplitIsland>('api/splits/islands', {
          name,
          city: this.newIslandCity(),
          tabs,
        }),
      );
      this.closeCreate();
      await this.refresh();
      this.toasts.success(this.t('admin.islands.created'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.catalogSaving.set(false);
    }
  }

  protected async onAddTab(event: SubmitEvent, islandId: number): Promise<void> {
    event.preventDefault();
    const name = (this.newTabNameByIsland()[islandId] ?? '').trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    this.addingTabId.set(islandId);
    try {
      await firstValueFrom(
        this.api.post<SplitIsland>(`api/splits/islands/${islandId}/tabs`, { name }),
      );
      this.newTabNameByIsland.update((current) => ({ ...current, [islandId]: '' }));
      await this.refresh();
      this.toasts.success(this.t('admin.islands.tabAdded'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.addingTabId.set(null);
    }
  }

  protected async deleteIsland(islandId: number): Promise<void> {
    if (typeof window !== 'undefined' && !window.confirm(this.t('common.confirm'))) {
      return;
    }
    this.deletingId.set(islandId);
    try {
      await firstValueFrom(this.api.delete(`api/splits/islands/${islandId}`));
      await this.refresh();
      this.toasts.success(this.t('admin.islands.deleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.deletingId.set(null);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      this.islands.set(islands);
    } catch (error) {
      this.loadFailed.set(true);
      this.islands.set([]);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
