import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { validateBuildName } from '../../shared/validation/build-validation';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildItemSlot,
  BuildRole,
  BuildSlot,
  OpenAlbionItem,
  UpdateBuildRequest,
} from '../../core/models/api.models';
import { searchAlbionEquipmentCatalog } from '../../shared/data/albion-equipment-catalog';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Sorted slot order used for rendering the equipment grid consistently
 * across the detail page and the create form on the parent comps page.
 */
const SLOT_ORDER: BuildSlot[] = [
  'weapon',
  'off_hand',
  'head',
  'armor',
  'shoes',
  'cape',
  'bag',
  'potion',
  'food',
  'mount',
];

const SLOT_LABELS: Record<BuildSlot, string> = {
  weapon: 'Weapon',
  off_hand: 'Off-hand',
  head: 'Head',
  armor: 'Armor',
  shoes: 'Shoes',
  cape: 'Cape',
  bag: 'Bag',
  potion: 'Potion',
  food: 'Food',
  mount: 'Mount',
};

const ROLE_LABELS: Record<BuildRole, string> = {
  healer: 'Healer',
  support: 'Support',
  dps: 'DPS',
  tank: 'Tank',
  battle_mount: 'Battle Mount',
  brawler: 'Brawler',
};

const ITEM_TIERS = [
  'T4',
  'T4.1',
  'T4.2',
  'T4.3',
  'T5',
  'T5.1',
  'T6',
  'T6.1',
  'T7',
  'T7.1',
  'T8',
  'T8.1',
  'T8.2',
  'T8.3',
];

/**
 * Build detail page.
 *
 * Renders each equipment slot as a row; officers can search OpenAlbion items
 * inline and upsert/remove slots without leaving the page. Also exposes the
 * build metadata editor (name, role, category, description).
 *
 * @example
 * ```ts
 * routes.push({ path: 'comps/builds/:buildId', loadComponent: () => import('./comp-build-detail').then(m => m.CompBuildDetailPage) });
 * ```
 */
