import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateIslandTabRequest,
  SplitIsland,
  SplitIslandCity,
  SplitIslandTab,
  UpdateIslandRequest,
  UpdateIslandTabRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EntityHeader, type EntityMenuItem } from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';

const ISLAND_CITIES: readonly SplitIslandCity[] = [
  'lymhurst',
  'bridgewatch',
  'martlock',
  'fort_sterling',
  'thetford',
  'caerleon',
  'brecilien',
];

const NO_MENU_ITEMS: readonly MenuItem[] = [];

/**
 * Island detail and edit page (`/admin/islands/:islandId`).
 *
 * Sections: the island itself (guild tenants edit name and city), its chest tabs
 * (add, rename, reorder, delete) and who manages it. Alliance tenants see the same
 * page read-only, with the source guild named in the summary and in the management note.
 */
@Component({
  selector: 'app-admin-island-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    EntityHeader,
    ErrorState,
    Loading,
    Menu,
    PageStack,
    RouterLink,
    SummaryBand,
  ],
  template: `
    <a routerLink="/admin/islands" class="btn btn--ghost btn--sm mb-3 inline-flex">
      ← {{ t('admin.islands.detail.back') }}
    </a>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed() || !island()) {
      <app-error-state
        [message]="t('admin.islands.detail.notFound')"
        [retryLabel]="t('common.retry')"
        (retry)="reload()"
      />
    } @else {
      @if (island(); as detail) {
        <app-entity-header
          [title]="detail.name"
          [menuItems]="headerMenu()"
          [menuLabel]="t('entityHeader.moreActions')"
          (menuSelect)="onHeaderMenu($event)"
        >
          <app-summary-band entitySummary [ariaLabel]="t('admin.islands.detail.title')" [items]="summaryItems()" />
        </app-entity-header>

        <app-page-stack>
          @if (!canMutateCatalog()) {
            <p class="hint">{{ t('admin.islands.readonlyHint') }}</p>
          }

          <!-- What the island is: name and city, editable by guild tenants -->
          @if (canMutateCatalog()) {
            <section class="card p-4" aria-labelledby="island-details-title">
              <h2 id="island-details-title" class="section-title">
                {{ t('admin.islands.detail.overview') }}
              </h2>
              <form class="mt-3 grid gap-4" (submit)="onSaveIsland($event)">
                <p class="hint">{{ t('validation.requiredLegend') }}</p>
                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="block">
                    <span class="label">{{ t('admin.islands.location') }}</span>
                    <select
                      class="select"
                      [value]="editCity()"
                      (change)="onEditCityChange($event)"
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
                      [value]="editName()"
                      (input)="onEditNameChange($event)"
                    />
                  </label>
                </div>

                <div class="flex justify-end">
                  <button
                    type="submit"
                    class="btn btn--primary"
                    [disabled]="saving() || !isIslandChanged()"
                  >
                    {{ saving() ? t('common.loading') : t('admin.islands.save') }}
                  </button>
                </div>
              </form>
            </section>
          }

          <!-- What is on the island: its chest tabs -->
          <section class="card p-4" aria-labelledby="island-tabs-title">
            <header class="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="island-tabs-title" class="section-title">
                  {{ t(canMutateCatalog() ? 'admin.islands.detail.tabsTitle' : 'admin.islands.detail.tabsTitleReadonly') }} ({{ sortedTabs().length }})
                </h2>
                <p class="hint">
                  {{ t(canMutateCatalog() ? 'admin.islands.detail.tabsHint' : 'admin.islands.detail.tabsHintReadonly') }}
                </p>
              </div>
              @if (canMutateCatalog()) {
                <button type="button" class="btn btn--outline btn--sm" (click)="openAddTab()">
                  {{ t('admin.islands.addTab') }}
                </button>
              }
            </header>

            <app-data-table
              [columns]="tabColumns()"
              [rows]="sortedTabs()"
              [trackBy]="trackTabById"
              [emptyLabel]="noTabsLabel"
              emptyIcon="list"
              [hideSearch]="true"
              [hidePageSize]="true"
              [pageSize]="50"
              [syncUrl]="false"
              [ariaLabel]="t('admin.islands.detail.tabsTitleReadonly')"
            >
              @if (canMutateCatalog()) {
                <ng-template dataTableCell="actions" let-row>
                  <div class="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      class="btn btn--outline btn--sm"
                      (click)="openEditTab(row)"
                    >
                      {{ t('common.edit') }}
                    </button>
                    <app-menu
                      [items]="tabMenus()[row.id] ?? noMenuItems"
                      [label]="t('common.actions')"
                      align="end"
                      (itemSelect)="onTabMenu(row, $event)"
                    />
                  </div>
                </ng-template>
              }
            </app-data-table>
          </section>

          <!-- Who manages it -->
          <section class="card p-4" aria-labelledby="island-manage-title">
            <h2 id="island-manage-title" class="section-title">
              {{ t('admin.islands.detail.manage') }}
            </h2>
            <p class="mt-2 text-sm">
              @if (canMutateCatalog()) {
                {{ t('admin.islands.detail.manageOwn') }}
              } @else {
                {{ t('admin.islands.detail.manageSource', { guild: sourceGuildLabel(detail) }) }}
              }
            </p>
          </section>
        </app-page-stack>
      }
    }

    <!-- Add Tab Dialog -->
    @if (addTabOpen()) {
      <app-dialog [title]="t('admin.islands.addTab')" size="sm" (closed)="addTabOpen.set(false)">
        <form id="add-tab-form" class="grid gap-3" (submit)="onAddTabSubmit($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block">
            <span class="label">{{ t('admin.islands.detail.tabName') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="newTabName()"
              (input)="newTabName.set($any($event.target).value)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="addTabOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            form="add-tab-form"
            class="btn btn--primary"
            [disabled]="addingTab()"
          >
            {{ addingTab() ? t('common.loading') : t('admin.islands.addTab') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Edit Tab Dialog -->
    @if (editingTab(); as tab) {
      <app-dialog
        [title]="t('admin.islands.detail.editTab')"
        size="sm"
        (closed)="editingTab.set(null)"
      >
        <form id="edit-tab-form" class="grid gap-3" (submit)="onEditTabSubmit($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block">
            <span class="label">{{ t('admin.islands.detail.tabName') }} <span style="color: var(--color-error)" aria-hidden="true">*</span></span>
            <input
              class="input"
              type="text"
              required
              autofocus
              [value]="editTabName()"
              (input)="editTabName.set($any($event.target).value)"
            />
          </label>
          <label class="block">
            <span class="label">{{ t('admin.islands.detail.sortOrder') }}</span>
            <input
              class="input mono"
              type="number"
              [value]="editTabSortOrder()"
              (input)="editTabSortOrder.set(+$any($event.target).value)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="editingTab.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            form="edit-tab-form"
            class="btn btn--primary"
            [disabled]="savingTab()"
          >
            {{ savingTab() ? t('common.loading') : t('common.save') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Delete Tab Confirmation Dialog -->
    @if (deletingTab(); as tab) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="deletingTab.set(null)">
        <p>{{ t('admin.islands.detail.confirmDeleteTab') }}</p>
        <p class="mt-2 font-semibold" style="color: var(--color-text)">{{ tab.name }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="deletingTab.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="deletingTabLoading()"
            (click)="confirmDeleteTab()"
          >
            {{ deletingTabLoading() ? t('common.loading') : t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Delete Island Confirmation Dialog -->
    @if (deleteIslandOpen(); as open) {
      @if (island(); as detail) {
        <app-dialog [title]="t('common.delete')" size="sm" (closed)="deleteIslandOpen.set(false)">
          <p>{{ t('admin.islands.detail.confirmDelete') }}</p>
          <p class="mt-2 font-semibold" style="color: var(--color-text)">
            {{ cityLabel(detail.city) }} · {{ detail.name }}
          </p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="deleteIslandOpen.set(false)">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              [disabled]="deletingIsland()"
              (click)="confirmDeleteIsland()"
            >
              {{ deletingIsland() ? t('common.loading') : t('common.delete') }}
            </button>
          </div>
        </app-dialog>
      }
    }
  `,
})
export class AdminIslandDetail {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly canMutateCatalog = computed(
    () => this.auth.profile()?.tenant_kind !== 'alliance',
  );

