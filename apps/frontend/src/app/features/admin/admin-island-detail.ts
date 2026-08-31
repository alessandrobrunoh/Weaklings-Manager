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
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
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
 * Dedicated island detail and edit page (`/admin/islands/:islandId`).
 *
 * Allows admins to rename an island, move it to another city, and manage
 * (add, rename, reorder, delete) its loot chest tabs.
 */
@Component({
  selector: 'app-admin-island-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, ErrorState, Loading, PageHeader, PageStack, RouterLink],
  template: `
    <a routerLink="/admin/islands" class="btn btn--ghost mb-4 inline-flex">
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
        <app-page-header
          [title]="detail.name"
          [subtitle]="cityLabel(detail.city) + ' · ' + detail.tabs.length + ' ' + t('admin.islands.tabs').toLowerCase()"
        >
          <button type="button" class="btn btn--danger" (click)="deleteIslandOpen.set(true)">
            {{ t('common.delete') }}
          </button>
        </app-page-header>

        <app-page-stack>
          <!-- Edit Island Details Card -->
          <section class="card p-5">
            <header class="mb-4">
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('admin.islands.detail.overview') }}
              </h2>
            </header>

            <form class="grid gap-4" (submit)="onSaveIsland($event)">
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="block">
                  <span class="label font-medium">{{ t('admin.islands.location') }}</span>
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
                  <span class="label font-medium">{{ t('admin.islands.island') }}</span>
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

          <!-- Manage Chest Tabs Section -->
          <section class="card p-5">
            <header class="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold" style="color: var(--color-text)">
                  {{ t('admin.islands.detail.tabsTitle') }} ({{ sortedTabs().length }})
                </h2>
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  {{ t('admin.islands.detail.tabsHint') }}
                </p>
              </div>
              <button type="button" class="btn btn--primary btn--sm" (click)="openAddTab()">
                + {{ t('admin.islands.addTab') }}
              </button>
            </header>

            @if (sortedTabs().length === 0) {
              <p class="py-6 text-center text-xs" style="color: var(--color-text-secondary)">
                {{ t('admin.islands.detail.noTabs') }}
              </p>
            } @else {
              <div class="flex flex-col gap-2.5">
                @for (tab of sortedTabs(); track tab.id; let idx = $index; let isFirst = $first; let isLast = $last) {
                  <article
                    class="surface flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5"
                    style="border-color: var(--color-border)"
                  >
                    <div class="flex items-center gap-3">
                      <span class="chip mono text-xs font-bold">#{{ idx + 1 }}</span>
                      <div>
                        <h3 class="font-semibold" style="color: var(--color-text)">
                          {{ tab.name }}
                        </h3>
                        <p class="text-xs" style="color: var(--color-text-secondary)">
                          {{ t('admin.islands.detail.sortOrder') }}: {{ tab.sort_order }}
                        </p>
                      </div>
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        [disabled]="isFirst || reordering()"
                        (click)="moveTab(idx, -1)"
                        [title]="t('admin.islands.detail.moveUp')"
                        [attr.aria-label]="t('admin.islands.detail.moveUp')"
                      >
                        ↑ {{ t('admin.islands.detail.moveUp') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        [disabled]="isLast || reordering()"
                        (click)="moveTab(idx, 1)"
                        [title]="t('admin.islands.detail.moveDown')"
                        [attr.aria-label]="t('admin.islands.detail.moveDown')"
                      >
                        ↓ {{ t('admin.islands.detail.moveDown') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--outline btn--sm"
                        (click)="openEditTab(tab)"
                      >
                        {{ t('common.edit') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--danger btn--sm"
                        [disabled]="detail.tabs.length <= 1"
                        (click)="askDeleteTab(tab)"
                      >
                        {{ t('common.delete') }}
                      </button>
                    </div>
                  </article>
                }
              </div>
            }
          </section>
        </app-page-stack>
      }
    }

    <!-- Add Tab Dialog -->
    @if (addTabOpen()) {
      <app-dialog [title]="t('admin.islands.addTab')" size="sm" (closed)="addTabOpen.set(false)">
        <form id="add-tab-form" class="grid gap-3" (submit)="onAddTabSubmit($event)">
          <label class="block">
            <span class="label">{{ t('admin.islands.detail.tabName') }}</span>
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
          <label class="block">
            <span class="label">{{ t('admin.islands.detail.tabName') }}</span>
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly islandCities = ISLAND_CITIES;

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

  protected onEditCityChange(event: Event): void {
    this.editCity.set((event.target as HTMLSelectElement).value as SplitIslandCity);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
  }

  protected async onSaveIsland(event: SubmitEvent): Promise<void> {
    event.preventDefault();
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
    this.newTabName.set('');
    this.addTabOpen.set(true);
  }

  protected async onAddTabSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
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
    this.editingTab.set(tab);
    this.editTabName.set(tab.name);
    this.editTabSortOrder.set(tab.sort_order);
  }

  protected async onEditTabSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
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

  protected askDeleteTab(tab: SplitIslandTab): void {
    this.deletingTab.set(tab);
  }

  protected async confirmDeleteTab(): Promise<void> {
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