@Component({
  selector: 'app-comp-build-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PageHeader,
    PageStack,
    EmptyState,
    ErrorState,
    Loading,
    EquipmentGrid,
    Dialog,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (build(); as current) {
      <app-page-header
        [title]="current.name"
        [subtitle]="
          roleLabel(current.role) + ' · ' + (current.category_name || t('comps.noCategory'))
        "
      >
        <div class="flex flex-wrap gap-2">
          <a class="btn btn--ghost" routerLink="/comps">← {{ t('comps.title') }}</a>
          @if (canManage() && mode() === 'view') {
            <button
              type="button"
              class="btn btn--outline"
              (click)="enterEdit()"
              [disabled]="saving()"
            >
              {{ t('common.edit') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              (click)="askDeleteBuild()"
              [disabled]="saving()"
            >
              {{ t('common.delete') }}
            </button>
          }
        </div>
      </app-page-header>

      <app-page-stack>
        @if (mode() === 'edit' && canManage()) {
          <form class="card grid gap-4 p-5" (submit)="saveEdit($event)">
            <div class="grid gap-4 md:grid-cols-2">
              <label>
                <span class="label">{{ t('common.name') }}</span>
                <input
                  class="input"
                  type="text"
                  [value]="editName()"
                  (input)="onEditNameChange($event)"
                />
              </label>
              <label>
                <span class="label">{{ t('common.category') }}</span>
                <select
                  class="select"
                  [value]="editCategoryId()"
                  (change)="onEditCategoryChange($event)"
                >
                  <option value="">{{ t('comps.noCategory') }}</option>
                  @for (category of buildCategories(); track category.id) {
                    <option [value]="category.id">{{ category.name }}</option>
                  }
                </select>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.role') }}</span>
              <select class="select" [value]="editRole()" (change)="onEditRoleChange($event)">
                <option value="">{{ t('common.role') }}</option>
                @for (role of roles; track role) {
                  <option [value]="role">{{ roleLabel(role) }}</option>
                }
              </select>
            </label>
            <label>
              <span class="label">{{ t('common.description') }}</span>
              <textarea
                class="textarea"
                rows="3"
                [value]="editDescription()"
                (input)="onEditDescriptionChange($event)"
              ></textarea>
            </label>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="cancelEdit()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }

        <section class="card grid gap-4 p-5" [attr.aria-label]="t('comps.equipment')">
          <header class="flex items-center justify-between gap-3">
            <h2 class="text-lg font-semibold" style="color: var(--color-text)">
              {{ t('comps.equipment') }} ({{ itemsBySlot().length }}/{{ SLOT_ORDER.length }})
            </h2>
            <span class="chip">{{ current.item_count }} {{ t('comps.items') }}</span>
          </header>

          <app-equipment-grid
            [items]="itemsBySlot()"
            [canManage]="canManage() && mode() === 'edit'"
            [editingSlot]="editingSlot()"
            [draftTier]="draftTier()"
            [draftSearch]="draftSearch()"
            [draftItemId]="draftItemId()"
            [searchResults]="searchResults()"
            [searchLoading]="searchLoading()"
            [tiers]="ITEM_TIERS"
            (slotToggle)="onSlotToggle($event)"
            (tierChange)="onDraftTierChangeValue($event)"
            (searchChange)="onDraftSearchChangeValue($event)"
            (itemSelect)="onDraftItemChangeValue($event)"
            (saveSlot)="saveSlot($event)"
            (cancelEdit)="cancelSlotEdit()"
            (removeItem)="askRemoveItem($event)"
          />
        </section>
      </app-page-stack>

      @if (pendingDelete(); as pending) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeDelete()">
          <p>{{ pending.kind === 'slot' ? t('comps.deleteItem') : t('comps.delete.confirm') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
            {{ pending.kind === 'slot' ? slotLabel(pending.slot) : current.name }}
          </p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeDelete()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              [disabled]="saving()"
              (click)="confirmPendingDelete()"
            >
              {{ t('common.delete') }}
            </button>
          </div>
        </app-dialog>
      }
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load(buildId)"
      />
    } @else if (!loading()) {
      <app-empty-state [message]="t('comps.buildNotFound')" icon="package" />
    }
  `,
})
export class CompBuildDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly SLOT_ORDER = SLOT_ORDER;
  protected readonly ITEM_TIERS = ITEM_TIERS;
  protected readonly roles: BuildRole[] = [
    'healer',
    'support',
    'dps',
    'tank',
    'battle_mount',
    'brawler',
  ];

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly build = signal<BuildDetail | null>(null);
  protected readonly buildCategories = signal<BuildCategoryView[]>([]);

  protected readonly mode = signal<'view' | 'edit'>('view');
  protected readonly pendingDelete = signal<
    { kind: 'build' } | { kind: 'slot'; slot: BuildSlot } | null
  >(null);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  protected readonly editRole = signal('');

  protected readonly editingSlot = signal<BuildSlot | null>(null);
  protected readonly draftTier = signal('T8');
  protected readonly draftSearch = signal('');
  protected readonly draftItemId = signal('');
  protected readonly draftItemName = signal('');
  protected readonly draftItemType = signal('');
  protected readonly draftItemIcon = signal<string | null>(null);
  protected readonly searchResults = signal<OpenAlbionItem[]>([]);
  protected readonly searchLoading = signal(false);

  protected readonly t = (key: TranslationKey) => this.translate.t(key);

  protected readonly canManage = computed(() => this.auth.hasPermission('comps.builds.manage'));
  protected readonly itemsBySlot = computed<BuildItemSlot[]>(() => {
    const build = this.build();
    return build ? [...build.items].sort(sortBySlotOrder) : [];
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly buildId = Number(this.route.snapshot.paramMap.get('buildId'));

  constructor() {
    void this.load(this.buildId);
  }

  protected roleLabel(role: BuildRole): string {
    return ROLE_LABELS[role] ?? role;
  }

  protected slotLabel(slot: BuildSlot): string {
    return SLOT_LABELS[slot] ?? slot;
  }

  /**
   * Toggle the equipment popover for a slot.
   *
   * Selecting the active slot again closes the popover; otherwise we
   * pre-fill the draft from the existing persisted item so officers can
   * tweak tier without re-searching from scratch.
   */
  protected onSlotToggle(slot: BuildSlot): void {
    if (this.editingSlot() === slot) {
      this.cancelSlotEdit();
      return;
    }
    this.startSlotEdit(slot);
  }

  protected itemForSlot(slot: BuildSlot): BuildItemSlot | null {
    return this.itemsBySlot().find((item) => item.slot === slot) ?? null;
  }

  protected enterEdit(): void {
    const current = this.build();
    if (!current) {
      return;
    }
    this.editName.set(current.name);
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editRole.set(current.role);
    this.editDescription.set(current.description ?? '');
    this.mode.set('edit');
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.cancelSlotEdit();
    void this.load(this.buildId);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
  }

  protected onEditDescriptionChange(event: Event): void {
    this.editDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onEditCategoryChange(event: Event): void {
    this.editCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditRoleChange(event: Event): void {
    this.editRole.set((event.target as HTMLSelectElement).value);
  }

  protected startSlotEdit(slot: BuildSlot): void {
    const current = this.itemForSlot(slot);
    this.editingSlot.set(slot);
    this.draftTier.set(current?.openalbion_item_tier ?? 'T8');
    this.draftSearch.set(current?.openalbion_item_name ?? '');
    this.draftItemId.set(current ? String(current.openalbion_item_id) : '');
    this.draftItemName.set(current?.openalbion_item_name ?? '');
    this.draftItemType.set(current?.openalbion_item_type ?? '');
    this.draftItemIcon.set(current?.openalbion_item_icon ?? null);
    this.searchResults.set([]);
    if (current) {
      void this.runItemSearch();
    }
  }

  protected cancelSlotEdit(): void {
    this.editingSlot.set(null);
    this.draftSearch.set('');
    this.draftItemId.set('');
    this.searchResults.set([]);
  }

  protected onDraftTierChangeValue(tier: string): void {
    this.draftTier.set(tier);
    void this.runItemSearch();
  }

  protected onDraftSearchChangeValue(query: string): void {
    this.draftSearch.set(query);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      void this.runItemSearch();
    }, 250);
  }

  protected onDraftItemChangeValue(itemId: string): void {
    this.draftItemId.set(itemId);
    const item = this.searchResults().find((result) => String(result.id) === itemId);
    if (item) {
      this.draftItemName.set(item.name);
      this.draftItemType.set(item.type);
      this.draftItemIcon.set(item.icon ?? null);
    }
  }

  protected async saveSlot(slot: BuildSlot): Promise<void> {
    const build = this.build();
    if (!build || !this.draftItemId()) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<BuildDetail>(`api/comps/builds/${build.id}/items/${slot}`, {
          openalbion_item_type: this.draftItemType(),
          openalbion_item_id: Number(this.draftItemId()),
          openalbion_item_name: this.draftItemName(),
          openalbion_item_icon: this.draftItemIcon(),
          openalbion_item_tier: this.draftTier(),
        }),
      );
      this.build.set(updated);
      this.cancelSlotEdit();
      this.toasts.success('Item saved');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askRemoveItem(slot: BuildSlot): void {
    this.pendingDelete.set({ kind: 'slot', slot });
  }

  protected async removeItem(slot: BuildSlot): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<BuildDetail>(`api/comps/builds/${build.id}/items/${slot}`),
      );
      this.build.set(updated ?? null);
      this.pendingDelete.set(null);
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    const build = this.build();
    if (!build) {
      return;
    }
    // The name is validated even when unchanged: the previous version only
    // applied it `if (editName())`, so clearing the field was silently ignored
    // rather than rejected, and the user was told the save succeeded.
    const nameError = validateBuildName(this.editName(), {
      existingNames: [],
      currentName: build.name,
    });
    if (nameError) {
      this.toasts.error(nameError.message);
      return;
    }

    const request: UpdateBuildRequest = {};
    const name = this.editName().trim();
    if (name !== build.name) request.name = name;
    // Compared against the current value rather than tested for truthiness, so
    // an emptied description actually clears instead of being ignored.
    if (this.editDescription() !== (build.description ?? '')) {
      request.description = this.editDescription();
    }
    const categoryId = this.editCategoryId() ? Number(this.editCategoryId()) : undefined;
    if (categoryId && categoryId !== build.category_id) request.category_id = categoryId;
    if (this.editRole() && this.editRole() !== build.role)
      request.role = this.editRole() as BuildRole;

    if (Object.keys(request).length === 0) {
      this.mode.set('view');
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<BuildDetail>(`api/comps/builds/${build.id}`, request));
      this.mode.set('view');
      this.cancelSlotEdit();
      await this.load(this.buildId);
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askDeleteBuild(): void {
    this.pendingDelete.set({ kind: 'build' });
  }

  protected closeDelete(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmPendingDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) {
      return;
    }
    if (pending.kind === 'slot') {
      await this.removeItem(pending.slot);
      return;
    }
    await this.deleteBuild();
  }

  protected async deleteBuild(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/builds/${build.id}`));
      this.pendingDelete.set(null);
      this.toasts.success(this.t('common.delete'));
      await this.router.navigate(['/comps']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private runItemSearch(): void {
    const slot = this.editingSlot();
    if (!slot) {
      this.searchResults.set([]);
      return;
    }

    this.searchLoading.set(true);
    this.searchResults.set(
      searchAlbionEquipmentCatalog(this.draftSearch(), slot, this.draftTier()),
    );
    this.searchLoading.set(false);
  }

  protected async load(buildId: number): Promise<void> {
    if (!Number.isFinite(buildId) || buildId <= 0) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [build, categories] = await Promise.all([
        firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`)),
        firstValueFrom(this.api.get<BuildCategoryView[]>('api/comps/build-categories')).catch(
          () => [],
        ),
      ]);
      this.build.set(build);
      this.buildCategories.set(categories);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}

/** Compares two build items by their canonical slot order for stable rendering. */
function sortBySlotOrder(left: BuildItemSlot, right: BuildItemSlot): number {
  const leftIndex = SLOT_ORDER.indexOf(left.slot);
  const rightIndex = SLOT_ORDER.indexOf(right.slot);
  return leftIndex - rightIndex;
}