  protected readonly islandCities = ISLAND_CITIES;
  protected readonly noMenuItems = NO_MENU_ITEMS;
  protected readonly noTabsLabel: TranslationKey = 'admin.islands.detail.noTabs';

  protected readonly island = signal<SplitIsland | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);

  protected readonly editName = signal('');
  protected readonly editCity = signal<SplitIslandCity>('lymhurst');

  protected readonly addTabOpen = signal(false);
  protected readonly newTabName = signal('');
  protected readonly addingTab = signal(false);

  protected readonly editingTab = signal<SplitIslandTab | null>(null);
  protected readonly editTabName = signal('');
  protected readonly editTabSortOrder = signal(0);
  protected readonly savingTab = signal(false);

  protected readonly deletingTab = signal<SplitIslandTab | null>(null);
  protected readonly deletingTabLoading = signal(false);

  protected readonly deleteIslandOpen = signal(false);
  protected readonly deletingIsland = signal(false);

  protected readonly reordering = signal(false);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly trackTabById = (tab: SplitIslandTab): number => tab.id;

  protected readonly sortedTabs = computed<readonly SplitIslandTab[]>(() => {
    const current = this.island();
    if (!current) {
      return [];
    }
    return [...current.tabs].sort((a, b) => {
      if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return a.name.localeCompare(b.name);
    });
  });

  protected readonly tabColumns = computed<readonly DataTableColumn<SplitIslandTab>[]>(() => {
    const columns: DataTableColumn<SplitIslandTab>[] = [
      {
        key: 'name',
        label: 'admin.islands.detail.tabName',
        accessor: (tab) => tab.name,
      },
      {
        key: 'sort_order',
        label: 'admin.islands.detail.sortOrder',
        align: 'right',
        accessor: (tab) => tab.sort_order,
      },
    ];
    if (this.canMutateCatalog()) {
      columns.push({ key: 'actions', label: 'common.actions', align: 'right' });
    }
    return columns;
  });

  /** Overflow menu entries per chest tab, keyed by tab id (move, delete). */
  protected readonly tabMenus = computed<Partial<Record<number, readonly MenuItem[]>>>(() => {
    const tabs = this.sortedTabs();
    const busy = this.reordering();
    const menus: Record<number, readonly MenuItem[]> = {};
    tabs.forEach((tab, index) => {
      menus[tab.id] = [
        {
          id: 'up',
          label: this.t('admin.islands.detail.moveUp'),
          disabled: busy || index === 0,
        },
        {
          id: 'down',
          label: this.t('admin.islands.detail.moveDown'),
          disabled: busy || index === tabs.length - 1,
        },
        {
          id: 'delete',
          label: this.t('common.delete'),
          danger: true,
          separatorBefore: true,
          disabled: tabs.length <= 1,
        },
      ];
    });
    return menus;
  });

  protected readonly headerMenu = computed<readonly EntityMenuItem[]>(() =>
    this.canMutateCatalog() ? [{ id: 'delete', label: this.t('common.delete'), danger: true }] : [],
  );

  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => {
    const current = this.island();
    if (!current) {
      return [];
    }
    const items: SummaryItem[] = [
      { label: this.t('admin.islands.location'), value: this.cityLabel(current.city) },
      { label: this.t('admin.islands.tabs'), value: current.tabs.length },
    ];
    if (!this.canMutateCatalog()) {
      items.push({ label: this.t('admin.islands.sourceGuild'), value: this.sourceGuildLabel(current) });
    }
    return items;
  });

  protected readonly isIslandChanged = computed(() => {
    const current = this.island();
    if (!current) {
      return false;
    }
    return (
      this.editName().trim() !== current.name ||
      this.editCity() !== current.city
    );
  });

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('islandId'));
      if (!Number.isFinite(id) || id <= 0) {
        this.loadFailed.set(true);
        this.island.set(null);
        this.loading.set(false);
        return;
      }
      void this.load(id);
    });
  }

  protected reload(): void {
    const id = Number(this.route.snapshot.paramMap.get('islandId'));
    if (Number.isFinite(id) && id > 0) {
      void this.load(id);
    }
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected sourceGuildLabel(island: SplitIsland): string {
    const name = island.source_guild_name?.trim();
    if (name) {
      return name;
    }
    const tenantId = island.source_guild_tenant_id?.trim();
    if (tenantId) {
      return tenantId;
    }
    return this.t('admin.islands.unknownGuild');
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'delete' && this.canMutateCatalog()) {
      this.deleteIslandOpen.set(true);
    }
  }

  protected onEditCityChange(event: Event): void {
    this.editCity.set((event.target as HTMLSelectElement).value as SplitIslandCity);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
  }

  protected async onSaveIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    if (!current) {
      return;
    }
    const name = this.editName().trim();
    const city = this.editCity();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.saving.set(true);
    try {
      const payload: UpdateIslandRequest = { name, city };
      const updated = await firstValueFrom(
        this.api.patch<SplitIsland>(`api/splits/islands/${current.id}`, payload),
      );
      this.island.set(updated);
      this.editName.set(updated.name);
      this.editCity.set(updated.city);
      this.toasts.success(this.t('admin.islands.updated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected openAddTab(): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.newTabName.set('');
    this.addTabOpen.set(true);
  }

  protected async onAddTabSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    if (!current) {
      return;
    }
    const name = this.newTabName().trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.addingTab.set(true);
    try {
      const payload: CreateIslandTabRequest = { name };
      const updated = await firstValueFrom(
        this.api.post<SplitIsland>(`api/splits/islands/${current.id}/tabs`, payload),
      );
      this.island.set(updated);
      this.addTabOpen.set(false);
      this.newTabName.set('');
      this.toasts.success(this.t('admin.islands.tabAdded'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.addingTab.set(false);
    }
  }

  protected openEditTab(tab: SplitIslandTab): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.editingTab.set(tab);
    this.editTabName.set(tab.name);
    this.editTabSortOrder.set(tab.sort_order);
  }

  protected async onEditTabSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    const tab = this.editingTab();
    if (!current || !tab) {
      return;
    }
    const name = this.editTabName().trim();
    const sort_order = this.editTabSortOrder();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.savingTab.set(true);
    try {
      const payload: UpdateIslandTabRequest = { name, sort_order };
      const updated = await firstValueFrom(
        this.api.patch<SplitIsland>(`api/splits/islands/${current.id}/tabs/${tab.id}`, payload),
      );
      this.island.set(updated);
      this.editingTab.set(null);
      this.toasts.success(this.t('admin.islands.detail.tabUpdated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingTab.set(false);
    }
  }

  protected onTabMenu(tab: SplitIslandTab, id: string): void {
    if (id === 'up' || id === 'down') {
      const index = this.sortedTabs().findIndex((item) => item.id === tab.id);
      if (index >= 0) {
        void this.moveTab(index, id === 'up' ? -1 : 1);
      }
    } else if (id === 'delete') {
      this.askDeleteTab(tab);
    }
  }

  protected askDeleteTab(tab: SplitIslandTab): void {
    if (!this.canMutateCatalog()) {
      return;
    }
    this.deletingTab.set(tab);
  }

  protected async confirmDeleteTab(): Promise<void> {
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    const tab = this.deletingTab();
    if (!current || !tab) {
      return;
    }

    this.deletingTabLoading.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<SplitIsland>(`api/splits/islands/${current.id}/tabs/${tab.id}`),
      );
      if (updated) {
        this.island.set(updated);
      } else {
        await this.load(current.id);
      }
      this.deletingTab.set(null);
      this.toasts.success(this.t('admin.islands.detail.tabDeleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.deletingTabLoading.set(false);
    }
  }

  protected async moveTab(index: number, direction: -1 | 1): Promise<void> {
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    if (!current) {
      return;
    }
    const tabs = [...this.sortedTabs()];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= tabs.length) {
      return;
    }

    const tabA = tabs[index];
    const tabB = tabs[targetIndex];
    if (!tabA || !tabB) {
      return;
    }

    this.reordering.set(true);
    try {
      // Update swapped tabs sort orders
      await Promise.all([
        firstValueFrom(
          this.api.patch<SplitIsland>(`api/splits/islands/${current.id}/tabs/${tabA.id}`, {
            sort_order: targetIndex,
          }),
        ),
        firstValueFrom(
          this.api.patch<SplitIsland>(`api/splits/islands/${current.id}/tabs/${tabB.id}`, {
            sort_order: index,
          }),
        ),
      ]);

      await this.load(current.id);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.reordering.set(false);
    }
  }

  protected async confirmDeleteIsland(): Promise<void> {
    if (!this.canMutateCatalog()) {
      return;
    }
    const current = this.island();
    if (!current) {
      return;
    }

    this.deletingIsland.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/splits/islands/${current.id}`));
      this.deleteIslandOpen.set(false);
      this.toasts.success(this.t('admin.islands.deleted'));
      await this.router.navigate(['/admin/islands']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.deletingIsland.set(false);
    }
  }

  private async load(islandId: number): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      const found = islands.find((item) => item.id === islandId) ?? null;
      if (!found) {
        this.loadFailed.set(true);
        this.island.set(null);
      } else {
        this.island.set(found);
        this.editName.set(found.name);
        this.editCity.set(found.city);
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.island.set(null);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
