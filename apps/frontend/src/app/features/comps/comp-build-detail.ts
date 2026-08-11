import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildItemSlot,
  BuildRole,
  BuildSlot,
  OpenAlbionItem,
  PaginatedData,
  UpdateBuildRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

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

const ITEM_TIERS = ['T4', 'T4.1', 'T4.2', 'T4.3', 'T5', 'T5.1', 'T6', 'T6.1', 'T7', 'T7.1', 'T8', 'T8.1', 'T8.2', 'T8.3'];

/** Maps an equipment slot to the OpenAlbion item `type` used for search filtering. */
const SLOT_TO_OPENALBION_TYPE: Partial<Record<BuildSlot, string>> = {
  weapon: 'weapon',
  off_hand: 'offhand',
  head: 'head',
  armor: 'armor',
  shoes: 'shoes',
  cape: 'cape',
  bag: 'bag',
  potion: 'consumable',
  food: 'food',
  mount: 'mount',
};

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
  imports: [RouterLink, PageHeader, EmptyState, Loading],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (build(); as current) {
      <app-page-header [title]="current.name" [subtitle]="roleLabel(current.role) + ' · ' + (current.category_name || 'No category')">
        <div class="flex flex-wrap gap-2">
          <a class="btn btn--ghost" routerLink="/comps">← {{ t('comps.title') }}</a>
          @if (canManage()) {
            <button type="button" class="btn btn--outline" (click)="toggleEdit()" [disabled]="saving()">
              {{ editing() ? t('common.close') : t('common.edit') }}
            </button>
            <button type="button" class="btn btn--danger" (click)="deleteBuild()" [disabled]="saving()">
              {{ t('common.delete') }}
            </button>
          }
        </div>
      </app-page-header>

      @if (editing() && canManage()) {
        <form class="card mb-6 grid gap-4 p-5" (submit)="saveEdit($event)">
          <div class="grid gap-4 md:grid-cols-2">
            <label>
              <span class="label">{{ t('common.name') }}</span>
              <input class="input" type="text" [value]="editName()" (input)="onEditNameChange($event)" />
            </label>
            <label>
              <span class="label">Category</span>
              <select class="select" [value]="editCategoryId()" (change)="onEditCategoryChange($event)">
                <option value="">No category</option>
                @for (category of buildCategories(); track category.id) {
                  <option [value]="category.id">{{ category.name }}</option>
                }
              </select>
            </label>
          </div>
          <label>
            <span class="label">Role</span>
            <select class="select" [value]="editRole()" (change)="onEditRoleChange($event)">
              <option value="">Select role</option>
              @for (role of roles; track role) {
                <option [value]="role">{{ roleLabel(role) }}</option>
              }
            </select>
          </label>
          <label>
            <span class="label">{{ t('common.description') }}</span>
            <textarea class="textarea" rows="3" [value]="editDescription()" (input)="onEditDescriptionChange($event)"></textarea>
          </label>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn--ghost" (click)="toggleEdit()">{{ t('common.cancel') }}</button>
            <button type="submit" class="btn btn--primary" [disabled]="saving()">{{ t('common.save') }}</button>
          </div>
        </form>
      }

      <section class="card grid gap-3 p-5" aria-label="Equipment slots">
        <header class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-semibold" style="color: var(--color-text)">
            Equipment ({{ itemsBySlot().length }}/{{ SLOT_ORDER.length }})
          </h2>
          <span class="chip">{{ current.item_count }} item(s)</span>
        </header>

        @for (slot of SLOT_ORDER; track slot) {
          @let entry = itemForSlot(slot);
          <div
            class="grid gap-3 rounded-lg p-3 sm:grid-cols-[10rem_3rem_1fr_1fr_auto]"
            style="background-color: var(--color-surface-1)"
          >
            <span class="font-medium self-center" style="color: var(--color-text)">{{ slotLabel(slot) }}</span>
            @if (entry) {
              @if (entry.openalbion_item_icon) {
                <img
                  [src]="entry.openalbion_item_icon"
                  [alt]="entry.openalbion_item_name"
                  class="self-center"
                  style="width: 2.5rem; height: 2.5rem; object-fit: contain"
                />
              } @else {
                <span class="self-center text-2xl">—</span>
              }
              <div class="self-center">
                <p class="font-medium" style="color: var(--color-text)">{{ entry.openalbion_item_name }}</p>
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  #{{ entry.openalbion_item_id }} · {{ entry.openalbion_item_type }}
                </p>
              </div>
              <span class="self-center chip">{{ entry.openalbion_item_tier || '—' }}</span>
              @if (canManage()) {
                <div class="flex items-center gap-2">
                  <button type="button" class="btn btn--outline btn--sm" (click)="startSlotEdit(slot, entry!)">
                    {{ t('common.edit') }}
                  </button>
                  <button type="button" class="btn btn--danger btn--sm" (click)="removeItem(slot)" [disabled]="saving()">
                    {{ t('common.delete') }}
                  </button>
                </div>
              }
            } @else {
              <span class="self-center text-2xl">+</span>
              <span class="self-center text-sm" style="color: var(--color-text-secondary)">Empty slot</span>
              <span></span>
              @if (canManage()) {
                <button type="button" class="btn btn--tonal btn--sm self-center" (click)="startSlotEdit(slot, null)">
                  {{ t('common.add') }}
                </button>
              }
            }

            @if (editingSlot() === slot && canManage()) {
              <div class="grid gap-2 sm:col-span-5 sm:grid-cols-[8rem_1fr_1fr_auto]">
                <select class="select" [value]="draftTier()" (change)="onDraftTierChange($event)">
                  @for (tier of ITEM_TIERS; track tier) {
                    <option [value]="tier">{{ tier }}</option>
                  }
                </select>
                <input
                  class="input"
                  type="search"
                  placeholder="Search item"
                  [value]="draftSearch()"
                  (input)="onDraftSearchChange($event)"
                />
                <select class="select" [value]="draftItemId()" (change)="onDraftItemChange($event)">
                  <option value="">{{ searchLoading() ? t('common.loading') : 'Select item' }}</option>
                  @for (item of searchResults(); track item.id) {
                    <option [value]="item.id">{{ item.name }} · {{ item.tier }}</option>
                  }
                </select>
                <div class="flex gap-2">
                  <button type="button" class="btn btn--primary btn--sm" (click)="saveSlot(slot)" [disabled]="saving()">
                    {{ t('common.save') }}
                  </button>
                  <button type="button" class="btn btn--ghost btn--sm" (click)="cancelSlotEdit()">
                    {{ t('common.cancel') }}
                  </button>
                </div>
              </div>
            }
          </div>
        }
      </section>
    } @else if (!loading()) {
      <app-empty-state message="Build not found" icon="package" />
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
  protected readonly roles: BuildRole[] = ['healer', 'support', 'dps', 'tank', 'battle_mount', 'brawler'];

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly build = signal<BuildDetail | null>(null);
  protected readonly buildCategories = signal<BuildCategoryView[]>([]);

  protected readonly editing = signal(false);
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

  constructor() {
    const buildId = Number(this.route.snapshot.paramMap.get('buildId'));
    void this.load(buildId);
  }

  protected roleLabel(role: BuildRole): string {
    return ROLE_LABELS[role] ?? role;
  }

  protected slotLabel(slot: BuildSlot): string {
    return SLOT_LABELS[slot] ?? slot;
  }

  protected itemForSlot(slot: BuildSlot): BuildItemSlot | null {
    return this.itemsBySlot().find((item) => item.slot === slot) ?? null;
  }

  protected toggleEdit(): void {
    if (!this.editing() && this.build()) {
      const current = this.build()!;
      this.editName.set(current.name);
      this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
      this.editRole.set(current.role);
      this.editDescription.set('');
    }
    this.editing.update((value) => !value);
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

  protected startSlotEdit(slot: BuildSlot, current: BuildItemSlot | null): void {
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

  protected onDraftTierChange(event: Event): void {
    this.draftTier.set((event.target as HTMLSelectElement).value);
    void this.runItemSearch();
  }

  protected onDraftSearchChange(event: Event): void {
    this.draftSearch.set((event.target as HTMLInputElement).value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      void this.runItemSearch();
    }, 250);
  }

  protected onDraftItemChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.draftItemId.set(value);
    const item = this.searchResults().find((result) => String(result.id) === value);
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

  protected async removeItem(slot: BuildSlot): Promise<void> {
    const build = this.build();
    if (!build || !confirm(`Remove ${slotLabel(slot)} from this build?`)) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<BuildDetail>(`api/comps/builds/${build.id}/items/${slot}`),
      );
      this.build.set(updated ?? null);
      this.toasts.success('Item removed');
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
    const request: UpdateBuildRequest = {};
    if (this.editName() && this.editName() !== build.name) request.name = this.editName();
    if (this.editDescription()) request.description = this.editDescription();
    const categoryId = this.editCategoryId() ? Number(this.editCategoryId()) : undefined;
    if (categoryId && categoryId !== build.category_id) request.category_id = categoryId;
    if (this.editRole() && this.editRole() !== build.role) request.role = this.editRole() as BuildRole;

    this.saving.set(true);
    try {
      const updated = await firstValueFrom(this.api.patch<BuildDetail>(`api/comps/builds/${build.id}`, request));
      this.build.set(updated);
      this.editing.set(false);
      this.toasts.success('Build updated');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteBuild(): Promise<void> {
    const build = this.build();
    if (!build || !confirm(`Delete build "${build.name}"? This cannot be undone.`)) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/builds/${build.id}`));
      this.toasts.success('Build deleted');
      await this.router.navigate(['/comps']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async runItemSearch(): Promise<void> {
    const slot = this.editingSlot();
    if (!slot) {
      return;
    }
    const query = this.draftSearch().trim();
    if (query.length < 2) {
      this.searchResults.set([]);
      return;
    }
    this.searchLoading.set(true);
    try {
      const tier = Number(this.draftTier().replace('T', ''));
      const response = await firstValueFrom(
        this.api.get<PaginatedData<OpenAlbionItem>>('api/openalbion/items', {
          q: query,
          type: SLOT_TO_OPENALBION_TYPE[slot] ?? '',
          tier,
          page: 1,
          limit: 25,
        }),
      );
      this.searchResults.set(response.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchLoading.set(false);
    }
  }

  private async load(buildId: number): Promise<void> {
    if (!Number.isFinite(buildId) || buildId <= 0) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    try {
      const [build, categories] = await Promise.all([
        firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`)),
        firstValueFrom(this.api.get<BuildCategoryView[]>('api/comps/build-categories')).catch(() => []),
      ]);
      this.build.set(build);
      this.buildCategories.set(categories);
    } catch (error) {
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

function slotLabel(slot: BuildSlot): string {
  return SLOT_LABELS[slot] ?? slot;
}
