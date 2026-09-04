import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { validateBuildName } from '../../shared/validation/build-validation';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildItemSlot,
  BuildItemSpells,
  BuildLoadout,
  BuildRole,
  BuildSlot,
  BuildPerformanceView,
  BuildSummary,
  OpenAlbionItem,
  OpenAlbionItemAbilities,
  PaginatedData,
  UpdateBuildRequest,
} from '../../core/models/api.models';
import { filterAlbionEquipmentCatalog } from '../../shared/data/albion-equipment-catalog';
import {
  DEFAULT_ALBION_ITEM_ENCHANTMENT,
  normalizeAlbionItemEnchantment,
} from '../../shared/data/albion-item-enchantment';
import {
  DEFAULT_ALBION_ITEM_QUALITY,
  normalizeAlbionItemQuality,
} from '../../shared/data/albion-item-quality';
import { SLOT_ORDER, itemsForLoadout } from './build-loadouts';
import {
  abilityCatalogKey,
  abilityKeyForItem,
  abilitySlotsFor,
  withAbilityChoice,
} from '../../shared/data/albion-abilities';
import type { AbilitySlotView } from '../../shared/data/albion-abilities';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AbilityBar } from '../../shared/components/ability-bar/ability-bar';
import type { AbilityChoiceChange } from '../../shared/components/ability-bar/ability-bar';
import { VersionSwitcher } from '../../shared/components/version-switcher/version-switcher';
import { VersionDiffList } from '../../shared/components/version-diff-list/version-diff-list';
import { abilityNameLookup, diffBuildVersions } from './version-diff';
import type { VersionDiffEntry } from './version-diff';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

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
    AbilityBar,
    VersionSwitcher,
    VersionDiffList,
    Dialog,
    Icon,
    TooltipDirective,
    StatCard,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (build(); as current) {
      <app-page-header
        [title]="current.name"
        [subtitle]="roleLabel(current.role) + ' · ' + (current.category_name || t('comps.noCategory'))"
        [badge]="current.archived_at ? t('comps.archived') : undefined"
      >
        <div pageActions class="flex flex-wrap items-center gap-2">
          <a class="btn btn--ghost" routerLink="/comps">← {{ t('comps.title') }}</a>
          <app-version-switcher
            [versions]="current.versions ?? []"
            [currentId]="current.id"
            [canManage]="canManage()"
            [busy]="saving()"
            [label]="t('comps.version')"
            [createLabel]="t('comps.newVersion')"
            (select)="openVersion($event)"
            (create)="createVersion()"
          />
          @if ((current.versions ?? []).length > 1) {
            <button type="button" class="btn btn--outline" (click)="openCompare()">
              {{ t('comps.compare') }}
            </button>
          }
          @if (canManage()) {
            <button
              type="button"
              class="btn"
              [class.btn--primary]="mode() === 'edit'"
              [class.btn--outline]="mode() === 'view'"
              (click)="toggleEditMode()"
              [disabled]="saving()"
            >
              <app-icon [name]="mode() === 'edit' ? 'check' : 'edit'" size="0.75rem" />
              {{ mode() === 'edit' ? 'Termina Modifiche' : 'Modifica Equip' }}
            </button>
            <button
              type="button"
              class="btn btn--outline"
              (click)="openEditMeta()"
              [disabled]="saving()"
            >
              Info Build
            </button>
          }
          @if (canDelete() && mode() === 'view') {
            @if (current.archived_at) {
              <button
                type="button"
                class="btn btn--outline"
                (click)="unarchiveBuild()"
                [disabled]="saving()"
              >
                {{ t('comps.unarchive') }}
              </button>
            } @else {
              <button
                type="button"
                class="btn btn--outline"
                (click)="askArchiveBuild()"
                [disabled]="saving()"
              >
                {{ t('comps.archive') }}
              </button>
            }
          }
        </div>
      </app-page-header>

      <app-page-stack>
        <!-- ================= EDIT MODE BANNER ================= -->
        @if (mode() === 'edit') {
          <div class="p-3.5 rounded-[var(--radius-cards)] border border-[var(--color-warning)]/40 bg-[var(--color-warning-container)] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div class="flex items-center gap-2 text-warning">
              <app-icon name="edit" size="1rem" />
              <span><strong>Modalità Modifica Attiva:</strong> Clicca su uno slot dell'equipaggiamento per cambiare pezzo o livello, oppure cambia gli incantesimi direttamente nella lista sottostante.</span>
            </div>
            <button type="button" class="btn btn--sm btn--primary" (click)="mode.set('view')">
              Fatto
            </button>
          </div>
        }

        <!-- ================= 4 CORE KPI CARDS ================= -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <app-stat-card
            label="Win Rate"
            [value]="winRateFormatted()"
            [tone]="performance() && (performance()!.stats?.wins ?? 0) >= (performance()!.stats?.losses ?? 0) ? 'success' : 'default'"
            icon="trophy"
          />
          <app-stat-card
            label="K / D Ratio"
            [value]="kdRatioFormatted()"
            icon="swords"
          />
          <app-stat-card
            label="Stato Equipaggiamento"
            [value]="equipmentCompletion()"
            icon="shield"
          />
          <app-stat-card
            label="Registrazioni Giocatori"
            [value]="totalSignups()"
            icon="users"
          />
        </div>

        <!-- ================= 2-COLUMN MAIN WORKSPACE ================= -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <!-- LEFT COLUMN: Paperdoll Forge & Spells Deck (7 cols) -->
          <div class="lg:col-span-7 space-y-6">
            <!-- Loadout Card with Tabs -->
            <section class="card p-5 border border-[var(--color-border)] space-y-4">
              <div class="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-[var(--color-border)]">
                <div>
                  <h2 class="text-base font-bold text-[var(--color-text)]">
                    Equipaggiamento Personaggio
                  </h2>
                  <p class="text-xs text-secondary">
                    Configurazione visuale Albion Online per slot principali e pezzi swap tattici.
                  </p>
                </div>
                <app-view-toggle
                  [options]="loadoutOptions()"
                  [active]="activeLoadout()"
                  (activeChange)="onLoadoutChange($event)"
                />
              </div>

              <!-- Equipment Paperdoll Grid -->
              <app-equipment-grid
                [items]="activeItems()"
                [canManage]="canManage() && mode() === 'edit'"
                [editingSlot]="editingSlotFor(activeLoadout())"
                [draftTier]="draftTier()"
                [draftQuality]="draftQuality()"
                [draftEnchantment]="draftEnchantment()"
                [draftSearch]="draftSearch()"
                [draftItemId]="draftItemId()"
                [searchResults]="searchResults()"
                [searchLoading]="searchLoading()"
                [tiers]="ITEM_TIERS"
                [draftAbilitySlots]="draftAbilitySlots()"
                (slotToggle)="onSlotToggle(activeLoadout(), $event)"
                (tierChange)="onDraftTierChangeValue($event)"
                (qualityChange)="onDraftQualityChangeValue($event)"
                (enchantmentChange)="onDraftEnchantmentChangeValue($event)"
                (searchChange)="onDraftSearchChangeValue($event)"
                (itemSelect)="onDraftItemChangeValue($event)"
                (saveSlot)="saveSlot(activeLoadout(), $event)"
                (cancelEdit)="cancelSlotEdit()"
                (removeItem)="askRemoveItem(activeLoadout(), $event)"
                (abilityChoice)="onDraftAbilityChange($event)"
              />
            </section>

            <!-- Spells & Abilities Deck (Right underneath paperdoll) -->
            <section class="card p-5 border border-[var(--color-border)] space-y-4">
              <div class="flex items-center justify-between gap-3">
                <div>
                  <h3 class="text-sm font-bold text-[var(--color-text)]">
                    Incantesimi & Abilità Selezionate ({{ activeLoadout() === 'main' ? 'Main Set' : 'Swap Set' }})
                  </h3>
                  <p class="text-xs text-secondary">
                    Abilità attive (Q, W, E, R, F) e passive legate agli oggetti equipaggiati.
                  </p>
                </div>
                <span class="chip chip--neutral text-[10px] font-mono">
                  {{ activeAbilityRows().length }} pezzi con abilità
                </span>
              </div>

              @if (activeAbilityRows().length > 0) {
                <div class="space-y-3">
                  @for (row of activeAbilityRows(); track row.slot) {
                    <div class="p-3 bg-[var(--color-surface-2)] rounded-[var(--radius-cards)] border border-[var(--color-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div class="flex items-center gap-2.5 min-w-0">
                        @if (row.itemIcon) {
                          <img [src]="row.itemIcon" [alt]="row.itemName" class="w-9 h-9 object-contain rounded bg-[var(--color-surface-1)] p-0.5 border border-[var(--color-border)] shrink-0" />
                        }
                        <div class="min-w-0">
                          <span class="text-xs font-bold text-[var(--color-text)] block truncate">{{ row.itemName }}</span>
                          <span class="text-[10px] text-secondary uppercase tracking-wider font-semibold">{{ slotLabel(row.slot) }}</span>
                        </div>
                      </div>

                      <div class="shrink-0">
                        <app-ability-bar
                          [slots]="row.slots"
                          [canManage]="canManage() && mode() === 'edit'"
                          [emptyLabel]="t('comps.noAbility')"
                          (choiceChange)="onAbilityChange(activeLoadout(), row.slot, $event)"
                        />
                      </div>
                    </div>
                  }
                </div>
              } @else {
                <div class="p-6 text-center rounded-[var(--radius-cards)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs text-secondary">
                  Nessuna abilità configurabile per questo set.
                </div>
              }
            </section>
          </div>

          <!-- RIGHT COLUMN: Tactical Analytics & Guide (5 cols) -->
          <div class="lg:col-span-5 space-y-6">
            <!-- Tactical Guide & Role Card -->
            <section class="card p-5 border border-[var(--color-border)] space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-full" [style.background-color]="roleColorHex(current.role)"></span>
                  <h3 class="text-xs font-bold uppercase tracking-wider text-secondary">
                    Ruolo & Note Tattiche
                  </h3>
                </div>
                <span class="chip font-semibold text-xs" [style.color]="roleColorHex(current.role)">
                  {{ roleLabel(current.role) }}
                </span>
              </div>

              @if (current.description) {
                <p class="text-xs text-[var(--color-text)] leading-relaxed whitespace-pre-line bg-[var(--color-surface-2)] p-3.5 rounded-[var(--radius-cards)] border border-[var(--color-border)]">
                  {{ current.description }}
                </p>
              } @else {
                <p class="text-xs text-disabled italic">
                  Nessuna descrizione o linea guida tattica inserita per questa build.
                </p>
              }
            </section>

            <!-- Combat Telemetry Card -->
            <section class="card p-5 border border-[var(--color-border)] space-y-4">
              <div class="flex items-center justify-between gap-2">
                <h3 class="text-xs font-bold uppercase tracking-wider text-secondary">
                  Telemetria di Combattimento · v{{ current.version }}
                </h3>
                <span class="chip text-xs font-mono">
                  {{ totalSignups() }} Registrazioni
                </span>
              </div>

              @if (performance(); as report) {
                @if (report.stats; as stats) {
                  <div class="grid grid-cols-2 gap-2.5">
                    <div class="p-3 bg-[var(--color-surface-2)] rounded-[var(--radius-cards)] border border-[var(--color-border)]">
                      <span class="text-[10px] text-disabled block">Win Rate</span>
                      <strong class="text-base font-bold text-[var(--color-text)]">{{ winRate(stats.wins, stats.losses) }}</strong>
                      <span class="text-[10px] text-secondary block mt-0.5">{{ stats.wins }}W - {{ stats.losses }}L</span>
                    </div>
                    <div class="p-3 bg-[var(--color-surface-2)] rounded-[var(--radius-cards)] border border-[var(--color-border)]">
                      <span class="text-[10px] text-disabled block">K / D Ratio</span>
                      <strong class="text-base font-bold text-[var(--color-text)]">{{ kdRatioFormatted() }}</strong>
                      <span class="text-[10px] text-secondary block mt-0.5">{{ stats.kills }}K / {{ stats.deaths }}D</span>
                    </div>
                  </div>

                  <div class="text-xs space-y-2 pt-2 border-t border-[var(--color-border)] text-secondary">
                    <div class="flex justify-between">
                      <span>Battaglie Tracciate:</span>
                      <strong class="text-[var(--color-text)] font-mono">{{ stats.battles }}</strong>
                    </div>
                    <div class="flex justify-between">
                      <span>Giocatori Associati:</span>
                      <strong class="text-[var(--color-text)] font-mono">{{ stats.matched_players }}</strong>
                    </div>
                    <div class="flex justify-between">
                      <span>Kill Fame Accumulata:</span>
                      <strong class="text-warning font-mono">{{ stats.kill_fame }}</strong>
                    </div>
                  </div>
                } @else {
                  <p class="text-xs text-secondary">{{ t('comps.noBattleData') }}</p>
                }
              }
            </section>
          </div>
        </div>
      </app-page-stack>

      <!-- Edit Metadata Modal Dialog -->
      @if (editMetaOpen()) {
        <app-dialog [title]="'Modifica Informazioni Build'" size="md" (closed)="closeEditMeta()">
          <form class="grid gap-4" (submit)="saveEdit($event)">
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
                  @for (category of editCategoryOptions(); track category.id) {
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
                rows="4"
                [value]="editDescription()"
                (input)="onEditDescriptionChange($event)"
              ></textarea>
            </label>
            <div class="flex justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
              <button type="button" class="btn btn--ghost" (click)="closeEditMeta()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        </app-dialog>
      }

      @if (comparing()) {
        <app-dialog [title]="t('comps.compare')" size="lg" (closed)="closeCompare()">
          <div class="grid gap-4">
            <label>
              <span class="label">{{ t('comps.compareWith') }}</span>
              <select
                class="select"
                [value]="compareWithId()"
                (change)="onCompareTargetChange($event)"
              >
                @for (entry of current.versions ?? []; track entry.id) {
                  @if (entry.id !== current.id) {
                    <option [value]="entry.id">v{{ entry.version }}</option>
                  }
                }
              </select>
            </label>

            @if (compareWith(); as other) {
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="card p-4">
                  <h3 class="text-sm font-semibold" style="color: var(--color-text)">
                    v{{ other.version }} — {{ t('comps.performance') }}
                  </h3>
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ performanceSummary(comparePerformance()) }}
                  </p>
                </div>
                <div class="card p-4">
                  <h3 class="text-sm font-semibold" style="color: var(--color-text)">
                    v{{ current.version }} — {{ t('comps.performance') }}
                  </h3>
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ performanceSummary(performance()) }}
                  </p>
                </div>
              </div>

              <app-version-diff-list
                [entries]="compareDiff()"
                [emptyLabel]="t('comps.noDifferences')"
                [addedLabel]="t('comps.added')"
                [removedLabel]="t('comps.removed')"
                [changedLabel]="t('comps.changed')"
              />
            }
          </div>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeCompare()">
              {{ t('common.close') }}
            </button>
          </div>
        </app-dialog>
      }

      @if (pendingDelete(); as pending) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeDelete()">
          <p>{{ t('comps.deleteItem') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
            {{ slotLabel(pending.slot) }}
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

      @if (pendingArchive()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeArchiveConfirm()">
          <p>{{ t('comps.archiveConfirm') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
            {{ current.name }}
          </p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeArchiveConfirm()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--tonal"
              [disabled]="saving()"
              (click)="confirmArchiveBuild()"
            >
              {{ t('comps.archive') }}
            </button>
          </div>
        </app-dialog>
      }
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load(buildId())"
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
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly albionAbilities = inject(AlbionAbilitiesService);
  private readonly destroyRef = inject(DestroyRef);

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
  // Preserve the selected category in the native select even if the category list is incomplete.
  protected readonly editCategoryOptions = computed(() => {
    const current = this.build();
    const categories = this.buildCategories();
    if (!current || categories.some((category) => category.id === current.category_id)) {
      return categories;
    }
    return [
      {
        id: current.category_id,
        name: current.category_name ?? this.t('comps.noCategory'),
      },
      ...categories,
    ];
  });

  protected readonly mode = signal<'view' | 'edit'>('view');
  protected readonly activeLoadout = signal<BuildLoadout>('main');
  protected readonly editMetaOpen = signal(false);

  protected readonly loadoutOptions = computed<readonly ViewToggleOption[]>(() => [
    { id: 'main', label: `Main Set (${this.mainItems().length}/${this.SLOT_ORDER.length})` },
    { id: 'swap', label: `Tactical Swap (${this.swapItems().length} Pezzi)` },
  ]);

  protected readonly activeItems = computed(() =>
    this.activeLoadout() === 'main' ? this.mainItems() : this.swapItems(),
  );

  protected readonly activeAbilityRows = computed(() => this.abilityRows(this.activeLoadout()));

  protected readonly winRateFormatted = computed(() => {
    const stats = this.performance()?.stats;
    return stats ? this.winRate(stats.wins, stats.losses) : '—';
  });

  protected readonly kdRatioFormatted = computed(() => {
    const stats = this.performance()?.stats;
    if (!stats) return '—';
    return stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : String(stats.kills);
  });

  protected readonly equipmentCompletion = computed(() => {
    return `${this.mainItems().length}/${this.SLOT_ORDER.length}`;
  });

  protected readonly totalSignups = computed(() => {
    const p = this.performance();
    return (p?.signups_as_primary ?? 0) + (p?.signups_as_secondary ?? 0);
  });

  protected readonly pendingDelete = signal<{ loadout: BuildLoadout; slot: BuildSlot } | null>(
    null,
  );
  protected readonly pendingArchive = signal(false);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  /** Existing build names, fetched lazily so a rename can be checked for duplicates. */
  protected readonly existingBuildNames = signal<string[]>([]);
  protected readonly editRole = signal('');

  /** The slot whose picker is open, together with the loadout it belongs to. */
  protected readonly editing = signal<{ loadout: BuildLoadout; slot: BuildSlot } | null>(null);
  protected readonly draftTier = signal('T8');
  protected readonly draftQuality = signal(DEFAULT_ALBION_ITEM_QUALITY);
  protected readonly draftEnchantment = signal<number>(DEFAULT_ALBION_ITEM_ENCHANTMENT);
  protected readonly draftSearch = signal('');
  protected readonly draftItemId = signal('');
  protected readonly draftItemName = signal('');
  protected readonly draftItemType = signal('');
  protected readonly draftItemIcon = signal<string | null>(null);
  protected readonly searchResults = signal<OpenAlbionItem[]>([]);
  protected readonly searchLoading = signal(false);
  /** Ability-catalog key of the drafted item, so its ability bar can render before it is saved. */
  protected readonly draftAbilityKey = signal<string | null>(null);
  /** Abilities picked in the popover, applied together with the item on save. */
  protected readonly draftSpells = signal<BuildItemSpells>({ active: {}, passive: {} });

  protected readonly t = (key: TranslationKey) => this.translate.t(key);

  protected readonly canManage = computed(() => this.auth.hasPermission('comps.builds.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('comps.builds.delete'));
  /** The bundled ability catalog, loaded once and keyed by tier-stripped base identifier. */
  protected readonly abilityCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});
  protected readonly performance = signal<BuildPerformanceView | null>(null);
  protected readonly comparing = signal(false);
  protected readonly compareWithId = signal('');
  protected readonly compareWith = signal<BuildDetail | null>(null);
  protected readonly comparePerformance = signal<BuildPerformanceView | null>(null);
  protected readonly compareDiff = computed<VersionDiffEntry[]>(() => {
    const current = this.build();
    const other = this.compareWith();
    return current && other
      ? diffBuildVersions(other, current, abilityNameLookup(this.abilityCatalog()))
      : [];
  });
  protected readonly mainItems = computed<BuildItemSlot[]>(() => this.itemsFor('main'));
  protected readonly swapItems = computed<BuildItemSlot[]>(() => this.itemsFor('swap'));
  /** Ability slots for the item currently open in the picker, so it can be chosen before saving. */
  protected readonly draftAbilitySlots = computed<AbilitySlotView[]>(() => {
    const editingState = this.editing();
    const key = this.draftAbilityKey();
    if (!editingState || !key) {
      return [];
    }
    return abilitySlotsFor(editingState.slot, this.abilityCatalog()[key], this.draftSpells());
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The build row on screen.
   *
   * Switching versions navigates within the same route, so Angular reuses this component and the
   * snapshot never changes — the id has to come from the live `paramMap` instead.
   */
  protected readonly buildId = signal(Number(this.route.snapshot.paramMap.get('buildId')));

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = Number(params.get('buildId'));
      if (id === this.buildId() && this.build()) {
        return;
      }
      this.buildId.set(id);
      this.mode.set('view');
      void this.load(id);
    });
    // Static application data; one fetch serves every build page in the session.
    void this.albionAbilities
      .load()
      .then((abilities) => this.abilityCatalog.set(abilities))
      .catch(() => this.abilityCatalog.set({}));

    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) {
        clearTimeout(this.searchTimer);
      }
    });
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
  protected onSlotToggle(loadout: BuildLoadout, slot: BuildSlot): void {
    const editing = this.editing();
    if (editing?.loadout === loadout && editing.slot === slot) {
      this.cancelSlotEdit();
      return;
    }
    this.startSlotEdit(loadout, slot);
  }

  /**
   * Items of one loadout, in canonical slot order.
   *
   * Items stored before swaps existed carry no `loadout`, so they read as `'main'`.
   */
  private itemsFor(loadout: BuildLoadout): BuildItemSlot[] {
    return itemsForLoadout(this.build()?.items ?? [], loadout);
  }

  /** The open slot, but only for the grid that owns it, so one picker is open at a time. */
  protected editingSlotFor(loadout: BuildLoadout): BuildSlot | null {
    const editing = this.editing();
    return editing?.loadout === loadout ? editing.slot : null;
  }

  protected itemForSlot(loadout: BuildLoadout, slot: BuildSlot): BuildItemSlot | null {
    return this.itemsFor(loadout).find((item) => item.slot === slot) ?? null;
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
    void this.loadExistingBuildNames();
  }

  /** Fetches every build name once, so a rename can be checked for duplicates like the create path. */
  private async loadExistingBuildNames(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 500,
        }),
      );
      this.existingBuildNames.set(response.items.map((build) => build.name));
    } catch {
      this.existingBuildNames.set([]);
    }
  }

  protected roleColorHex(role: BuildRole): string {
    switch (role) {
      case 'tank': return 'var(--color-info)';
      case 'healer': return 'var(--color-success)';
      case 'support': return 'var(--color-warning)';
      case 'dps': return 'var(--color-error)';
      case 'brawler': return 'var(--color-primary)';
      case 'battle_mount': return 'var(--color-lavender)';
      default: return 'var(--color-text-secondary)';
    }
  }

  protected onLoadoutChange(id: string): void {
    this.activeLoadout.set(id as BuildLoadout);
  }

  protected toggleEditMode(): void {
    this.mode.set(this.mode() === 'edit' ? 'view' : 'edit');
    if (this.mode() === 'view') {
      this.cancelSlotEdit();
    }
  }

  protected openEditMeta(): void {
    const current = this.build();
    if (!current) return;
    this.editName.set(current.name);
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editRole.set(current.role);
    this.editDescription.set(current.description ?? '');
    this.editMetaOpen.set(true);
    void this.loadExistingBuildNames();
  }

  protected closeEditMeta(): void {
    this.editMetaOpen.set(false);
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.editMetaOpen.set(false);
    this.cancelSlotEdit();
    void this.load(this.buildId());
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

  protected startSlotEdit(loadout: BuildLoadout, slot: BuildSlot): void {
    const current = this.itemForSlot(loadout, slot);
    this.editing.set({ loadout, slot });
    this.draftTier.set(current?.openalbion_item_tier ?? 'T8');
    this.draftQuality.set(normalizeAlbionItemQuality(current?.openalbion_item_quality));
    this.draftEnchantment.set(
      normalizeAlbionItemEnchantment(current?.openalbion_item_enchantment),
    );
    this.draftSearch.set(current?.openalbion_item_name ?? '');
    this.draftItemId.set(current ? String(current.openalbion_item_id) : '');
    this.draftItemName.set(current?.openalbion_item_name ?? '');
    this.draftItemType.set(current?.openalbion_item_type ?? '');
    this.draftItemIcon.set(current?.openalbion_item_icon ?? null);
    this.draftAbilityKey.set(current ? abilityKeyForItem(current) : null);
    this.draftSpells.set(current?.spells ?? { active: {}, passive: {} });
    this.searchResults.set([]);
    if (current) {
      void this.runItemSearch();
    }
  }

  protected cancelSlotEdit(): void {
    this.editing.set(null);
    this.draftSearch.set('');
    this.draftItemId.set('');
    this.draftAbilityKey.set(null);
    this.draftSpells.set({ active: {}, passive: {} });
    this.searchResults.set([]);
  }

  protected onDraftTierChangeValue(tier: string): void {
    this.draftTier.set(tier);
    void this.runItemSearch();
  }

  protected onDraftQualityChangeValue(quality: number): void {
    this.draftQuality.set(normalizeAlbionItemQuality(quality));
  }

  protected onDraftEnchantmentChangeValue(enchantment: number): void {
    this.draftEnchantment.set(normalizeAlbionItemEnchantment(enchantment));
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
      const key = item.identifier ? abilityCatalogKey(item.identifier) : null;
      // A different weapon family offers different slots, so a stale choice from whatever was
      // picked before does not silently carry over onto abilities it cannot actually cast.
      if (key !== this.draftAbilityKey()) {
        this.draftSpells.set({ active: {}, passive: {} });
      }
      this.draftAbilityKey.set(key);
    }
  }

  protected onDraftAbilityChange(change: AbilityChoiceChange): void {
    this.draftSpells.update((spells) =>
      withAbilityChoice(spells, change.kind, change.index, change.spellId),
    );
  }

  protected async saveSlot(loadout: BuildLoadout, slot: BuildSlot): Promise<void> {
    const build = this.build();
    if (!build || !this.draftItemId()) {
      return;
    }
    this.saving.set(true);
    try {
      let updated = await firstValueFrom(
        this.api.put<BuildDetail>(`api/comps/builds/${build.id}/items/${slot}?loadout=${loadout}`, {
          openalbion_item_type: this.draftItemType(),
          openalbion_item_id: Number(this.draftItemId()),
          openalbion_item_name: this.draftItemName(),
          openalbion_item_icon: this.draftItemIcon(),
          openalbion_item_tier: this.draftTier(),
          openalbion_item_quality: this.draftQuality(),
          openalbion_item_enchantment: this.draftEnchantment(),
        }),
      );
      // Abilities picked in the same popover, applied right after the item exists to fill —
      // the spells endpoint targets an existing slot, so it cannot run before this PUT.
      const spells = this.draftSpells();
      if (Object.keys(spells.active).length > 0 || Object.keys(spells.passive).length > 0) {
        updated = await firstValueFrom(
          this.api.put<BuildDetail>(
            `api/comps/builds/${build.id}/items/${slot}/spells?loadout=${loadout}`,
            spells,
          ),
        );
      }
      this.build.set(updated);
      this.cancelSlotEdit();
      this.toasts.success('Item saved');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askRemoveItem(loadout: BuildLoadout, slot: BuildSlot): void {
    this.pendingDelete.set({ loadout, slot });
  }

  protected async removeItem(loadout: BuildLoadout, slot: BuildSlot): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<BuildDetail>(
          `api/comps/builds/${build.id}/items/${slot}?loadout=${loadout}`,
        ),
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
      existingNames: this.existingBuildNames(),
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
      this.editMetaOpen.set(false);
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<BuildDetail>(`api/comps/builds/${build.id}`, request));
      this.mode.set('view');
      this.editMetaOpen.set(false);
      this.cancelSlotEdit();
      await this.load(this.buildId());
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected closeDelete(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmPendingDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) {
      return;
    }
    await this.removeItem(pending.loadout, pending.slot);
  }

  protected askArchiveBuild(): void {
    this.pendingArchive.set(true);
  }

  protected closeArchiveConfirm(): void {
    this.pendingArchive.set(false);
  }

  /**
   * Archives the build in place — unlike the old hard delete, this never fails on references, so
   * there's no blocking-reference branch to fall back to and no need to leave the page.
   */
  protected async confirmArchiveBuild(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/builds/${build.id}/archive`, {}));
      this.pendingArchive.set(false);
      this.toasts.success(this.t('comps.archiveSuccess'));
      await this.load(this.buildId());
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Unarchiving is always safe — no dialog, one click, back into every picker. */
  protected async unarchiveBuild(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/builds/${build.id}/unarchive`, {}));
      this.toasts.success(this.t('comps.unarchiveSuccess'));
      await this.load(this.buildId());
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * One ability bar per equipped item that actually offers abilities.
   *
   * Items with nothing to choose — off-hands, capes, bags, consumables, mounts — produce no row, so
   * the block stays as short as the build is.
   */
  protected abilityRows(
    loadout: BuildLoadout,
  ): { slot: BuildSlot; itemName: string; itemIcon?: string | null; slots: AbilitySlotView[] }[] {
    const catalog = this.abilityCatalog();
    return this.itemsFor(loadout).flatMap((item) => {
      const key = abilityKeyForItem(item);
      const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells);
      return slots.length === 0
        ? []
        : [{ slot: item.slot, itemName: item.openalbion_item_name, itemIcon: item.openalbion_item_icon, slots }];
    });
  }

  protected async onAbilityChange(
    loadout: BuildLoadout,
    slot: BuildSlot,
    change: AbilityChoiceChange,
  ): Promise<void> {
    const build = this.build();
    const item = this.itemForSlot(loadout, slot);
    if (!build || !item) {
      return;
    }

    const next: BuildItemSpells = withAbilityChoice(
      item.spells,
      change.kind,
      change.index,
      change.spellId,
    );
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<BuildDetail>(
          `api/comps/builds/${build.id}/items/${slot}/spells?loadout=${loadout}`,
          next,
        ),
      );
      this.build.set(updated);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Formats a win rate, or a dash when there is nothing to divide.
   *
   * A version with battles but no decided outcome must not read as 0%.
   */
  protected winRate(wins: number, losses: number): string {
    const decided = wins + losses;
    return decided === 0 ? '—' : `${Math.round((wins / decided) * 100)}%`;
  }

  /** A one-line performance summary, saying "no data" rather than implying a 0% win rate. */
  protected performanceSummary(report: BuildPerformanceView | null): string {
    const stats = report?.stats;
    if (!stats) {
      return this.t('comps.noBattleData');
    }
    return `${this.winRate(stats.wins, stats.losses)} · ${stats.kills}/${stats.deaths} · ${stats.battles} battles · ${stats.matched_players} players`;
  }

  protected openCompare(): void {
    const versions = this.build()?.versions ?? [];
    const other = versions.find((entry) => entry.id !== this.build()?.id);
    this.comparing.set(true);
    if (other) {
      this.compareWithId.set(String(other.id));
      void this.loadComparison(other.id);
    }
  }

  protected closeCompare(): void {
    this.comparing.set(false);
    this.compareWith.set(null);
    this.comparePerformance.set(null);
  }

  protected onCompareTargetChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.compareWithId.set(value);
    void this.loadComparison(Number(value));
  }

  private async loadComparison(buildId: number): Promise<void> {
    try {
      const [detail, performance] = await Promise.all([
        firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`)),
        firstValueFrom(
          this.api.get<BuildPerformanceView>(`api/comps/builds/${buildId}/performance`),
        ).catch(() => null),
      ]);
      // Discard if the user has since picked a different comparison target.
      if (Number(this.compareWithId()) !== buildId) return;
      this.compareWith.set(detail);
      this.comparePerformance.set(performance);
    } catch (error) {
      if (Number(this.compareWithId()) !== buildId) return;
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async openVersion(buildId: number): Promise<void> {
    if (buildId === this.build()?.id) {
      return;
    }
    await this.router.navigate(['/comps', 'builds', buildId]);
  }

  protected async createVersion(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<BuildDetail>(`api/comps/builds/${build.id}/versions`, {}),
      );
      this.toasts.success(this.t('comps.versionCreated'));
      await this.router.navigate(['/comps', 'builds', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Performance is per version, so it reloads whenever the page shows a different build row. */
  private async loadPerformance(buildId: number): Promise<void> {
    try {
      const performance = await firstValueFrom(
        this.api.get<BuildPerformanceView>(`api/comps/builds/${buildId}/performance`),
      );
      // Discard if the page has since switched to a different version.
      if (buildId !== this.buildId()) return;
      this.performance.set(performance);
    } catch {
      if (buildId !== this.buildId()) return;
      this.performance.set(null);
    }
  }

  private async runItemSearch(): Promise<void> {
    const slot = this.editing()?.slot;
    if (!slot) {
      this.searchResults.set([]);
      return;
    }

    this.searchLoading.set(true);
    try {
      const catalog = await this.albionCatalog.load();
      this.searchResults.set(
        filterAlbionEquipmentCatalog(catalog, this.draftSearch(), slot, this.draftTier()),
      );
    } catch {
      this.searchResults.set([]);
      this.toasts.error(this.translate.t('common.error'));
    } finally {
      this.searchLoading.set(false);
    }
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
      // Discard if the page has since switched to a different version's build id.
      if (buildId !== this.buildId()) return;
      this.build.set(build);
      this.buildCategories.set(categories);
      void this.loadPerformance(buildId);
    } catch (error) {
      if (buildId !== this.buildId()) return;
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      if (buildId === this.buildId()) {
        this.loading.set(false);
      }
    }
  }
}
