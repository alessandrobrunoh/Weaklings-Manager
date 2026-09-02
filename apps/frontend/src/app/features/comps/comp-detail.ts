import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { validateBuildName } from '../../shared/validation/build-validation';

import type {
  BuildDetail,
  BuildItemSlot,
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
import { ApiError, ApiService } from '../../core/services/api.service';
import type { BlockingReference } from '../../core/models/api.models';
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
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

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
    Icon,
    TooltipDirective,
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
          }
          @if (canDelete() && mode() === 'view') {
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
                <select class="select" (change)="onEditCategoryChange($event)">
                  <option value="" [selected]="!editCategoryId()">
                    {{ t('comps.noCategory') }}
                  </option>
                  @for (category of editCategoryOptions(); track category.id) {
                    <option
                      [value]="category.id"
                      [selected]="isSelectedId(editCategoryId(), category.id)"
                    >
                      {{ category.name }}
                    </option>
                  }
                </select>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.description') }}</span>
              <textarea
                class="textarea"
                rows="2"
                [value]="editDescription()"
                (input)="onEditDescriptionChange($event)"
              ></textarea>
            </label>
            <label>
              <span class="label">{{ t('comps.parent') }}</span>
              <select class="select" (change)="onEditParentChange($event)">
                <option value="" [selected]="!editParentId()">{{ t('comps.noParent') }}</option>
                @for (sibling of editParentOptions(); track sibling.id) {
                  <option
                    [value]="sibling.id"
                    [selected]="isSelectedId(editParentId(), sibling.id)"
                  >
                    {{ sibling.name }}
                  </option>
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

        <!-- 2-COLUMN MAIN VIEWPORT -->
        <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <!-- LEFT COLUMN: Albion-Native Party Matrix (8 cols) -->
          <div class="lg:col-span-8 grid gap-6">
            <!-- Section Header & Add Build Controller -->
            <div class="card flex flex-wrap items-center justify-between gap-3 p-4">
              <div class="flex items-center gap-2">
                <app-icon name="users" size="1.1rem" color="var(--color-text-secondary)" />
                <div>
                  <h2 class="text-base font-bold text-[var(--color-text)]">
                    {{ t('comps.rosterTitle') }}
                  </h2>
                  <p class="text-xs text-[var(--color-text-secondary)]">
                    {{
                      t('comps.rosterSubtitle', {
                        slots: current.total_quantity,
                        builds: current.builds.length,
                      })
                    }}
                  </p>
                </div>
              </div>

              @if (canManage() && mode() === 'edit') {
                <button type="button" class="btn btn--primary btn--sm" (click)="toggleAddBuild()">
                  <app-icon name="plus" size="0.75rem" />
                  {{ addingBuild() ? t('common.close') : t('comps.addBuild') }}
                </button>
              }
            </div>

            <!-- Add Build Panel (when active) -->
            @if (addingBuild() && canManage() && mode() === 'edit') {
              <form
                class="p-4 bg-[var(--color-surface-2)] rounded-xl border border-[var(--color-border-strong)] grid gap-3"
                (submit)="addBuild($event)"
              >
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
                  <label class="grid gap-1">
                    <span class="label">{{ t('comps.quantity') }}</span>
                    <input
                      class="input"
                      type="number"
                      min="1"
                      [value]="newBuildQuantity()"
                      (input)="onNewBuildQtyChange($event)"
                    />
                  </label>
                  <div class="flex items-end">
                    <button type="submit" class="btn btn--primary" [disabled]="saving()">
                      {{ t('common.add') }}
                    </button>
                  </div>
                </div>
              </form>
            }

            @if (current.builds.length === 0) {
              <app-empty-state icon="package" [message]="t('comps.noBuilds')" />
            } @else {
              <!-- Role Grouped Matrix Cards -->
              @for (roleGroup of groupedBuildsByRole(); track roleGroup.role) {
                <section class="grid gap-3">
                  <div class="flex items-center justify-between px-1">
                    <div class="flex items-center gap-2">
                      <span
                        class="w-3 h-3 rounded-full"
                        [style.background-color]="roleColorHex(roleGroup.role)"
                      ></span>
                      <h3
                        class="text-sm font-bold uppercase tracking-wider text-[var(--color-text)]"
                      >
                        {{ roleLabel(roleGroup.role) }} ({{ roleGroup.totalSlots }} slots)
                      </h3>
                    </div>
                    <span class="text-xs text-[var(--color-text-secondary)]">
                      {{ roleGroup.entries.length }} {{ t('comps.buildVariants') }}
                    </span>
                  </div>

                  <div class="grid gap-3 sm:grid-cols-2">
                    @for (entry of roleGroup.entries; track entry.build_id) {
                      <div
                        class="card flex flex-col justify-between p-4 transition-all"
                        [style.border-left-width]="'4px'"
                        [style.border-left-color]="roleColorHex(entry.build.role)"
                      >
                        <!-- Card Header -->
                        <div class="flex items-start justify-between gap-2">
                          <div class="flex items-start gap-2 min-w-0">
                            <!-- Weapon Icon -->
                            <div
                              class="shrink-0 w-10 h-10 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-border)] grid place-items-center overflow-hidden"
                              [appTooltip]="weaponNameFor(entry.build_id) || t('comps.noWeapon')"
                            >
                              @if (weaponIconFor(entry.build_id); as weaponIcon) {
                                <img
                                  class="w-full h-full object-contain p-1"
                                  [src]="weaponIcon"
                                  [alt]="weaponNameFor(entry.build_id) ?? ''"
                                  loading="lazy"
                                  (error)="hideBrokenIcon($event)"
                                />
                              } @else {
                                <app-icon
                                  name="swords"
                                  size="1rem"
                                  color="var(--color-text-secondary)"
                                />
                              }
                            </div>

                            <div class="flex flex-col gap-0.5 min-w-0">
                              <a
                                class="font-semibold text-base text-[var(--color-text)] hover:underline truncate"
                                [routerLink]="['/comps', 'builds', entry.build_id]"
                              >
                                {{ entry.build.name }}
                              </a>
                              <span class="text-xs text-[var(--color-text-secondary)] truncate">
                                {{ entry.build.category_name || t('comps.noCategory') }}
                              </span>
                            </div>
                          </div>

                          <!-- Quantity Pill / Stepper -->
                          @if (mode() === 'edit' && editingBuildId() === entry.build_id) {
                            <div class="flex items-center gap-1">
                              <input
                                class="input text-center w-14"
                                type="number"
                                min="1"
                                [value]="editingBuildQty()"
                                (input)="onEditingBuildQtyChange($event)"
                              />
                              <button
                                type="button"
                                class="btn btn--primary btn--sm"
                                (click)="saveBuildQty(entry.build_id)"
                                [disabled]="saving()"
                              >
                                ✓
                              </button>
                              <button
                                type="button"
                                class="btn btn--ghost btn--sm"
                                (click)="cancelEditBuild()"
                              >
                                ✕
                              </button>
                            </div>
                          } @else {
                            <div class="flex items-center gap-1.5">
                              <span
                                class="px-2.5 py-1 rounded-full text-xs font-bold bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)]"
                              >
                                x{{ entry.quantity }}
                              </span>
                              @if (canManage() && mode() === 'edit') {
                                <button
                                  type="button"
                                  class="btn btn--ghost btn--sm"
                                  (click)="startEditBuild(entry.build_id, entry.quantity)"
                                >
                                  <app-icon name="edit" size="0.75rem" />
                                </button>
                                <button
                                  type="button"
                                  class="btn btn--ghost btn--sm text-[var(--color-error)]"
                                  (click)="removeBuild(entry.build_id)"
                                  [disabled]="saving()"
                                >
                                  <app-icon name="close" size="0.75rem" />
                                </button>
                              }
                            </div>
                          }
                        </div>

                        <!-- Weapon & Ability Preview Bar -->
                        @if (abilityRowsFor(entry.build_id); as rows) {
                          @if (rows.length > 0) {
                            <div class="mt-3 pt-3 border-t border-[var(--color-border)] grid gap-2">
                              @for (row of rows; track row.slot) {
                                <div class="flex items-center justify-between gap-2">
                                  <span
                                    class="text-xs font-medium text-[var(--color-text-secondary)] truncate max-w-[120px]"
                                  >
                                    {{ row.itemName }}
                                  </span>
                                  <app-ability-bar
                                    [slots]="row.slots"
                                    [emptyLabel]="t('comps.noAbility')"
                                  />
                                </div>
                              }
                            </div>
                          }
                        }
                      </div>
                    }
                  </div>
                </section>
              }
            }
          </div>

          <!-- RIGHT COLUMN: Tactical Analytics & Blueprint Sidebar (4 cols) -->
          <aside class="lg:col-span-4 grid gap-5">
            <!-- Blueprint Stats Card -->
            <div class="card p-5 grid gap-4">
              <h3
                class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
              >
                {{ t('comps.roleBalance') }}
              </h3>

              <!-- Role Balance Progress Bar -->
              <div class="flex h-3 w-full rounded-full overflow-hidden bg-[var(--color-surface-2)]">
                @for (dist of compositionStats().roleDistribution; track dist.role) {
                  <div
                    [style.width.%]="formatRolePercent(dist.quantity, current.total_quantity)"
                    [style.background-color]="roleColorHex(dist.role)"
                    [appTooltip]="roleLabel(dist.role) + ': ' + dist.quantity"
                  ></div>
                }
              </div>

              <div class="grid grid-cols-2 gap-2 text-xs">
                @for (dist of compositionStats().roleDistribution; track dist.role) {
                  <div
                    class="flex items-center justify-between p-2 rounded-lg bg-[var(--color-surface-2)]"
                  >
                    <div class="flex items-center gap-1.5">
                      <span
                        class="w-2 h-2 rounded-full"
                        [style.background-color]="roleColorHex(dist.role)"
                      ></span>
                      <span>{{ roleLabel(dist.role) }}</span>
                    </div>
                    <span class="font-bold"
                      >{{ dist.quantity }} ({{
                        formatRolePercent(dist.quantity, current.total_quantity)
                      }}%)</span
                    >
                  </div>
                }
              </div>

              @if (compositionStats().weaponNames.length > 0) {
                <div class="pt-3 border-t border-[var(--color-border)]">
                  <span
                    class="text-xs font-semibold text-[var(--color-text-secondary)] block mb-1"
                    >{{ t('comps.weaponsInComp') }}</span
                  >
                  <div class="flex flex-wrap gap-1">
                    @for (wName of compositionStats().weaponNames; track wName) {
                      <span class="chip text-xs">{{ wName }}</span>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- Performance Telemetry Card -->
            @if (performance(); as perf) {
              <div class="card p-5 grid gap-4">
                <h3
                  class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
                >
                  {{ t('comps.battlePerformance') }}
                </h3>

                <div class="grid grid-cols-2 gap-3 text-center">
                  <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
                    <div
                      class="text-xl font-bold"
                      [style.color]="winRateColor(perf.stats.win_rate)"
                    >
                      {{ formatPercent(perf.stats.win_rate) }}
                    </div>
                    <div class="text-xs text-[var(--color-text-secondary)]">
                      {{ t('comps.winrate') }}
                    </div>
                  </div>
                  <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
                    <div class="text-xl font-bold text-[var(--color-text)]">
                      {{ formatRatio(perf.stats.kill_death_ratio) }}
                    </div>
                    <div class="text-xs text-[var(--color-text-secondary)]">
                      {{ t('comps.kdRatio') }}
                    </div>
                  </div>
                </div>

                <div class="text-xs space-y-1.5 text-[var(--color-text-secondary)]">
                  <div class="flex justify-between">
                    <span>{{ t('comps.totalBattles') }}:</span>
                    <strong class="text-[var(--color-text)]">{{ perf.stats.total_battles }}</strong>
                  </div>
                  <div class="flex justify-between">
                    <span>{{ t('comps.winsLosses') }}:</span>
                    <strong class="text-[var(--color-text)]"
                      >{{ perf.stats.wins }}W - {{ perf.stats.losses }}L</strong
                    >
                  </div>
                  <div class="flex justify-between">
                    <span>{{ t('comps.killFame') }}:</span>
                    <strong class="text-[var(--color-text)]">{{
                      formatNumber(perf.stats.total_kill_fame)
                    }}</strong>
                  </div>
                </div>

                @if (perf.stats.top_opponents.length > 0) {
                  <div class="pt-3 border-t border-[var(--color-border)]">
                    <span
                      class="text-xs font-semibold text-[var(--color-text-secondary)] block mb-2"
                      >{{ t('comps.topOpponents') }}</span
                    >
                    <div class="overflow-x-auto">
                      <table class="table text-xs">
                        <thead>
                          <tr>
                            <th class="text-left">{{ t('comps.opponent') }}</th>
                            <th class="text-right">W-L</th>
                            <th class="text-right">{{ t('comps.winPercent') }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (opponent of perf.stats.top_opponents; track opponentKey(opponent)) {
                            <tr>
                              <td>{{ opponent.guild_name }}</td>
                              <td class="text-right">{{ opponent.wins }}-{{ opponent.losses }}</td>
                              <td
                                class="text-right"
                                [style.color]="winRateColor(opponentBattlesWinRate(opponent))"
                              >
                                {{ formatPercent(opponentBattlesWinRate(opponent)) }}
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  </div>
                }
              </div>
            }
          </aside>
        </div>
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
          @if (blockedByRefs(); as refs) {
            <p>{{ t('comps.delete.blocked', { name: current.name }) }}</p>
            <ul class="mt-2 grid gap-1 text-sm">
              @for (ref of refs; track ref.resource + ':' + ref.id) {
                <li>
                  @if (ref.resource === 'event') {
                    <a
                      class="text-primary no-underline hover:underline"
                      [routerLink]="['/events', ref.id]"
                    >
                      {{ ref.label }}
                    </a>
                  } @else {
                    <span style="color: var(--color-text-secondary)">{{ ref.label }}</span>
                  }
                </li>
              }
            </ul>
            <div dialogFooter>
              <button type="button" class="btn btn--ghost" (click)="closeDelete()">
                {{ t('common.close') }}
              </button>
            </div>
          } @else {
            <p>{{ t('comps.delete.confirm') }}</p>
            <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
              {{ current.name }}
            </p>
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
          }
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
  /** Set when a delete attempt was rejected because other rows still reference this comp. */
  protected readonly blockedByRefs = signal<BlockingReference[] | null>(null);
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

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly canManage = computed(() => this.auth.hasPermission('comps.comps.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('comps.comps.delete'));
  protected readonly availableParents = computed(() =>
    this.compSummaries().filter((sibling) => sibling.id !== this.comp()?.id),
  );
  // Keep the current values visible even when the options request is paginated or temporarily
  // unavailable. Native selects otherwise fall back to the first option (usually "No ...").
  protected readonly editCategoryOptions = computed(() => {
    const current = this.comp();
    const categories = this.compCategories();
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
  protected readonly editParentOptions = computed(() => {
    const current = this.comp();
    const parents = this.availableParents();
    const parent = this.parentComp();
    if (!current || !parent || parents.some((candidate) => candidate.id === parent.id)) {
      return parents;
    }
    return [parent, ...parents];
  });
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
      const weapon = this.buildDetails()
        .get(entry.build_id)
        ?.items.find((item) => item.slot === 'weapon');
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
        roleDistribution
          .map(({ role, quantity }) => `${ROLE_LABELS[role]} ${quantity}`)
          .join(' · ') || 'no roles assigned',
      weaponCount: weaponNames.size,
      weaponNames: [...weaponNames].sort((left, right) => left.localeCompare(right)),
      weaponSummary: weaponNames.size === 1 ? 'unique weapon' : 'unique weapons',
      equippedBuildCount,
      equipmentCoverage: `${equippedBuildCount}/${comp?.builds.length ?? 0} builds have a weapon`,
    };
  });

  protected readonly roleColorMap: Record<BuildRole, string> = {
    tank: 'var(--role-tank)',
    healer: 'var(--role-healer)',
    support: 'var(--role-support)',
    dps: 'var(--role-dps)',
    battle_mount: 'var(--role-bm)',
    brawler: 'var(--role-brawler)',
  };

  protected roleColorHex(role: BuildRole): string {
    return this.roleColorMap[role] ?? 'var(--color-primary)';
  }

  protected readonly groupedBuildsByRole = computed(() => {
    const current = this.comp();
    if (!current) return [];
    const groups: { role: BuildRole; totalSlots: number; entries: typeof current.builds }[] = [];
    for (const role of ROLES) {
      const entries = current.builds.filter((b) => b.build.role === role);
      if (entries.length > 0) {
        const totalSlots = entries.reduce((sum, e) => sum + e.quantity, 0);
        groups.push({ role, totalSlots, entries });
      }
    }
    return groups;
  });

  protected formatRolePercent(quantity: number, total: number): number {
    return total > 0 ? Math.round((quantity / total) * 100) : 0;
  }

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

  /** The build's main-loadout weapon, if one is equipped — backs the roster card's weapon icon. */
  private weaponItemFor(buildId: number): BuildItemSlot | undefined {
    return this.buildDetails()
      .get(buildId)
      ?.items.find((item) => item.slot === 'weapon' && (item.loadout ?? 'main') === 'main');
  }

  protected weaponIconFor(buildId: number): string | null {
    return this.weaponItemFor(buildId)?.openalbion_item_icon ?? null;
  }

  protected weaponNameFor(buildId: number): string | null {
    return this.weaponItemFor(buildId)?.openalbion_item_name ?? null;
  }

  /** Hides a weapon icon the CDN cannot render, mirroring the ability bar's own fallback. */
  protected hideBrokenIcon(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
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
        firstValueFrom(this.api.get<CompPerformanceView>(`api/comps/${compId}/performance`)).catch(
          () => null,
        ),
      ]);
      // Discard if the user has since picked a different comparison target.
      if (Number(this.compareWithId()) !== compId) return;
      this.compareWith.set(detail);
      this.comparePerformance.set(performance);
    } catch (error) {
      if (Number(this.compareWithId()) !== compId) return;
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

  /**
   * Options for these selects load asynchronously, so a `[value]` binding on the `<select>` is
   * applied while the list is still empty and the browser silently resets it. Marking the matching
   * `<option>` as selected instead keeps the current value visible once the options arrive.
   */
  protected isSelectedId(selected: string, id: number | null | undefined): boolean {
    return id != null && selected === String(id);
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
    this.newBuildQuantity.set(this.parseQuantity((event.target as HTMLInputElement).value));
  }

  protected onEditingBuildQtyChange(event: Event): void {
    this.editingBuildQty.set(this.parseQuantity((event.target as HTMLInputElement).value));
  }

  /**
   * Parses a stepper input's value into a positive integer quantity.
   *
   * `Number(value) || 1` alone lets a negative number (e.g. "-5") through
   * unchanged, since it's truthy — the native `min="1"` on the input never
   * catches it either because these fields sit outside a `<form>`.
   */
  private parseQuantity(value: string): number {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
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
      existingNames: this.compSummaries().map((summary) => summary.name),
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
      request.parent_id = parentId;
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
      this.toasts.success(this.t('comps.cloneSuccess'));
      await this.router.navigate(['/comps', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected askDeleteComp(): void {
    this.blockedByRefs.set(null);
    this.pendingDelete.set(true);
  }

  protected closeDelete(): void {
    this.pendingDelete.set(false);
    this.blockedByRefs.set(null);
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
      const references = error instanceof ApiError ? error.blockingReferences() : null;
      if (references) {
        // Keep the dialog open — swap it to the "here's what's blocking it" view.
        this.blockedByRefs.set(references);
      } else {
        this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
      }
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
      this.toasts.success(this.t('comps.buildAdded'));
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
      this.toasts.success(this.t('comps.quantityUpdated'));
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
      this.toasts.success(this.t('comps.buildRemoved'));
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
      // Discard if the page has since switched to a different version.
      if (comp.id !== this.compId()) return;
      this.buildDetails.set(
        new Map(
          details
            .filter((detail): detail is BuildDetail => detail !== null)
            .map((detail) => [detail.id, detail]),
        ),
      );
    } finally {
      if (comp.id === this.compId()) {
        this.buildDetailsLoading.set(false);
      }
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
      // Discard if the page has since switched to a different version's comp id.
      if (compId !== this.compId()) return;
      this.comp.set(comp);
      this.performance.set(performance);
      void this.loadBuildDetails(comp);
      if (comp.parent_id) {
        const parent = await firstValueFrom(
          this.api.get<CompSummary>(`api/comps/${comp.parent_id}`),
        ).catch(() => null);
        if (compId !== this.compId()) return;
        this.parentComp.set(parent);
      } else {
        this.parentComp.set(null);
      }
    } catch (error) {
      if (compId !== this.compId()) return;
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      if (compId === this.compId()) {
        this.loading.set(false);
      }
    }
  }
}
