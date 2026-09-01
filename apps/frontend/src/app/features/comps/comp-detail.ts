import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { validateBuildName } from '../../shared/validation/build-validation';

import type {
  BuildDetail,
  OpenAlbionItemAbilities,
  BuildRole,
  BuildSummary,
  CompCategoryView,
  CompDetail,
  CompPerformanceView,
  CompSummary,
  CreateCompRequest,
  OpponentPerformanceView,
  PaginatedData,
  UpdateCompRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { VersionSwitcher } from '../../shared/components/version-switcher/version-switcher';
import { VersionDiffList } from '../../shared/components/version-diff-list/version-diff-list';
import { diffCompVersions } from './version-diff';
import type { VersionDiffEntry } from './version-diff';
import { AbilityBar } from '../../shared/components/ability-bar/ability-bar';
import { abilityKeyForItem, abilitySlotsFor } from '../../shared/data/albion-abilities';
import type { AbilitySlotView } from '../../shared/data/albion-abilities';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';

const ROLES: BuildRole[] = ['healer', 'support', 'dps', 'tank', 'battle_mount', 'brawler'];

const ROLE_LABELS: Record<BuildRole, string> = {
  healer: 'Healer',
  support: 'Support',
  dps: 'DPS',
  tank: 'Tank',
  battle_mount: 'Battle Mount',
  brawler: 'Brawler',
};

/**
 * Composition detail page.
 *
 * Shows aggregated event/battle analytics and lets officers fully edit the
 * composition (metadata, builds, quantities) without leaving the page. Built
 * on top of the existing `/api/comps/{id}` and `/performance` endpoints.
 *
 * @example
 * ```ts
 * routes.push({ path: 'comps/:compId', loadComponent: () => import('./comp-detail').then(m => m.CompDetailPage) });
 * ```
 */
@Component({
  selector: 'app-comp-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PageHeader,
    PageStack,
    EmptyState,
    ErrorState,
    Loading,
    Dialog,
    StatCard,
    VersionSwitcher,
    VersionDiffList,
    AbilityBar,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (comp(); as current) {
      <app-page-header
        [title]="current.name"
        [subtitle]="current.category_name || t('comps.noCategory')"
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
          @if (parentComp(); as parent) {
            <a class="btn btn--outline" [routerLink]="['/comps', parent.id]">
              ↑ {{ parent.name }}
            </a>
          }
          @if ((current.versions ?? []).length > 1) {
            <button type="button" class="btn btn--outline" (click)="openCompare()">
              {{ t('comps.compare') }}
            </button>
          }
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
              class="btn btn--tonal"
              (click)="cloneComp()"
              [disabled]="saving()"
            >
              {{ t('common.clone') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              (click)="askDeleteComp()"
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
                  @for (category of compCategories(); track category.id) {
                    <option [value]="category.id">{{ category.name }}</option>
                  }
                </select>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.description') }}</span>
              <textarea
                class="textarea"
                rows="3"
                [value]="editDescription()"
                (input)="onEditDescriptionChange($event)"
              ></textarea>
            </label>
            <label>
              <span class="label">{{ t('comps.parent') }}</span>
              <select class="select" [value]="editParentId()" (change)="onEditParentChange($event)">
                <option value="">{{ t('comps.noParent') }}</option>
                @for (sibling of availableParents(); track sibling.id) {
                  <option [value]="sibling.id">{{ sibling.name }}</option>
                }
              </select>
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

        <section class="grid gap-4" aria-label="Composition overview">
          <header class="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 class="text-lg font-semibold" style="color: var(--color-text)">
                Composition overview
              </h2>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                Role balance and equipment coverage for this composition.
              </p>
            </div>
            @if (compositionStats().weaponNames.length > 0) {
              <span class="text-xs" style="color: var(--color-text-secondary)">
                {{ compositionStats().weaponNames.join(' · ') }}
              </span>
            }
          </header>

          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <app-stat-card
              label="Builds"
              [value]="current.builds.length"
              [sub]="current.builds.length === 1 ? 'distinct build' : 'distinct builds'"
              icon="package"
              tone="primary"
            />
            <app-stat-card
              label="Roster size"
              [value]="current.total_quantity"
              sub="total player slots"
              icon="users"
              tone="neutral"
            />
            <app-stat-card
              label="Roles"
              [value]="compositionStats().roleCount"
              [sub]="compositionStats().roleSummary"
              icon="shield"
              tone="primary"
            />
            <app-stat-card
              label="Weapon types"
              [value]="buildDetailsLoading() ? null : compositionStats().weaponCount"
              [sub]="buildDetailsLoading() ? 'loading loadouts…' : compositionStats().weaponSummary"
              icon="swords"
              tone="warning"
            />
            <app-stat-card
              label="Builds ready"
              [value]="buildDetailsLoading() ? null : compositionStats().equippedBuildCount"
              [sub]="buildDetailsLoading() ? 'loading loadouts…' : compositionStats().equipmentCoverage"
              icon="check"
              tone="success"
            />
          </div>

          @if (compositionStats().roleDistribution.length > 0) {
            <div class="surface flex flex-wrap gap-2 p-3" aria-label="Role distribution">
              @for (role of compositionStats().roleDistribution; track role.role) {
                <span class="chip">{{ roleLabel(role.role) }} · {{ role.quantity }}</span>
              }
            </div>
          }
        </section>

        <section class="card grid gap-4 p-5" [attr.aria-label]="t('comps.builds')">
          <header class="flex items-center justify-between gap-3">
            <h2 class="text-lg font-semibold" style="color: var(--color-text)">
              {{ t('comps.builds') }} ({{ current.builds.length }}) · {{ current.total_quantity }}
            </h2>
            @if (canManage() && mode() === 'edit') {
              <button type="button" class="btn btn--outline" (click)="toggleAddBuild()">
                {{ addingBuild() ? t('common.close') : t('comps.addBuild') }}
              </button>
            }
          </header>

          @if (addingBuild() && canManage() && mode() === 'edit') {
            <form class="surface grid gap-3 p-4" (submit)="addBuild($event)">
              <div class="grid gap-3 sm:grid-cols-[1fr_8rem_auto]">
                <label class="grid gap-1">
                  <span class="label">{{ t('comps.selectBuild') }}</span>
                  <input
                    class="input"
                    type="search"
                    name="build-search"
                    list="available-composition-builds"
                    autocomplete="off"
                    [placeholder]="t('comps.selectBuild')"
                    [value]="newBuildSearch()"
                    (input)="onNewBuildSearchChange($event)"
                  />
                </label>
                <datalist id="available-composition-builds">
                  @for (build of availableBuildOptions(); track build.id) {
                    <option [value]="buildOptionLabel(build)"></option>
                  }
                </datalist>
                <input
                  class="input"
                  type="number"
                  min="1"
                  [value]="newBuildQuantity()"
                  (input)="onNewBuildQtyChange($event)"
                />
                <button type="submit" class="btn btn--primary" [disabled]="saving()">
                  {{ t('common.add') }}
                </button>
              </div>
            </form>
          }

          @if (current.builds.length === 0) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('comps.noBuilds') }}
            </p>
          } @else {
            <ul class="grid gap-2">
              @for (entry of current.builds; track entry.build_id) {
                <li
                  class="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2"
                  style="background-color: var(--color-surface-1)"
                >
                  <div class="flex items-center gap-3">
                    <a
                      class="font-medium hover:underline"
                      [routerLink]="['/comps', 'builds', entry.build_id]"
                    >
                      {{ entry.build.name }}
                    </a>
                    <span class="chip">{{ roleLabel(entry.build.role) }}</span>
                    <span class="text-xs" style="color: var(--color-text-secondary)">
                      {{ entry.build.category_name || t('comps.noCategory') }}
                    </span>
                  </div>
                  <div class="flex items-center gap-2">
                    @if (canManage()) {
                      <a
                        class="btn btn--outline btn--sm"
                        [routerLink]="['/comps', 'builds', entry.build_id]"
                        [attr.aria-label]="'Edit build ' + entry.build.name"
                      >
                        Edit build
                      </a>
                    }
                    @if (mode() === 'edit' && editingBuildId() === entry.build_id) {
                      <input
                        class="input"
                        type="number"
                        min="1"
                        style="width: 6rem"
                        [value]="editingBuildQty()"
                        (input)="onEditingBuildQtyChange($event)"
                      />
                      <button
                        type="button"
                        class="btn btn--primary btn--sm"
                        (click)="saveBuildQty(entry.build_id)"
                        [disabled]="saving()"
                      >
                        {{ t('common.save') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        (click)="cancelEditBuild()"
                      >
                        {{ t('common.cancel') }}
                      </button>
                    } @else {
                      <span class="chip">x{{ entry.quantity }}</span>
                      @if (canManage() && mode() === 'edit') {
                        <button
                          type="button"
                          class="btn btn--outline btn--sm"
                          (click)="startEditBuild(entry.build_id, entry.quantity)"
                        >
                          {{ t('common.edit') }}
                        </button>
                        <button
                          type="button"
                          class="btn btn--danger btn--sm"
                          (click)="removeBuild(entry.build_id)"
                          [disabled]="saving()"
                        >
                          {{ t('common.delete') }}
                        </button>
                      }
                    }
                  </div>

                  @if (abilityRowsFor(entry.build_id); as rows) {
                    @if (rows.length > 0) {
                      <div class="mt-2 grid gap-2">
                        @for (row of rows; track row.slot) {
                          <div class="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-center">
                            <span class="text-xs" style="color: var(--color-text-secondary)">
                              {{ row.itemName }}
                            </span>
                            <app-ability-bar [slots]="row.slots" [emptyLabel]="t('comps.noAbility')" />
                          </div>
                        }
                      </div>
                    }
                  }
                </li>
              }
            </ul>
          }
        </section>

        @if (performance(); as perf) {
          <section class="card grid gap-4 p-5" [attr.aria-label]="t('comps.performance')">
            <header>
              <h2 class="text-lg font-semibold" style="color: var(--color-text)">
                {{ t('comps.performance') }}
              </h2>
              <p class="text-sm" style="color: var(--color-text-secondary)">
                Aggregated from {{ perf.events_with_battles }} event(s) with linked battles.
              </p>
            </header>
            @if (perf.stats.total_battles === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">
                No battles linked to events using this comp yet.
              </p>
            } @else {
              <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Battles
                  </p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ perf.stats.total_battles }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">W/L</p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ perf.stats.wins }}-{{ perf.stats.losses }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Win rate
                  </p>
                  <p class="text-xl font-bold" [style.color]="winRateColor(perf.stats.win_rate)">
                    {{ formatPercent(perf.stats.win_rate) }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">K/D</p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ formatRatio(perf.stats.kill_death_ratio) }}
                  </p>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ perf.stats.total_kills }}/{{ perf.stats.total_deaths }}
                  </p>
                </div>
                <div class="surface p-3">
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Kill fame
                  </p>
                  <p class="text-xl font-bold" style="color: var(--color-text)">
                    {{ formatNumber(perf.stats.total_kill_fame) }}
                  </p>
                </div>
              </div>

              @if (perf.stats.top_opponents.length > 0) {
                <!-- Shared .table class (thead/hover/borders come from the
                   design system) inside a horizontal-scroll wrapper, matching
                   every other table in the app — this one used to clip its
                   rightmost columns with overflow-hidden instead of
                   scrolling them into view on narrow screens. -->
                <div class="mt-2 overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-left">Opponent</th>
                        <th class="text-right">Battles</th>
                        <th class="text-right">W-L</th>
                        <th class="text-right">Win %</th>
                        <th class="text-right">Our fame</th>
                        <th class="text-right">Their fame</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (opponent of perf.stats.top_opponents; track opponentKey(opponent)) {
                        <tr>
                          <td>{{ opponent.guild_name }}</td>
                          <td class="text-right">{{ opponent.battles }}</td>
                          <td class="text-right">{{ opponent.wins }}-{{ opponent.losses }}</td>
                          <td
                            class="text-right"
                            [style.color]="winRateColor(opponentBattlesWinRate(opponent))"
                          >
                            {{ formatPercent(opponentBattlesWinRate(opponent)) }}
                          </td>
                          <td class="text-right">{{ formatNumber(opponent.guild_kill_fame) }}</td>
                          <td class="text-right">
                            {{ formatNumber(opponent.opponent_kill_fame) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            }
          </section>
        }
      </app-page-stack>

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

      @if (pendingDelete()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeDelete()">
          <p>{{ t('comps.delete.confirm') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">{{ current.name }}</p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeDelete()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              [disabled]="saving()"
              (click)="deleteComp()"
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
        (retry)="load(compId())"
      />
    } @else if (!loading()) {
      <app-empty-state [message]="t('comps.notFound')" icon="package" />
    }
  `,
})
export class CompDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly albionAbilities = inject(AlbionAbilitiesService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly comp = signal<CompDetail | null>(null);
  protected readonly parentComp = signal<CompSummary | null>(null);
  protected readonly performance = signal<CompPerformanceView | null>(null);
  protected readonly compCategories = signal<CompCategoryView[]>([]);
  protected readonly buildOptions = signal<BuildSummary[]>([]);
  protected readonly compSummaries = signal<CompSummary[]>([]);
  private readonly buildDetails = signal<ReadonlyMap<number, BuildDetail>>(new Map());
  private readonly abilityCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});
  protected readonly comparing = signal(false);
  protected readonly compareWithId = signal('');
  protected readonly compareWith = signal<CompDetail | null>(null);
  protected readonly comparePerformance = signal<CompPerformanceView | null>(null);
  protected readonly compareDiff = computed<VersionDiffEntry[]>(() => {
    const current = this.comp();
    const other = this.compareWith();
    return current && other ? diffCompVersions(other, current) : [];
  });
  protected readonly buildDetailsLoading = signal(false);

  protected readonly mode = signal<'view' | 'edit'>('view');
  protected readonly pendingDelete = signal(false);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  protected readonly editParentId = signal('');

  protected readonly addingBuild = signal(false);
  protected readonly newBuildId = signal('');
  protected readonly newBuildSearch = signal('');
  protected readonly newBuildQuantity = signal(1);

  protected readonly editingBuildId = signal<number | null>(null);
  protected readonly editingBuildQty = signal(1);

  protected readonly t = (key: TranslationKey) => this.translate.t(key);

  protected readonly canManage = computed(() => this.auth.hasPermission('comps.comps.manage'));
  protected readonly availableParents = computed(() =>
    this.compSummaries().filter((sibling) => sibling.id !== this.comp()?.id),
  );
  protected readonly availableBuildOptions = computed(() => {
    const assignedBuildIds = new Set(this.comp()?.builds.map((entry) => entry.build_id) ?? []);
    return this.buildOptions().filter((build) => !assignedBuildIds.has(build.id));
  });
  protected readonly compositionStats = computed(() => {
    const comp = this.comp();
    const roleQuantities = new Map<BuildRole, number>();
    const weaponNames = new Set<string>();
    let equippedBuildCount = 0;

    for (const entry of comp?.builds ?? []) {
      roleQuantities.set(
        entry.build.role,
        (roleQuantities.get(entry.build.role) ?? 0) + entry.quantity,
      );
      const weapon = this.buildDetails().get(entry.build_id)?.items.find((item) => item.slot === 'weapon');
      if (weapon) {
        equippedBuildCount += 1;
        weaponNames.add(weapon.openalbion_item_name);
      }
    }

    const roleDistribution = ROLES.filter((role) => roleQuantities.has(role)).map((role) => ({
      role,
      quantity: roleQuantities.get(role) ?? 0,
    }));
    return {
      roleCount: roleQuantities.size,
      roleDistribution,
      roleSummary:
        roleDistribution.map(({ role, quantity }) => `${ROLE_LABELS[role]} ${quantity}`).join(' · ') ||
        'no roles assigned',
      weaponCount: weaponNames.size,
      weaponNames: [...weaponNames].sort((left, right) => left.localeCompare(right)),
      weaponSummary: weaponNames.size === 1 ? 'unique weapon' : 'unique weapons',
      equippedBuildCount,
      equipmentCoverage: `${equippedBuildCount}/${comp?.builds.length ?? 0} builds have a weapon`,
    };
  });

  /**
   * The comp row on screen.
   *
   * Switching versions navigates within the same route, so Angular reuses this component and the
   * snapshot never changes — the id has to come from the live `paramMap` instead.
   */
  protected readonly compId = signal(Number(this.route.snapshot.paramMap.get('compId')));

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = Number(params.get('compId'));
      if (id === this.compId() && this.comp()) {
        return;
      }
      this.compId.set(id);
      this.mode.set('view');
      void this.load(id);
    });
    // Static application data; one fetch serves every comp page in the session.
    void this.albionAbilities
      .load()
      .then((abilities) => this.abilityCatalog.set(abilities))
      .catch(() => this.abilityCatalog.set({}));
  }

  /**
   * The read-only ability bars for one build in the comp.
   *
   * Only the main loadout is shown here — the comp view answers "what do I slot", and the swap has
   * its own bars on the build page. A build with no chosen abilities produces no rows at all.
   */
  protected abilityRowsFor(
    buildId: number,
  ): { slot: string; itemName: string; slots: AbilitySlotView[] }[] {
    const detail = this.buildDetails().get(buildId);
    const catalog = this.abilityCatalog();
    if (!detail) {
      return [];
    }
    return detail.items.flatMap((item) => {
      if ((item.loadout ?? 'main') !== 'main') {
        return [];
      }
      const key = abilityKeyForItem(item);
      const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells).filter(
        (view) => view.selected !== null,
      );
      return slots.length === 0
        ? []
        : [{ slot: item.slot, itemName: item.openalbion_item_name, slots }];
    });
  }

  protected openCompare(): void {
    const versions = this.comp()?.versions ?? [];
    const other = versions.find((entry) => entry.id !== this.comp()?.id);
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

  /**
   * A one-line performance summary, saying "no data" rather than implying a 0% win rate.
   *
   * A version with battles but none decided must not read as a loss either, hence the dash.
   */
  protected performanceSummary(report: CompPerformanceView | null): string {
    const stats = report?.stats;
    if (!stats || stats.total_battles === 0) {
      return this.t('comps.noBattleData');
    }
    const decided = stats.wins + stats.losses;
    const rate = decided === 0 ? '—' : `${Math.round((stats.wins / decided) * 100)}%`;
    return `${rate} · ${stats.total_kills}/${stats.total_deaths} · ${stats.total_battles} battles`;
  }

  private async loadComparison(compId: number): Promise<void> {
    try {
      const [detail, performance] = await Promise.all([
        firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`)),
        firstValueFrom(
          this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`),
        ).catch(() => null),
      ]);
      this.compareWith.set(detail);
      this.comparePerformance.set(performance);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async openVersion(compId: number): Promise<void> {
    if (compId === this.comp()?.id) {
      return;
    }
    await this.router.navigate(['/comps', compId]);
  }

  protected async createVersion(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<CompDetail>(`api/comps/${comp.id}/versions`, {}),
      );
      this.toasts.success(this.t('comps.versionCreated'));
      await this.router.navigate(['/comps', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected roleLabel(role: BuildRole): string {
    return ROLE_LABELS[role] ?? role;
  }

  protected buildOptionLabel(build: BuildSummary): string {
    return `${build.name} — ${this.roleLabel(build.role)} — ${build.category_name || this.t('comps.noCategory')}`;
  }

  protected enterEdit(): void {
    const current = this.comp();
    if (!current) {
      return;
    }
    this.editName.set(current.name);
    this.editDescription.set(current.description ?? '');
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editParentId.set(current.parent_id ? String(current.parent_id) : '');
    this.mode.set('edit');
    void this.loadEditOptions();
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.addingBuild.set(false);
    this.cancelEditBuild();
    void this.load(this.compId());
  }

  protected toggleAddBuild(): void {
    this.addingBuild.update((value) => !value);
    this.newBuildId.set('');
    this.newBuildSearch.set('');
    this.newBuildQuantity.set(1);
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

  protected onEditParentChange(event: Event): void {
    this.editParentId.set((event.target as HTMLSelectElement).value);
  }

  protected onNewBuildSearchChange(event: Event): void {
    const search = (event.target as HTMLInputElement).value;
    const selectedBuild = this.availableBuildOptions().find(
      (build) => this.buildOptionLabel(build) === search,
    );

    this.newBuildSearch.set(search);
    this.newBuildId.set(selectedBuild ? String(selectedBuild.id) : '');
  }

  protected onNewBuildQtyChange(event: Event): void {
    this.newBuildQuantity.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected onEditingBuildQtyChange(event: Event): void {
    this.editingBuildQty.set(Number((event.target as HTMLInputElement).value) || 1);
  }

  protected startEditBuild(buildId: number, currentQty: number): void {
    this.editingBuildId.set(buildId);
    this.editingBuildQty.set(currentQty);
  }

  protected cancelEditBuild(): void {
    this.editingBuildId.set(null);
  }

  protected async saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    const comp = this.comp();
    if (!comp) {
      return;
    }

    // Validated even when unchanged: the previous version only applied the
    // name `if (editName())`, so clearing the field was silently ignored
    // instead of rejected, and the save still reported success.
    const nameError = validateBuildName(this.editName(), {
      existingNames: [],
      currentName: comp.name,
    });
    if (nameError) {
      this.toasts.error(nameError.message);
      return;
    }

    const request: UpdateCompRequest = {};
    const name = this.editName().trim();
    if (name !== comp.name) request.name = name;
    // Compared against the current value rather than tested for truthiness,
    // so an emptied description actually clears instead of being dropped.
    if (this.editDescription() !== (comp.description ?? '')) {
      request.description = this.editDescription();
    }
    const categoryId = this.editCategoryId() ? Number(this.editCategoryId()) : undefined;
    if (categoryId && categoryId !== comp.category_id) request.category_id = categoryId;
    const parentId = this.editParentId() ? Number(this.editParentId()) : null;
    if ((parentId ?? null) !== (comp.parent_id ?? null)) {
      request.parent_id = parentId ?? undefined;
    }

    if (Object.keys(request).length === 0) {
      this.mode.set('view');
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<CompDetail>(`api/comps/${comp.id}`, request));
      this.mode.set('view');
      this.addingBuild.set(false);
      this.cancelEditBuild();
      await this.load(this.compId());
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async cloneComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const request: CreateCompRequest = {
        name: `${comp.name} (clone)`,
        category_id: comp.category_id,
        builds: comp.builds.map((entry) => ({
          build_id: entry.build_id,
          quantity: entry.quantity,
        })),
      };
      const created = await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      this.toasts.success('Composition cloned');
      await this.router.navigate(['/comps', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askDeleteComp(): void {
    this.pendingDelete.set(true);
  }

  protected closeDelete(): void {
    this.pendingDelete.set(false);
  }

  protected async deleteComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/${comp.id}`));
      this.pendingDelete.set(false);
      this.toasts.success(this.t('common.delete'));
      await this.router.navigate(['/comps']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async addBuild(event: Event): Promise<void> {
    event.preventDefault();
    const comp = this.comp();
    const buildId = Number(this.newBuildId());
    const isAvailable = this.availableBuildOptions().some((build) => build.id === buildId);
    if (!comp || !buildId || !isAvailable) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<CompDetail>(`api/comps/${comp.id}/builds`, {
          build_id: buildId,
          quantity: this.newBuildQuantity(),
        }),
      );
      this.comp.set(updated);
      void this.loadBuildDetails(updated);
      this.toggleAddBuild();
      this.toasts.success('Build added');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveBuildQty(buildId: number): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<CompDetail>(`api/comps/${comp.id}/builds/${buildId}`, {
          quantity: this.editingBuildQty(),
        }),
      );
      this.comp.set(updated);
      void this.loadBuildDetails(updated);
      this.cancelEditBuild();
      this.toasts.success('Quantity updated');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async removeBuild(buildId: number): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/comps/${comp.id}/builds/${buildId}`));
      await this.load(this.compId());
      this.toasts.success('Build removed');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  protected opponentBattlesWinRate(opponent: OpponentPerformanceView): number {
    if (opponent.battles === 0) {
      return 0;
    }
    return (opponent.wins / opponent.battles) * 100;
  }

  protected winRateColor(rate: number): string {
    if (rate >= 60) return 'var(--color-success)';
    if (rate < 40) return 'var(--color-danger)';
    return 'var(--color-text)';
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat('en-US').format(value);
  }

  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  private async loadEditOptions(): Promise<void> {
    const [categories, builds, summaries] = await Promise.all([
      firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')).catch(() => []),
      firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      ).catch(() => ({ items: [] as BuildSummary[] })),
      firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      ).catch(() => ({ items: [] as CompSummary[] })),
    ]);
    this.compCategories.set(categories);
    this.buildOptions.set(builds.items);
    this.compSummaries.set(summaries.items);
  }

  /** Loads the equipment required to calculate weapon and readiness statistics. */
  private async loadBuildDetails(comp: CompDetail): Promise<void> {
    this.buildDetailsLoading.set(true);
    try {
      const details = await Promise.all(
        comp.builds.map((entry) =>
          firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${entry.build_id}`)).catch(
            () => null,
          ),
        ),
      );
      this.buildDetails.set(
        new Map(
          details
            .filter((detail): detail is BuildDetail => detail !== null)
            .map((detail) => [detail.id, detail]),
        ),
      );
    } finally {
      this.buildDetailsLoading.set(false);
    }
  }

  protected async load(compId: number): Promise<void> {
    if (!Number.isFinite(compId) || compId <= 0) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [comp, performance] = await Promise.all([
        firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`)),
        firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`)).catch(
          () => null,
        ),
      ]);
      this.comp.set(comp);
      this.performance.set(performance);
      void this.loadBuildDetails(comp);
      if (comp.parent_id) {
        const parent = await firstValueFrom(
          this.api.get<CompSummary>(`api/comps/${comp.parent_id}`),
        ).catch(() => null);
        this.parentComp.set(parent);
      } else {
        this.parentComp.set(null);
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
