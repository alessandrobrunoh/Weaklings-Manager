import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { SplitIsland, SplitIslandCity, UpdateIslandRequest } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import {
  groupIslandsBySourceGuild,
  type SourceGuildIslandGroup,
} from './group-islands-by-source-guild';

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
 * Members pick a location on the splits page; admins maintain the catalog here
 * (guild tenants). Alliance tenants see the islands synced from each member guild,
 * grouped by source guild, read-only. Create uses the shared native `<dialog>`
 * shell so focus, Esc, and light-dismiss stay with the browser.
 */
@Component({
  selector: 'app-admin-islands',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, Icon, Menu, PageHeader, PageStack, RouterLink, SummaryBand],
  styles: [COMPACT_FEATURE_STYLES],
  template: `
    <app-page-header [title]="t('admin.islands.title')" [subtitle]="pageSubtitle()">
      @if (canMutateCatalog()) {
        <button type="button" class="btn btn--primary btn--sm inline-flex items-center gap-1.5" (click)="openCreate()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('admin.islands.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      @if (!canMutateCatalog()) {
        <p class="hint">{{ t('admin.islands.readonlyHint') }}</p>
      }

      <app-summary-band [ariaLabel]="t('admin.islands.title')" [items]="summaryItems()" />

      @for (group of displayGroups(); track group.sourceGuildTenantId ?? 'unknown') {
        <section class="grid gap-3">
          @if (!canMutateCatalog() && group.items.length > 0) {
            <h2 class="section-title">
              {{ group.sourceGuildName ?? t('admin.islands.unknownGuild') }}
            </h2>
          }
          <app-data-table
            [columns]="columns()"
            [rows]="group.items"
            [loading]="loading()"
            [error]="loadFailed()"
            (retry)="load()"
            [trackBy]="trackById"
            [emptyLabel]="emptyLabel()"
            emptyIcon="swords"
            [pageSize]="25"
            [syncUrl]="false"
            [ariaLabel]="group.sourceGuildName ?? t('admin.islands.title')"
            [rowClickable]="true"
            (rowClick)="openIsland($event)"
          >
            <ng-template dataTableCell="name" let-row>
              <a
                class="font-medium text-(--color-text) no-underline hover:underline"
                [routerLink]="['/admin/islands', row.id]"
              >
                {{ row.name }}
              </a>
            </ng-template>
            <ng-template dataTableCell="tabs" let-row>
              <div class="flex flex-wrap gap-1.5">
                @for (tab of row.tabs; track tab.id) {
                  <span class="chip">{{ tab.name }}</span>
                }
              </div>
            </ng-template>
            @if (canMutateCatalog()) {
              <ng-template dataTableCell="actions" let-row>
                <div class="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    class="btn btn--outline btn--sm"
                    (click)="openEdit(row)"
                  >
                    {{ t('common.edit') }}
                  </button>
                  <app-menu
                    [items]="rowMenuItems()"
                    [label]="t('common.actions')"
                    align="end"
                    (itemSelect)="onRowMenu(row, $event)"
                  />
                </div>
              </ng-template>
            }
          </app-data-table>
        </section>
      }
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('admin.islands.create')" (closed)="closeCreate()">
        <form id="create-island-form" class="grid gap-4" (submit)="onCreateIsland($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label>
            <span class="label">{{ t('admin.islands.location') }}</span>
            <select class="select" [value]="newIslandCity()" (change)="onNewIslandCity($event)">
              @for (city of islandCities; track city) {
                <option [value]="city">{{ cityLabel(city) }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('admin.islands.island') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
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
            <span class="label">{{ t('admin.islands.tabs') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="text"
              required
              [value]="newIslandTabs()"
              (input)="onNewIslandTabs($event)"
              [attr.placeholder]="t('admin.islands.tabsPlaceholder')"
            />
            <span class="hint mt-1 block">{{ t('admin.islands.tabsHint') }}</span>
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

    @if (editTarget(); as island) {
      <app-dialog [title]="t('admin.islands.editTitle')" size="sm" (closed)="closeEdit()">
        <form id="edit-island-form" class="grid gap-4" (submit)="onEditIsland($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block">
            <span class="label">{{ t('admin.islands.location') }}</span>
            <select
              class="select"
              [value]="editIslandCity()"
              (change)="onEditIslandCity($event)"
            >
              @for (city of islandCities; track city) {
                <option [value]="city">{{ cityLabel(city) }}</option>
              }
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t('admin.islands.island') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="editIslandName()"
              (input)="onEditIslandName($event)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeEdit()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="edit-island-form"
            [disabled]="editSaving()"
          >
            {{ editSaving() ? t('common.loading') : t('admin.islands.save') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (deleteTarget(); as island) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteTarget.set(null)">
        <p>{{ t('common.confirm') }}</p>
        <p class="mt-2 font-medium">{{ cityLabel(island.city) }} · {{ island.name }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="deleteTarget.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="confirmDelete()">
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class AdminIslands {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly islandCities = ISLAND_CITIES;
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly canMutateCatalog = computed(
    () => this.auth.profile()?.tenant_kind !== 'alliance',
  );
  protected readonly pageSubtitle = computed(() =>
    this.canMutateCatalog() ? this.t('admin.islands.hint') : this.t('admin.islands.allianceHint'),
  );
  protected readonly emptyLabel = computed<TranslationKey>(() =>
    this.canMutateCatalog() ? 'admin.islands.empty' : 'admin.islands.allianceEmpty',
  );
  protected readonly displayGroups = computed<readonly SourceGuildIslandGroup<SplitIsland>[]>(() => {
    const islands = this.islands();
    if (this.canMutateCatalog() || islands.length === 0) {
      return [{ sourceGuildTenantId: null, sourceGuildName: null, items: islands }];
    }
    return groupIslandsBySourceGuild(islands);
  });
  protected readonly totalTabsCount = computed(() => {
    return this.islands().reduce((sum, island) => sum + (island.tabs?.length ?? 0), 0);
  });
  protected readonly uniqueCitiesCount = computed(() => {
    return new Set(this.islands().map((i) => i.city)).size;
  });
  protected readonly sourceGuildCount = computed(
    () => this.displayGroups().filter((group) => group.sourceGuildTenantId !== null).length,
  );
  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => {
    const items: SummaryItem[] = [
      { label: this.t('admin.stat.islands'), value: this.islands().length },
      { label: this.t('admin.islands.tabs'), value: this.totalTabsCount() },
      { label: this.t('admin.islands.summary.cities'), value: this.uniqueCitiesCount() },
    ];
    if (!this.canMutateCatalog()) {
      items.push({
        label: this.t('admin.islands.summary.sourceGuilds'),
        value: this.sourceGuildCount(),
      });
    }
    return items;
  });
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly catalogSaving = signal(false);
  protected readonly deletingId = signal<number | null>(null);
  protected readonly createOpen = signal(false);
  protected readonly deleteTarget = signal<SplitIsland | null>(null);
  protected readonly editTarget = signal<SplitIsland | null>(null);
  protected readonly editIslandCity = signal<SplitIslandCity>('lymhurst');
  protected readonly editIslandName = signal('');
  protected readonly editSaving = signal(false);
  protected readonly newIslandCity = signal<SplitIslandCity>('lymhurst');
  protected readonly newIslandName = signal('');
  protected readonly newIslandTabs = signal('');

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly trackById = (row: SplitIsland): number => row.id;

  protected readonly rowMenuItems = computed<readonly MenuItem[]>(() => [
    {
      id: 'delete',
      label: this.t('common.delete'),
      danger: true,
      disabled: this.deletingId() !== null,
    },
  ]);

  protected readonly columns = computed<readonly DataTableColumn<SplitIsland>[]>(() => {
    const columns: DataTableColumn<SplitIsland>[] = [
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
    ];
    if (this.canMutateCatalog()) {
      columns.push({ key: 'actions', label: 'common.actions', align: 'right' });
    }
    return columns;
  });

  constructor() {
    void this.load();
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected openIsland(row: SplitIsland): void {
    void this.router.navigate(['/admin/islands', row.id]);
  }

  protected openCreate(): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.newIslandCity.set('lymhurst');
    this.newIslandName.set('');
    this.newIslandTabs.set('');
    this.createOpen.set(true);
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  protected openEdit(island: SplitIsland): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.editTarget.set(island);
    this.editIslandCity.set(island.city);
    this.editIslandName.set(island.name);
  }

  protected closeEdit(): void {
    this.editTarget.set(null);
  }

  protected onRowMenu(island: SplitIsland, id: string): void {
    if (id === 'delete') {
      this.askDelete(island);
    }
  }

  protected onEditIslandCity(event: Event): void {
    this.editIslandCity.set((event.target as HTMLSelectElement).value as SplitIslandCity);
  }

  protected onEditIslandName(event: Event): void {
    this.editIslandName.set((event.target as HTMLInputElement).value);
  }

  protected async onEditIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canMutateCatalog()) {
      return;
    }
    const island = this.editTarget();
    if (!island) {
      return;
    }
    const name = this.editIslandName().trim();
    const city = this.editIslandCity();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    this.editSaving.set(true);
    try {
      const payload: UpdateIslandRequest = { name, city };
      await firstValueFrom(
        this.api.patch<SplitIsland>(`api/splits/islands/${island.id}`, payload),
      );
      this.closeEdit();
      await this.refresh();
      this.toasts.success(this.t('admin.islands.updated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.editSaving.set(false);
    }
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

  protected async onCreateIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canMutateCatalog()) {
      return;
    }
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

  protected askDelete(island: SplitIsland): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.deleteTarget.set(island);
  }

  protected async confirmDelete(): Promise<void> {
    if (!this.canMutateCatalog()) {
      return;
    }
    const island = this.deleteTarget();
    this.deleteTarget.set(null);
    if (!island) {
      return;
    }
    const islandId = island.id;
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
