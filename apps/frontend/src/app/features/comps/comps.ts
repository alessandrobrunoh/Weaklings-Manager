import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildItemSlot,
  BuildRole,
  BuildSlot,
  BuildSummary,
  CompCategoryView,
  CompDetail,
  CompPerformanceView,
  CompSummary,
  CreateBuildCategoryRequest,
  CreateBuildRequest,
  CreateCompCategoryRequest,
  CreateCompRequest,
  OpenAlbionItem,
  UpdateBuildCategoryRequest,
  UpdateBuildRequest,
  UpdateCompCategoryRequest,
  UpdateCompRequest,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

type CategoryKind = 'build' | 'comp';
type ManagedCategory = BuildCategoryView | CompCategoryView;

/**
 * Compositions and builds workspace.
 *
 * Keeps the two strongly-related authoring flows in a single page because comps
 * depend on existing builds and guild officers need to iterate between them
 * quickly while preparing an event roster.
 */
@Component({
  selector: 'app-comps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading],
  template: `
    <app-page-header [title]="t('comps.title')" [subtitle]="t('comps.subtitle')">
      <div class="flex flex-wrap gap-2">
        @if (canManageAnyCategory()) {
          <button type="button" class="btn btn--outline" (click)="toggleCategoryManager()">
            {{ showCategoryManager() ? t('common.close') : t('comps.categories') }}
          </button>
        }
        @if (canCreateCurrent()) {
          <button type="button" class="btn btn--primary" (click)="toggleCreateForm()">
            {{ showCreateForm() ? t('common.close') : createButtonLabel() }}
          </button>
        }
      </div>
    </app-page-header>

    @if (showCategoryManager()) {
      <section class="card mb-6 grid gap-5 p-5" aria-label="Manage composition categories">
        <header>
          <h2 class="text-lg font-semibold" style="color: var(--color-text)">
            {{ t('comps.categories') }}
          </h2>
          <p class="text-sm" style="color: var(--color-text-secondary)">
            Create, rename, or delete build and composition categories.
          </p>
        </header>

        <div
          class="inline-flex w-fit gap-1 rounded-full p-1"
          style="background: var(--color-surface-1)"
        >
          <button
            type="button"
            class="btn btn--ghost"
            [class.btn--tonal]="categoryKind() === 'build'"
            (click)="switchCategoryKind('build')"
          >
            {{ t('comps.builds') }}
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            [class.btn--tonal]="categoryKind() === 'comp'"
            (click)="switchCategoryKind('comp')"
          >
            {{ t('comps.comps') }}
          </button>
        </div>

        <form
          class="surface grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]"
          (submit)="onCategoryCreateSubmit($event)"
        >
          <input
            class="input"
            type="text"
            placeholder="Category name"
            [value]="categoryDraftName()"
            (input)="onCategoryDraftNameChange($event)"
          />
          <input
            class="input"
            type="text"
            placeholder="Description"
            [value]="categoryDraftDescription()"
            (input)="onCategoryDraftDescriptionChange($event)"
          />
          <button type="submit" class="btn btn--primary" [disabled]="savingCategory()">
            {{ t('common.create') }}
          </button>
        </form>

        <div class="grid gap-3 lg:grid-cols-2">
          @for (category of managedCategories(); track category.id) {
            <article class="surface grid gap-3 p-4">
              @if (editingCategoryId() === category.id) {
                <input
                  class="input"
                  type="text"
                  [value]="categoryEditName()"
                  (input)="onCategoryEditNameChange($event)"
                />
                <input
                  class="input"
                  type="text"
                  [value]="categoryEditDescription()"
                  (input)="onCategoryEditDescriptionChange($event)"
                />
                <div class="flex justify-end gap-2">
                  <button type="button" class="btn btn--ghost" (click)="cancelCategoryEdit()">
                    {{ t('common.cancel') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--primary"
                    [disabled]="savingCategory()"
                    (click)="saveCategoryEdit()"
                  >
                    {{ t('common.save') }}
                  </button>
                </div>
              } @else {
                <header class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="font-semibold" style="color: var(--color-text)">
                      {{ category.name }}
                    </h3>
                    @if (category.description) {
                      <p class="text-sm" style="color: var(--color-text-secondary)">
                        {{ category.description }}
                      </p>
                    }
                  </div>
                  <span class="chip">{{ category.slug || category.id }}</span>
                </header>
                <footer class="flex justify-end gap-2">
                  <button
                    type="button"
                    class="btn btn--outline"
                    (click)="startCategoryEdit(category)"
                  >
                    {{ t('common.edit') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--danger"
                    [disabled]="savingCategory()"
                    (click)="deleteCategory(category.id)"
                  >
                    {{ t('common.delete') }}
                  </button>
                </footer>
              }
            </article>
          }
        </div>
      </section>
    }

    @if (showCreateForm()) {
      <form class="card mb-6 grid gap-4 p-5" (submit)="onCreateSubmit($event)">
        <header>
          <h2 class="text-lg font-semibold" style="color: var(--color-text)">
            {{ createButtonLabel() }}
          </h2>
          <p class="mt-1 text-sm" style="color: var(--color-text-secondary)">
            {{
              tab() === 'comps'
                ? 'Select the required builds and quantities.'
                : 'Define role and optional equipment slots.'
            }}
          </p>
        </header>

        <div class="grid gap-4 md:grid-cols-2">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input class="input" type="text" [value]="draftName()" (input)="onNameChange($event)" />
          </label>
          <label>
            <span class="label">Category</span>
            <select
              class="select"
              [value]="draftCategoryId()"
              (change)="onCategoryIdChange($event)"
            >
              <option value="">Select category</option>
              @for (category of currentCategories(); track category.id) {
                <option [value]="category.id">{{ category.name }}</option>
              }
            </select>
          </label>
        </div>

        <label>
          <span class="label">Description</span>
          <textarea
            class="textarea"
            rows="3"
            [value]="draftDescription()"
            (input)="onDescriptionChange($event)"
          ></textarea>
        </label>

        @if (tab() === 'builds') {
          <label>
            <span class="label">Role</span>
            <select class="select" [value]="draftRole()" (change)="onRoleChange($event)">
              @for (role of roles; track role) {
                <option [value]="role">{{ roleLabel(role) }}</option>
              }
            </select>
          </label>

          <section class="surface grid gap-3 p-4" aria-label="Build items">
            <header class="flex items-center justify-between gap-3">
              <div>
                <h3 class="text-sm font-semibold" style="color: var(--color-text)">Equipment</h3>
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  Search OpenAlbion by item name; ID and item type are filled automatically.
                </p>
              </div>
              <span class="chip">{{ draftItems().length }}/{{ slots.length }}</span>
            </header>

            <div class="grid gap-3 lg:grid-cols-[10rem_8rem_1fr_1fr_auto]">
              <select class="select" [value]="draftItemSlot()" (change)="onItemSlotChange($event)">
                @for (slot of availableSlots(); track slot) {
                  <option [value]="slot">{{ slotLabel(slot) }}</option>
                }
              </select>
              <select class="select" [value]="draftItemTier()" (change)="onItemTierChange($event)">
                @for (tier of itemTiers; track tier) {
                  <option [value]="tier">{{ tier }}</option>
                }
              </select>
              <input
                class="input"
                type="search"
                placeholder="Search item name"
                [value]="draftItemSearch()"
                (input)="onItemSearchChange($event)"
              />
              <select
                class="select"
                [value]="draftSelectedItemId()"
                (change)="onSelectedItemChange($event)"
              >
                <option value="">
                  {{ itemSearchLoading() ? t('common.loading') : 'Select item' }}
                </option>
                @for (item of itemSearchResults(); track item.id) {
                  <option [value]="item.id">{{ item.name }} · {{ item.tier }}</option>
                }
              </select>
              <button type="button" class="btn btn--tonal" (click)="addItemToDraft()">Add</button>
            </div>

            @if (draftItems().length > 0) {
              <div class="grid gap-2">
                @for (item of draftItems(); track item.slot) {
                  <div
                    class="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2"
                    style="background-color: var(--color-surface-1)"
                  >
                    <span>
                      <strong>{{ slotLabel(item.slot) }}</strong> · {{ item.openalbion_item_name }}
                      <span class="text-xs" style="color: var(--color-text-secondary)">
                        #{{ item.openalbion_item_id }} · {{ item.openalbion_item_type }}
                      </span>
                    </span>
                    <button
                      type="button"
                      class="btn btn--ghost"
                      (click)="removeDraftItem(item.slot)"
                    >
                      {{ t('common.delete') }}
                    </button>
                  </div>
                }
              </div>
            }
          </section>
        } @else {
          <label>
            <span class="label">Parent composition</span>
            <select
              class="select"
              [value]="draftParentCompId()"
              (change)="onParentCompChange($event)"
            >
              <option value="">No parent</option>
              @for (comp of comps(); track comp.id) {
                <option [value]="comp.id">{{ comp.name }}</option>
              }
            </select>
          </label>

          <section class="surface grid gap-3 p-4" aria-label="Composition builds">
            <header>
              <h3 class="text-sm font-semibold" style="color: var(--color-text)">Builds</h3>
              <p class="text-xs" style="color: var(--color-text-secondary)">
                Add at least one build with the target roster quantity.
              </p>
            </header>

            <div class="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
              <select
                class="select"
                [value]="selectedBuildId()"
                (change)="onSelectedBuildChange($event)"
              >
                <option value="">Select build</option>
                @for (build of buildOptions(); track build.id) {
                  <option [value]="build.id">
                    {{ build.name }} — {{ roleLabel(build.role) }} —
                    {{ build.category_name || 'No category' }}
                  </option>
                }
              </select>
              <input
                class="input"
                type="number"
                min="1"
                [value]="selectedBuildQuantity()"
                (input)="onSelectedBuildQuantityChange($event)"
              />
              <button type="button" class="btn btn--tonal" (click)="addBuildToDraft()">Add</button>
            </div>

            @if (draftBuildEntries().length > 0) {
              <div class="grid gap-2">
                @for (entry of draftBuildEntries(); track entry.build_id) {
                  <div
                    class="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                    style="background-color: var(--color-surface-1)"
                  >
                    <span>{{ buildName(entry.build_id) }}</span>
                    <span class="chip">x{{ entry.quantity }}</span>
                    <button
                      type="button"
                      class="btn btn--ghost"
                      (click)="removeBuildFromDraft(entry.build_id)"
                    >
                      {{ t('common.delete') }}
                    </button>
                  </div>
                }
              </div>
            }
          </section>
        }

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost" (click)="toggleCreateForm()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" [disabled]="saving()">
            {{ createButtonLabel() }}
          </button>
        </div>
      </form>
    }

    <div
      class="mb-4 inline-flex gap-1 p-1"
      style="background-color: var(--color-surface-1); border-radius: var(--radius-full)"
    >
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'comps'"
        (click)="switchTab('comps')"
      >
        {{ t('comps.comps') }}
      </button>
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'builds'"
        (click)="switchTab('builds')"
      >
        {{ t('comps.builds') }}
      </button>
    </div>

    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (items().length === 0) {
      <app-empty-state [message]="t('common.empty')" icon="package" />
    } @else {
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        @for (item of items(); track item.id) {
          <article class="card p-5">
            @if (editingItemId() === item.id) {
              <div class="grid gap-3">
                <input class="input" type="text" [value]="editItemName()" (input)="onEditItemNameChange($event)" placeholder="Name" />
                <select class="select" [value]="editItemCategoryId()" (change)="onEditItemCategoryIdChange($event)">
                  <option value="">No category</option>
                  @for (category of currentCategories(); track category.id) {
                    <option [value]="category.id">{{ category.name }}</option>
                  }
                </select>
                @if (tab() === 'builds') {
                  <select class="select" [value]="editItemRole()" (change)="onEditItemRoleChange($event)">
                    @for (role of roles; track role) {
                      <option [value]="role">{{ roleLabel(role) }}</option>
                    }
                  </select>
                } @else {
                  <select class="select" [value]="editItemParentId()" (change)="onEditItemParentIdChange($event)">
                    <option value="">No parent</option>
                    @for (comp of comps(); track comp.id) {
                      @if (comp.id !== item.id) {
                        <option [value]="comp.id">{{ comp.name }}</option>
                      }
                    }
                  </select>
                }
                <div class="flex justify-end gap-2 mt-2">
                  <button type="button" class="btn btn--ghost" (click)="cancelEditItem()">{{ t('common.cancel') }}</button>
                  <button type="button" class="btn btn--primary" [disabled]="saving()" (click)="saveEditItem(item.id)">{{ t('common.save') }}</button>
                </div>
              </div>
            } @else {
              <header class="mb-3 flex items-start justify-between gap-2">
                <h3 class="text-base font-semibold" style="color: var(--color-text)">
                  {{ item.name }}
                </h3>
                <span class="chip">{{ item.category_name || 'No category' }}</span>
              </header>
              @if (tab() === 'builds') {
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  {{ roleLabel(asBuild(item).role) }} · {{ asBuild(item).item_count }} item(s)
                </p>
              } @else {
                <p class="text-xs" style="color: var(--color-text-secondary)">
                  {{ asComp(item).build_count }} build(s) · {{ asComp(item).total_quantity }} slots
                </p>

                @if (compPerformance(asComp(item).id); as performance) {
                  <section
                    class="mt-4 grid grid-cols-2 gap-2 rounded-xl border p-3 text-xs"
                    style="border-color: var(--color-border)"
                  >
                    <span>Events: {{ performance.events_with_battles }}</span>
                    <span>W/L: {{ performance.stats.wins }}-{{ performance.stats.losses }}</span>
                    <span>Win: {{ formatPercent(performance.stats.win_rate) }}</span>
                    <span>K/D: {{ formatRatio(performance.stats.kill_death_ratio) }}</span>
                    <span class="col-span-2"
                      >Fame: {{ formatNumber(performance.stats.total_kill_fame) }}</span
                    >
                  </section>
                }
              }

              @if (canCreateCurrent()) {
                <footer class="mt-4 flex justify-end gap-2 border-t pt-3" style="border-color: var(--color-border)">
                  <button type="button" class="btn btn--outline" (click)="startEditItem(item)">{{ t('common.edit') }}</button>
                  <button type="button" class="btn btn--danger" [disabled]="saving()" (click)="deleteItem(item)">{{ t('common.delete') }}</button>
                </footer>
              }
            }
          </article>
        }
      </div>

      <div class="mt-4 flex items-center justify-between">
        <p class="text-xs" style="color: var(--color-text-secondary)">
          {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
        </p>
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" [disabled]="page() <= 1" (click)="prev()">
            {{ t('common.prev') }}
          </button>
          <button
            type="button"
            class="btn btn--outline"
            [disabled]="page() >= totalPages()"
            (click)="next()"
          >
            {{ t('common.next') }}
          </button>
        </div>
      </div>
    }
  `,
})
export class Comps {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly tab = signal<'comps' | 'builds'>('comps');
  protected readonly loading = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly builds = signal<BuildSummary[]>([]);
  protected readonly buildCategories = signal<BuildCategoryView[]>([]);
  protected readonly compCategories = signal<CompCategoryView[]>([]);
  protected readonly buildOptions = signal<BuildSummary[]>([]);
  protected readonly compPerformanceById = signal<Record<number, CompPerformanceView>>({});
  protected readonly saving = signal(false);
  protected readonly savingCategory = signal(false);
  protected readonly showCreateForm = signal(false);
  protected readonly showCategoryManager = signal(false);
  protected readonly categoryKind = signal<CategoryKind>('build');
  protected readonly categoryDraftName = signal('');
  protected readonly categoryDraftDescription = signal('');
  protected readonly editingCategoryId = signal<number | null>(null);
  protected readonly categoryEditName = signal('');
  protected readonly categoryEditDescription = signal('');
  protected readonly draftName = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCategoryId = signal('');
  protected readonly draftRole = signal<BuildRole>('dps');
  protected readonly draftParentCompId = signal('');
  protected readonly editingItemId = signal<number | null>(null);
  protected readonly editItemName = signal('');
  protected readonly editItemCategoryId = signal('');
  protected readonly editItemRole = signal<BuildRole>('dps');
  protected readonly editItemParentId = signal('');
  protected readonly selectedBuildId = signal('');
  protected readonly selectedBuildQuantity = signal(1);
  protected readonly draftBuildEntries = signal<Array<{ build_id: number; quantity: number }>>([]);
  protected readonly draftItemSlot = signal<BuildSlot>('weapon');
  protected readonly draftItemType = signal('');
  protected readonly draftItemId = signal('');
  protected readonly draftItemName = signal('');
  protected readonly draftItemIcon = signal('');
  protected readonly draftItemTier = signal('T8');
  protected readonly draftItemSearch = signal('');
  protected readonly draftSelectedItemId = signal('');
  protected readonly itemSearchResults = signal<OpenAlbionItem[]>([]);
  protected readonly itemSearchLoading = signal(false);
  protected readonly draftItems = signal<BuildItemSlot[]>([]);
  protected readonly roles: readonly BuildRole[] = [
    'healer',
    'support',
    'dps',
    'tank',
    'battle_mount',
    'brawler',
  ];
  protected readonly slots: readonly BuildSlot[] = [
    'head',
    'armor',
    'shoes',
    'potion',
    'food',
    'mount',
    'cape',
    'weapon',
    'off_hand',
  ];
  protected readonly itemTiers: readonly string[] = ['T4', 'T5', 'T6', 'T7', 'T8'];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
    void this.loadFormOptions();
  }

  protected items(): ReadonlyArray<CompSummary | BuildSummary> {
    return this.tab() === 'comps' ? this.comps() : this.builds();
  }

  protected currentCategories(): ReadonlyArray<BuildCategoryView | CompCategoryView> {
    return this.tab() === 'comps' ? this.compCategories() : this.buildCategories();
  }

  protected managedCategories(): ReadonlyArray<ManagedCategory> {
    return this.categoryKind() === 'build' ? this.buildCategories() : this.compCategories();
  }

  protected canManageAnyCategory(): boolean {
    return (
      this.auth.hasPermission('comps.build_categories.manage') ||
      this.auth.hasPermission('comps.comp_categories.manage')
    );
  }

  protected toggleCategoryManager(): void {
    this.showCategoryManager.update((isVisible) => !isVisible);
    this.cancelCategoryEdit();
  }

  protected switchCategoryKind(kind: CategoryKind): void {
    if (this.categoryKind() === kind) {
      return;
    }
    this.categoryKind.set(kind);
    this.resetCategoryDraft();
    this.cancelCategoryEdit();
  }

  protected onCategoryDraftNameChange(event: Event): void {
    this.categoryDraftName.set((event.target as HTMLInputElement).value);
  }

  protected onCategoryDraftDescriptionChange(event: Event): void {
    this.categoryDraftDescription.set((event.target as HTMLInputElement).value);
  }

  protected onCategoryEditNameChange(event: Event): void {
    this.categoryEditName.set((event.target as HTMLInputElement).value);
  }

  protected onCategoryEditDescriptionChange(event: Event): void {
    this.categoryEditDescription.set((event.target as HTMLInputElement).value);
  }

  protected onCategoryCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createCategory();
  }

  protected startCategoryEdit(category: ManagedCategory): void {
    this.editingCategoryId.set(category.id);
    this.categoryEditName.set(category.name);
    this.categoryEditDescription.set(category.description ?? '');
  }

  protected cancelCategoryEdit(): void {
    this.editingCategoryId.set(null);
    this.categoryEditName.set('');
    this.categoryEditDescription.set('');
  }

  protected async saveCategoryEdit(): Promise<void> {
    const categoryId = this.editingCategoryId();
    const name = this.categoryEditName().trim();
    if (!categoryId || !name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const description = this.categoryEditDescription().trim();
    this.savingCategory.set(true);
    try {
      if (this.categoryKind() === 'build') {
        const request: UpdateBuildCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.patch<BuildCategoryView[]>('api/comps/build-categories/' + categoryId, request),
        );
      } else {
        const request: UpdateCompCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.patch<CompCategoryView[]>('api/comps/comp-categories/' + categoryId, request),
        );
      }
      this.cancelCategoryEdit();
      await this.loadFormOptions();
      await this.load();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingCategory.set(false);
    }
  }

  protected async deleteCategory(categoryId: number): Promise<void> {
    this.savingCategory.set(true);
    try {
      const path =
        this.categoryKind() === 'build'
          ? 'api/comps/build-categories/' + categoryId
          : 'api/comps/comp-categories/' + categoryId;
      await firstValueFrom(this.api.delete<void>(path));
      await this.loadFormOptions();
      await this.load();
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingCategory.set(false);
    }
  }

  protected switchTab(tab: 'comps' | 'builds'): void {
    if (this.tab() === tab) {
      return;
    }
    this.tab.set(tab);
    this.page.set(1);
    this.showCreateForm.set(false);
    this.cancelEditItem();
    void this.load();
  }

  protected canCreateCurrent(): boolean {
    if (this.tab() === 'comps') {
      return this.auth.hasPermission('comps.comps.manage');
    }
    return this.auth.hasPermission('comps.builds.manage');
  }

  protected createButtonLabel(): string {
    return `${this.t('common.create')} ${this.tab() === 'comps' ? this.t('comps.comps') : this.t('comps.builds')}`;
  }

  protected toggleCreateForm(): void {
    this.showCreateForm.update((isVisible) => !isVisible);
  }

  protected onNameChange(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onCategoryIdChange(event: Event): void {
    this.draftCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onRoleChange(event: Event): void {
    this.draftRole.set((event.target as HTMLSelectElement).value as BuildRole);
  }

  protected onParentCompChange(event: Event): void {
    this.draftParentCompId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditItemNameChange(event: Event): void {
    this.editItemName.set((event.target as HTMLInputElement).value);
  }

  protected onEditItemCategoryIdChange(event: Event): void {
    this.editItemCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onEditItemRoleChange(event: Event): void {
    this.editItemRole.set((event.target as HTMLSelectElement).value as BuildRole);
  }

  protected onEditItemParentIdChange(event: Event): void {
    this.editItemParentId.set((event.target as HTMLSelectElement).value);
  }

  protected onSelectedBuildChange(event: Event): void {
    this.selectedBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected onSelectedBuildQuantityChange(event: Event): void {
    this.selectedBuildQuantity.set(Math.max(1, Number((event.target as HTMLInputElement).value)));
  }

  protected onItemSlotChange(event: Event): void {
    this.draftItemSlot.set((event.target as HTMLSelectElement).value as BuildSlot);
    this.clearSelectedItem();
    void this.searchItems();
  }

  protected onItemSearchChange(event: Event): void {
    this.draftItemSearch.set((event.target as HTMLInputElement).value);
    this.clearSelectedItem();
    void this.searchItems();
  }

  protected onSelectedItemChange(event: Event): void {
    const itemId = (event.target as HTMLSelectElement).value;
    this.draftSelectedItemId.set(itemId);
    const item = this.itemSearchResults().find((candidate) => String(candidate.id) === itemId);
    if (!item) {
      this.clearSelectedItem();
      return;
    }
    this.draftItemId.set(String(item.id));
    this.draftItemName.set(item.name);
    this.draftItemType.set(item.type);
    this.draftItemTier.set(this.normalizeTier(item.tier));
    this.draftItemIcon.set(this.itemIconUrl(item));
  }

  protected onItemTierChange(event: Event): void {
    this.draftItemTier.set((event.target as HTMLSelectElement).value);
    this.clearSelectedItem();
    void this.searchItems();
  }

  protected addBuildToDraft(): void {
    const buildId = Number(this.selectedBuildId());
    if (buildId <= 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const quantity = this.selectedBuildQuantity();
    this.draftBuildEntries.update((entries) => {
      const existing = entries.find((entry) => entry.build_id === buildId);
      if (existing) {
        return entries.map((entry) =>
          entry.build_id === buildId ? { ...entry, quantity: entry.quantity + quantity } : entry,
        );
      }
      return [...entries, { build_id: buildId, quantity }];
    });
    this.selectedBuildId.set('');
    this.selectedBuildQuantity.set(1);
  }

  protected removeBuildFromDraft(buildId: number): void {
    this.draftBuildEntries.update((entries) =>
      entries.filter((entry) => entry.build_id !== buildId),
    );
  }

  protected addItemToDraft(): void {
    const itemId = Number(this.draftItemId());
    const itemType = this.draftItemType().trim();
    const itemName = this.draftItemName().trim();
    if (itemId <= 0 || !itemType || !itemName) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const item: BuildItemSlot = {
      slot: this.draftItemSlot(),
      openalbion_item_type: itemType,
      openalbion_item_id: itemId,
      openalbion_item_name: itemName,
    };
    const icon = this.draftItemIcon().trim();
    const tier = this.draftItemTier().trim();
    if (icon) {
      item.openalbion_item_icon = icon;
    }
    if (tier) {
      item.openalbion_item_tier = tier;
    }

    this.draftItems.update((items) => [
      ...items.filter((existing) => existing.slot !== item.slot),
      item,
    ]);
    this.resetDraftItem();
  }

  protected removeDraftItem(slot: BuildSlot): void {
    this.draftItems.update((items) => items.filter((item) => item.slot !== slot));
  }

  protected availableSlots(): readonly BuildSlot[] {
    const usedSlots = new Set(this.draftItems().map((item) => item.slot));
    const available = this.slots.filter((slot) => !usedSlots.has(slot));
    return available.length > 0 ? available : this.slots;
  }

  protected buildName(buildId: number): string {
    return this.buildOptions().find((build) => build.id === buildId)?.name ?? `Build #${buildId}`;
  }

  protected roleLabel(role: BuildRole): string {
    return role.replace(/_/g, ' ');
  }

  protected slotLabel(slot: BuildSlot): string {
    const labels: Record<BuildSlot, string> = {
      weapon: 'Weapon',
      off_hand: 'Off-hand',
      head: 'Helmet',
      armor: 'Jacket',
      shoes: 'Shoes',
      cape: 'Cape',
      bag: 'Bag',
      potion: 'Potion',
      food: 'Food',
      mount: 'Mount',
    };
    return labels[slot];
  }

  protected itemIconUrl(item: OpenAlbionItem): string {
    if (item.icon) {
      return item.icon;
    }
    if (!item.identifier) {
      return '';
    }
    return `https://render.albiononline.com/v1/item/${encodeURIComponent(item.identifier)}.png?quality=1&size=64`;
  }

  protected compPerformance(compId: number): CompPerformanceView | null {
    return this.compPerformanceById()[compId] ?? null;
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  protected asBuild(item: CompSummary | BuildSummary): BuildSummary {
    return item as BuildSummary;
  }

  protected asComp(item: CompSummary | BuildSummary): CompSummary {
    return item as CompSummary;
  }

  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createItem();
  }

  private async createCategory(): Promise<void> {
    const name = this.categoryDraftName().trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const description = this.categoryDraftDescription().trim();
    this.savingCategory.set(true);
    try {
      if (this.categoryKind() === 'build') {
        const request: CreateBuildCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.post<BuildCategoryView[]>('api/comps/build-categories', request),
        );
      } else {
        const request: CreateCompCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.post<CompCategoryView[]>('api/comps/comp-categories', request),
        );
      }
      this.resetCategoryDraft();
      await this.loadFormOptions();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingCategory.set(false);
    }
  }

  private resetCategoryDraft(): void {
    this.categoryDraftName.set('');
    this.categoryDraftDescription.set('');
  }

  private async createItem(): Promise<void> {
    const name = this.draftName().trim();
    const categoryId = Number(this.draftCategoryId());
    if (!name || categoryId <= 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (this.tab() === 'comps' && this.draftBuildEntries().length === 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    this.saving.set(true);
    try {
      await this.postCurrentItem(name, categoryId);
      this.resetCreateForm();
      await this.load();
      await this.loadFormOptions();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected startEditItem(item: CompSummary | BuildSummary): void {
    this.editingItemId.set(item.id);
    this.editItemName.set(item.name);
    this.editItemCategoryId.set(String(item.category_id || ''));
    if (this.tab() === 'builds') {
      this.editItemRole.set(this.asBuild(item).role);
    } else {
      this.editItemParentId.set(String(this.asComp(item).parent_id || ''));
    }
  }

  protected cancelEditItem(): void {
    this.editingItemId.set(null);
  }

  protected async saveEditItem(id: number): Promise<void> {
    const name = this.editItemName().trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const categoryIdStr = this.editItemCategoryId();
    const categoryId = categoryIdStr ? Number(categoryIdStr) : undefined;
    
    this.saving.set(true);
    try {
      if (this.tab() === 'builds') {
        const role = this.editItemRole();
        const request: Partial<UpdateBuildRequest> = { name, role };
        if (categoryId !== undefined) request.category_id = categoryId;
        await firstValueFrom(this.api.patch(`api/comps/builds/${id}`, request));
      } else {
        const request: Partial<UpdateCompRequest> = { name };
        if (categoryId !== undefined) request.category_id = categoryId;
        const parentIdStr = this.editItemParentId();
        const parentId = parentIdStr ? Number(parentIdStr) : undefined;
        if (parentId !== undefined) request.parent_id = parentId;
        await firstValueFrom(this.api.patch(`api/comps/${id}`, request));
      }
      this.cancelEditItem();
      await this.loadFormOptions();
      await this.load();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteItem(item: CompSummary | BuildSummary): Promise<void> {
    if (!window.confirm(this.t('comps.delete.confirm'))) {
      return;
    }
    this.saving.set(true);
    try {
      if (this.tab() === 'builds') {
        await firstValueFrom(this.api.delete(`api/comps/builds/${item.id}`));
      } else {
        await firstValueFrom(this.api.delete(`api/comps/${item.id}`));
      }
      await this.loadFormOptions();
      await this.load();
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.load();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.load();
  }

  private async postCurrentItem(name: string, categoryId: number): Promise<void> {
    const description = this.draftDescription().trim();
    if (this.tab() === 'comps') {
      const request: CreateCompRequest = {
        name,
        category_id: categoryId,
        builds: this.draftBuildEntries(),
      };
      if (description) {
        request.description = description;
      }
      const parentId = Number(this.draftParentCompId());
      if (parentId > 0) {
        request.parent_id = parentId;
      }
      await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      return;
    }

    const request: CreateBuildRequest = {
      name,
      category_id: categoryId,
      role: this.draftRole(),
    };
    if (description) {
      request.description = description;
    }
    if (this.draftItems().length > 0) {
      request.items = this.draftItems();
    }
    await firstValueFrom(this.api.post<BuildDetail>('api/comps/builds', request));
  }

  private resetCreateForm(): void {
    this.draftName.set('');
    this.draftDescription.set('');
    this.draftCategoryId.set('');
    this.draftRole.set('dps');
    this.draftParentCompId.set('');
    this.selectedBuildId.set('');
    this.selectedBuildQuantity.set(1);
    this.draftBuildEntries.set([]);
    this.draftItems.set([]);
    this.resetDraftItem();
    this.showCreateForm.set(false);
  }

  private resetDraftItem(): void {
    const nextSlot = this.availableSlots()[0] ?? 'weapon';
    this.draftItemSlot.set(nextSlot);
    this.draftItemSearch.set('');
    this.itemSearchResults.set([]);
    this.clearSelectedItem();
  }

  private clearSelectedItem(): void {
    this.draftSelectedItemId.set('');
    this.draftItemType.set('');
    this.draftItemId.set('');
    this.draftItemName.set('');
    this.draftItemIcon.set('');
  }

  private normalizeTier(tier: string): string {
    const normalized = tier.trim().toUpperCase();
    if (normalized.startsWith('T')) {
      return normalized.split('.')[0];
    }
    return `T${normalized.split('.')[0]}`;
  }

  private openAlbionItemTypeForSlot(
    slot: BuildSlot,
  ): 'weapon' | 'armor' | 'accessory' | 'consumable' {
    if (slot === 'weapon' || slot === 'off_hand') {
      return 'weapon';
    }
    if (slot === 'potion' || slot === 'food') {
      return 'consumable';
    }
    if (slot === 'mount') {
      return 'accessory';
    }
    return 'armor';
  }

  private async searchItems(): Promise<void> {
    const query = this.draftItemSearch().trim();
    if (query.length < 2) {
      this.itemSearchResults.set([]);
      return;
    }

    this.itemSearchLoading.set(true);
    try {
      const tier = Number(this.draftItemTier().replace('T', ''));
      const response = await firstValueFrom(
        this.api.get<PaginatedData<OpenAlbionItem>>('api/openalbion/items', {
          q: query,
          type: this.openAlbionItemTypeForSlot(this.draftItemSlot()),
          tier,
          page: 1,
          limit: 25,
        }),
      );
      this.itemSearchResults.set(response.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.itemSearchLoading.set(false);
    }
  }

  private async loadFormOptions(): Promise<void> {
    try {
      const [buildCategories, compCategories, builds, comps] = await Promise.all([
        firstValueFrom(this.api.get<BuildCategoryView[]>('api/comps/build-categories')),
        firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')),
        firstValueFrom(
          this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', { page: 1, limit: 100 }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 }),
        ),
      ]);
      this.buildCategories.set(buildCategories);
      this.compCategories.set(compCategories);
      this.buildOptions.set(builds.items);
      this.comps.set(comps.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string | number> = { page: this.page(), limit: PAGE_SIZE };
      if (this.tab() === 'comps') {
        const data = await firstValueFrom(
          this.api.get<PaginatedData<CompSummary>>('api/comps', params),
        );
        this.comps.set(data.items);
        await this.loadCompPerformance(data.items);
        this.totalPages.set(data.total_pages);
        return;
      }

      const data = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', params),
      );
      this.compPerformanceById.set({});
      this.builds.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCompPerformance(comps: readonly CompSummary[]): Promise<void> {
    if (comps.length === 0) {
      this.compPerformanceById.set({});
      return;
    }

    const performanceEntries = await Promise.all(
      comps.map(async (comp) => {
        const performance = await firstValueFrom(
          this.api.get<CompPerformanceView>(`api/comps/${comp.id}/performance`),
        );
        return [comp.id, performance] as const;
      }),
    );
    this.compPerformanceById.set(Object.fromEntries(performanceEntries));
  }
}
