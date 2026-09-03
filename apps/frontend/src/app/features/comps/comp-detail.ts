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
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { itemsForLoadout } from './build-loadouts';
import type { BuildLoadout } from '../../core/models/api.models';
import { abilityKeyForItem, abilitySlotsFor, albionAbilityIconUrl } from '../../shared/data/albion-abilities';
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
    EquipmentGrid,
    ViewToggle,
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
          @if ((canManage() || canDelete()) && mode() === 'view') {
            <span
              class="hidden sm:block w-px h-6 self-center bg-[var(--color-border)]"
              aria-hidden="true"
            ></span>
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
            @if (current.archived_at) {
              <button
                type="button"
                class="btn btn--outline"
                (click)="unarchiveComp()"
                [disabled]="saving()"
              >
                {{ t('comps.unarchive') }}
              </button>
            } @else {
              <button
                type="button"
                class="btn btn--outline"
                (click)="askArchiveComp()"
                [disabled]="saving()"
              >
                {{ t('comps.archive') }}
              </button>
            }
          }
        </div>
      </app-page-header>

      <app-page-stack>
        <!-- At-a-glance KPIs: orients the reader before they dig into the roster or the sidebar. -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <app-stat-card
            [label]="t('comps.totalSlots')"
            [value]="current.total_quantity"
            icon="users"
          />
          <app-stat-card
            [label]="t('comps.builds')"
            [value]="current.builds.length"
            icon="package"
          />
          <app-stat-card
            [label]="t('comps.winrate')"
            [value]="performance() ? formatPercent(performance()!.stats.win_rate) : null"
            [tone]="performance() ? winRateTone(performance()!.stats.win_rate) : 'default'"
            icon="trophy"
          />
          <app-stat-card
            [label]="t('comps.totalBattles')"
            [value]="performance() ? performance()!.stats.total_battles : null"
            icon="swords"
          />
        </div>

        <!-- ================= ROSTER CONTROL & VIEW TOGGLE ================= -->
        <div class="card p-4 border border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <app-view-toggle
              [options]="viewModeOptions()"
              [active]="viewMode()"
              (activeChange)="onViewModeChange($event)"
            />
          </div>

          <div class="flex items-center gap-2">
            @if (canManage()) {
              <button
                type="button"
                class="btn btn--sm"
                [class.btn--primary]="mode() === 'edit'"
                [class.btn--outline]="mode() === 'view'"
                (click)="toggleEditMode()"
                [disabled]="saving()"
              >
                <app-icon [name]="mode() === 'edit' ? 'check' : 'edit'" size="0.75rem" />
                {{ mode() === 'edit' ? 'Termina Modifiche' : 'Modifica Roster' }}
              </button>
              <button
                type="button"
                class="btn btn--sm btn--primary"
                (click)="openAddBuildModal()"
                [disabled]="saving()"
              >
                <app-icon name="plus" size="0.75rem" />
                {{ t('comps.addBuild') }}
              </button>
              <button
                type="button"
                class="btn btn--sm btn--outline"
                (click)="openEditMeta()"
                [disabled]="saving()"
              >
                Info Comp
              </button>
            }
          </div>
        </div>

        <!-- ================= EDIT MODE BANNER ================= -->
        @if (mode() === 'edit') {
          <div class="p-3.5 rounded-[var(--radius-cards)] border border-[var(--color-warning)]/40 bg-[var(--color-warning-container)] flex flex-wrap items-center justify-between gap-3 text-xs">
            <div class="flex items-center gap-2 text-warning">
              <app-icon name="edit" size="1rem" />
              <span><strong>Modalità Modifica Roster:</strong> Regola le quantità dei ruoli tramite i selettori nelle card, rimuovi build o aggiungine di nuove con il pulsante "Aggiungi Build".</span>
            </div>
            <button type="button" class="btn btn--sm btn--primary" (click)="mode.set('view')">
              Fatto
            </button>
          </div>
        }

        <!-- ================= VIEW 1: PARTIES ROSTER ================= -->
        @if (viewMode() === 'parties') {
          <div class="space-y-6">
            @if (partySimulation().length === 0) {
              <app-empty-state icon="package" [message]="t('comps.noBuilds')" />
            } @else {
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
                @for (party of partySimulation(); track party.partyNumber) {
                  <div class="card p-4 border border-[var(--color-border)] space-y-3 bg-[var(--color-surface)]">
                    <!-- Party Card Header -->
                    <div class="flex items-center justify-between gap-2 pb-2 border-b border-[var(--color-border)]">
                      <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full bg-[var(--color-success)]"></span>
                        <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
                          Party {{ party.partyNumber }}
                        </h3>
                      </div>
                      <span class="chip chip--neutral text-[10px] font-mono">
                        {{ party.seats.length }}/5 Posti
                      </span>
                    </div>

                    <!-- 5 Seats List -->
                    <div class="space-y-2">
                      @for (seat of party.seats; track seat.globalIndex) {
                        <div
                          class="p-2 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] border border-[var(--color-border)] flex items-center justify-between gap-2.5 transition-all hover:border-[var(--color-border-strong)] cursor-pointer"
                          (click)="inspectedBuildId.set(seat.buildId)"
                        >
                          <div class="flex items-center gap-2.5 min-w-0">
                            <!-- Seat index indicator -->
                            <span class="font-mono text-[10px] text-disabled w-4 text-center shrink-0">
                              #{{ seat.seatNumber }}
                            </span>

                            <!-- Weapon Icon -->
                            <div
                              class="shrink-0 w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-surface-1)] border border-[var(--color-border)] grid place-items-center overflow-hidden"
                              (mouseenter)="onWeaponMouseEnter(seat.buildId, $event)"
                              (mouseleave)="onWeaponMouseLeave()"
                            >
                              @if (weaponIconFor(seat.buildId); as weaponIcon) {
                                <img
                                  class="w-full h-full object-contain p-0.5"
                                  [src]="weaponIcon"
                                  [alt]="seat.build.name"
                                  loading="lazy"
                                  (error)="hideBrokenIcon($event)"
                                />
                              } @else {
                                <app-icon name="swords" size="0.875rem" color="var(--color-text-secondary)" />
                              }
                            </div>

                            <!-- Build Info -->
                            <div class="min-w-0">
                              <span class="font-bold text-xs text-[var(--color-text)] block truncate hover:text-[var(--color-primary)]">
                                {{ seat.build.name }}
                              </span>
                              <div class="flex items-center gap-1.5 mt-0.5">
                                <span
                                  class="text-[9px] font-bold uppercase px-1.5 py-0.2 rounded"
                                  [style.background-color]="roleBadgeBg(seat.role)"
                                  [style.color]="roleColorHex(seat.role)"
                                >
                                  {{ roleLabel(seat.role) }}
                                </span>
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            class="btn btn--ghost btn--xs text-secondary hover:text-[var(--color-text)] shrink-0"
                            (click)="inspectedBuildId.set(seat.buildId); $event.stopPropagation()"
                          >
                            Ispeziona
                          </button>
                        </div>
                      }
                    </div>
                  </div>
                }
              </div>
            }
          </div>
        }

        <!-- ================= VIEW 2: ROLES MATRIX ================= -->
        @if (viewMode() === 'roles') {
          <div class="space-y-6">
            @if (current.builds.length === 0) {
              <app-empty-state icon="package" [message]="t('comps.noBuilds')" />
            } @else {
              @for (roleGroup of groupedBuildsByRole(); track roleGroup.role) {
                <section class="space-y-3">
                  <!-- Role Group Header -->
                  <div class="flex flex-wrap items-center justify-between gap-2 px-1">
                    <div
                      class="inline-flex items-center gap-1.5 rounded-full px-3 py-1"
                      [style.background-color]="roleBadgeBg(roleGroup.role)"
                    >
                      <span
                        class="w-2 h-2 rounded-full"
                        [style.background-color]="roleColorHex(roleGroup.role)"
                      ></span>
                      <h3
                        class="text-xs font-bold uppercase tracking-wider"
                        [style.color]="roleColorHex(roleGroup.role)"
                      >
                        {{ roleLabel(roleGroup.role) }}
                      </h3>
                      <span
                        class="text-xs font-semibold"
                        [style.color]="roleColorHex(roleGroup.role)"
                      >
                        · {{ roleGroup.totalSlots }} {{ t('comps.slotsShort') }}
                      </span>
                    </div>
                    <span class="text-xs text-secondary">
                      {{ roleGroup.entries.length }} {{ t('comps.buildVariants') }}
                    </span>
                  </div>

                  <!-- Builds Grid for this Role -->
                  <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    @for (entry of roleGroup.entries; track entry.build_id) {
                      <div
                        class="card p-4 border border-[var(--color-border)] flex flex-col justify-between gap-3 transition-all hover:border-[var(--color-border-strong)]"
                        [style.border-left-width]="'4px'"
                        [style.border-left-color]="roleColorHex(entry.build.role)"
                      >
                        <div class="flex items-start justify-between gap-2">
                          <div class="flex items-start gap-2.5 min-w-0">
                            <!-- Weapon Icon -->
                            <div
                              class="shrink-0 w-10 h-10 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] border border-[var(--color-border)] grid place-items-center overflow-hidden cursor-pointer"
                              (mouseenter)="onWeaponMouseEnter(entry.build_id, $event)"
                              (mouseleave)="onWeaponMouseLeave()"
                              (click)="inspectedBuildId.set(entry.build_id)"
                            >
                              @if (weaponIconFor(entry.build_id); as weaponIcon) {
                                <img
                                  class="w-full h-full object-contain p-1"
                                  [src]="weaponIcon"
                                  [alt]="entry.build.name"
                                  loading="lazy"
                                  (error)="hideBrokenIcon($event)"
                                />
                              } @else {
                                <app-icon name="swords" size="1rem" color="var(--color-text-secondary)" />
                              }
                            </div>

                            <div class="min-w-0">
                              <span
                                class="font-bold text-sm text-[var(--color-text)] block truncate hover:text-[var(--color-primary)] cursor-pointer"
                                (click)="inspectedBuildId.set(entry.build_id)"
                              >
                                {{ entry.build.name }}
                              </span>
                              <span class="text-[11px] text-secondary truncate block">
                                {{ entry.build.category_name || t('comps.noCategory') }}
                              </span>
                            </div>
                          </div>

                          <!-- Quantity Stepper / Badge -->
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
                                class="btn btn--primary btn--xs"
                                (click)="saveBuildQty(entry.build_id)"
                                [disabled]="saving()"
                              >
                                ✓
                              </button>
                              <button
                                type="button"
                                class="btn btn--ghost btn--xs"
                                (click)="cancelEditBuild()"
                              >
                                ✕
                              </button>
                            </div>
                          } @else {
                            <div class="flex items-center gap-1.5">
                              <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] font-mono">
                                x{{ entry.quantity }}
                              </span>
                              @if (canManage() && mode() === 'edit') {
                                <button
                                  type="button"
                                  class="btn btn--ghost btn--xs"
                                  (click)="startEditBuild(entry.build_id, entry.quantity)"
                                >
                                  <app-icon name="edit" size="0.75rem" />
                                </button>
                                <button
                                  type="button"
                                  class="btn btn--ghost btn--xs text-error"
                                  (click)="removeBuild(entry.build_id)"
                                  [disabled]="saving()"
                                >
                                  <app-icon name="close" size="0.75rem" />
                                </button>
                              }
                            </div>
                          }
                        </div>

                        <!-- Action Footer -->
                        <div class="flex items-center justify-between gap-2 pt-2 border-t border-[var(--color-border)] text-xs">
                          <button
                            type="button"
                            class="text-xs text-[var(--color-primary)] hover:underline font-medium inline-flex items-center gap-1"
                            (click)="inspectedBuildId.set(entry.build_id)"
                          >
                            <app-icon name="scan" size="0.75rem" />
                            Ispeziona Equip
                          </button>
                          <a
                            class="text-xs text-secondary hover:text-[var(--color-text)]"
                            [routerLink]="['/comps', 'builds', entry.build_id]"
                          >
                            Vai alla build &rarr;
                          </a>
                        </div>
                      </div>
                    }
                  </div>
                </section>
              }
            }
          </div>
        }

        <!-- ================= VIEW 3: ANALYTICS & BLUEPRINT ================= -->
        @if (viewMode() === 'analytics') {
          <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <div class="lg:col-span-6 space-y-6">
              <!-- Blueprint Stats Card -->
              <section class="card p-5 border border-[var(--color-border)] space-y-4">
                <h3 class="text-xs font-bold uppercase tracking-wider text-secondary">
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
                    <div class="flex items-center justify-between p-2.5 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] border border-[var(--color-border)]">
                      <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full" [style.background-color]="roleColorHex(dist.role)"></span>
                        <span class="text-[var(--color-text)] font-medium">{{ roleLabel(dist.role) }}</span>
                      </div>
                      <span class="font-bold text-[var(--color-text)] font-mono">
                        {{ dist.quantity }} ({{ formatRolePercent(dist.quantity, current.total_quantity) }}%)
                      </span>
                    </div>
                  }
                </div>

                @if (compositionStats().weaponNames.length > 0) {
                  <div class="pt-3 border-t border-[var(--color-border)]">
                    <span class="text-xs font-semibold text-secondary block mb-2">
                      {{ t('comps.weaponsInComp') }} ({{ compositionStats().weaponCount }})
                    </span>
                    <div class="flex flex-wrap gap-1.5">
                      @for (wName of compositionStats().weaponNames; track wName) {
                        <span class="chip chip--neutral text-xs">{{ wName }}</span>
                      }
                    </div>
                  </div>
                }
              </section>
            </div>

            <div class="lg:col-span-6 space-y-6">
              <!-- Performance Telemetry Card -->
              @if (performance(); as perf) {
                <section class="card p-5 border border-[var(--color-border)] space-y-4">
                  <h3 class="text-xs font-bold uppercase tracking-wider text-secondary">
                    {{ t('comps.battlePerformance') }}
                  </h3>

                  <div class="grid grid-cols-2 gap-3">
                    <div class="p-3 bg-[var(--color-surface-2)] rounded-[var(--radius-cards)] border border-[var(--color-border)]">
                      <span class="text-[10px] text-disabled block">{{ t('comps.kdRatio') }}</span>
                      <strong class="text-lg font-bold text-[var(--color-text)] font-mono">{{ formatRatio(perf.stats.kill_death_ratio) }}</strong>
                      <span class="text-[10px] text-secondary block mt-0.5">{{ perf.stats.wins }}W - {{ perf.stats.losses }}L</span>
                    </div>
                    <div class="p-3 bg-[var(--color-surface-2)] rounded-[var(--radius-cards)] border border-[var(--color-border)]">
                      <span class="text-[10px] text-disabled block">{{ t('comps.killFame') }}</span>
                      <strong class="text-lg font-bold text-warning font-mono">{{ formatNumber(perf.stats.total_kill_fame) }}</strong>
                      <span class="text-[10px] text-secondary block mt-0.5">{{ perf.stats.total_battles }} battaglie</span>
                    </div>
                  </div>

                  @if (perf.stats.top_opponents.length > 0) {
                    <div class="pt-3 border-t border-[var(--color-border)]">
                      <span class="text-xs font-semibold text-secondary block mb-2">
                        {{ t('comps.topOpponents') }}
                      </span>
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
                                <td class="font-medium text-[var(--color-text)]">{{ opponent.guild_name }}</td>
                                <td class="text-right font-mono">{{ opponent.wins }}-{{ opponent.losses }}</td>
                                <td class="text-right font-mono font-bold" [style.color]="winRateColor(opponentBattlesWinRate(opponent))">
                                  {{ formatPercent(opponentBattlesWinRate(opponent)) }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    </div>
                  }
                </section>
              }
            </div>
          </div>
        }
      </app-page-stack>

      <!-- Quick Build Inspect Modal -->
      @if (inspectedBuild(); as inspected) {
        <app-dialog [title]="inspected.name" size="lg" (closed)="inspectedBuildId.set(null)">
          <div class="space-y-4">
            <div class="flex items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]">
              <div class="flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full" [style.background-color]="roleColorHex(inspected.role)"></span>
                <span class="text-xs font-bold uppercase tracking-wider" [style.color]="roleColorHex(inspected.role)">
                  {{ roleLabel(inspected.role) }}
                </span>
                <span class="text-xs text-secondary">
                  &bull; {{ inspected.category_name || t('comps.noCategory') }}
                </span>
              </div>
              <div class="flex items-center gap-1 bg-[var(--color-surface-2)] p-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)]">
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-[var(--radius-md)] font-medium"
                  [class.bg-[var(--color-surface-hover)]]="inspectedBuildLoadout() === 'main'"
                  [class.text-[var(--color-text)]]="inspectedBuildLoadout() === 'main'"
                  [class.text-secondary]="inspectedBuildLoadout() !== 'main'"
                  (click)="inspectedBuildLoadout.set('main')"
                >
                  Main Set
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-[var(--radius-md)] font-medium"
                  [class.bg-[var(--color-surface-hover)]]="inspectedBuildLoadout() === 'swap'"
                  [class.text-[var(--color-text)]]="inspectedBuildLoadout() === 'swap'"
                  [class.text-secondary]="inspectedBuildLoadout() !== 'swap'"
                  (click)="inspectedBuildLoadout.set('swap')"
                >
                  Swap Set
                </button>
              </div>
            </div>

            <!-- Paperdoll Equipment Grid -->
            <app-equipment-grid
              [items]="inspectedItems()"
              [canManage]="false"
              [editingSlot]="null"
              [draftTier]="'T8'"
              [draftSearch]="''"
              [draftItemId]="''"
              [searchResults]="[]"
              [searchLoading]="false"
              [tiers]="[]"
              [draftAbilitySlots]="[]"
            />

            <!-- Selected Abilities -->
            @if (inspectedAbilityRows().length > 0) {
              <div class="space-y-2 pt-2 border-t border-[var(--color-border)]">
                <span class="text-[10px] font-bold text-disabled uppercase tracking-wider block">Incantesimi Equipaggiati</span>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  @for (row of inspectedAbilityRows(); track row.slot) {
                    <div class="p-2.5 bg-[var(--color-surface-2)] rounded-[var(--radius-md)] border border-[var(--color-border)] flex items-center justify-between gap-2">
                      <span class="text-xs text-[var(--color-text)] font-medium truncate">{{ row.itemName }}</span>
                      <app-ability-bar [slots]="row.slots" [canManage]="false" [emptyLabel]="t('comps.noAbility')" />
                    </div>
                  }
                </div>
              </div>
            }
          </div>

          <div dialogFooter class="flex items-center justify-between w-full">
            <button type="button" class="btn btn--outline btn--sm" (click)="inspectedBuildId.set(null)">
              Chiudi
            </button>
            <a class="btn btn--primary btn--sm" [routerLink]="['/comps', 'builds', inspected.id]" (click)="inspectedBuildId.set(null)">
              Apri Scheda Build Completa &rarr;
            </a>
          </div>
        </app-dialog>
      }

      <!-- Add Build Modal Dialog -->
      @if (addBuildModalOpen()) {
        <app-dialog [title]="t('comps.addBuild')" size="md" (closed)="closeAddBuildModal()">
          <div class="space-y-4">
            <!-- Search & Filters -->
            <div class="space-y-2">
              <input
                type="search"
                class="input input--sm w-full text-xs"
                placeholder="Cerca build per nome o categoria..."
                [value]="newBuildSearch()"
                (input)="onNewBuildSearchChange($event)"
              />
              <div class="flex flex-wrap gap-1">
                <button
                  type="button"
                  class="chip text-[11px]"
                  [class.chip--primary]="addBuildRoleFilter() === 'all'"
                  (click)="addBuildRoleFilter.set('all')"
                >
                  Tutti
                </button>
                @for (role of roles; track role) {
                  <button
                    type="button"
                    class="chip text-[11px]"
                    [class.chip--primary]="addBuildRoleFilter() === role"
                    (click)="addBuildRoleFilter.set(role)"
                  >
                    {{ roleLabel(role) }}
                  </button>
                }
              </div>
            </div>

            <!-- Available Builds List -->
            <div class="max-h-64 overflow-y-auto space-y-1.5 pr-1">
              @for (build of filteredAvailableBuilds(); track build.id) {
                <div
                  class="p-2.5 rounded-[var(--radius-md)] border flex items-center justify-between gap-2.5 transition-all cursor-pointer"
                  [class.border-[var(--color-primary)]]="isSelectedBuild(build.id)"
                  [class.bg-[var(--color-primary)]/10]="isSelectedBuild(build.id)"
                  [class.border-[var(--color-border)]]="!isSelectedBuild(build.id)"
                  [class.bg-[var(--color-surface-2)]]="!isSelectedBuild(build.id)"
                  (click)="selectAddBuild(build)"
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div class="shrink-0 w-8 h-8 rounded bg-[var(--color-surface-1)] border border-[var(--color-border)] grid place-items-center overflow-hidden">
                      @if (weaponIconFor(build.id); as weaponIcon) {
                        <img [src]="weaponIcon" [alt]="build.name" class="w-full h-full object-contain p-0.5" />
                      } @else {
                        <app-icon name="swords" size="0.875rem" color="var(--color-text-secondary)" />
                      }
                    </div>
                    <div class="min-w-0">
                      <span class="text-xs font-bold text-[var(--color-text)] block truncate">{{ build.name }}</span>
                      <span class="text-[10px] text-secondary">{{ build.category_name || t('comps.noCategory') }}</span>
                    </div>
                  </div>
                  <span
                    class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0"
                    [style.background-color]="roleBadgeBg(build.role)"
                    [style.color]="roleColorHex(build.role)"
                  >
                    {{ roleLabel(build.role) }}
                  </span>
                </div>
              } @empty {
                <p class="text-xs text-secondary text-center py-6">Nessuna build disponibile trovata.</p>
              }
            </div>

            <!-- Quantity Selector -->
            @if (newBuildId()) {
              <div class="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] border border-[var(--color-border)]">
                <span class="text-xs font-bold text-[var(--color-text)]">Quantità da inserire:</span>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="btn btn--outline btn--xs w-7 h-7 p-0"
                    [disabled]="newBuildQuantity() <= 1"
                    (click)="newBuildQuantity.set(newBuildQuantity() - 1)"
                  >
                    -
                  </button>
                  <span class="font-mono font-bold text-[var(--color-text)] text-sm w-6 text-center">{{ newBuildQuantity() }}</span>
                  <button
                    type="button"
                    class="btn btn--outline btn--xs w-7 h-7 p-0"
                    (click)="newBuildQuantity.set(newBuildQuantity() + 1)"
                  >
                    +
                  </button>
                </div>
              </div>
            }
          </div>

          <div dialogFooter class="flex justify-end gap-2">
            <button type="button" class="btn btn--ghost btn--sm" (click)="closeAddBuildModal()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              [disabled]="!newBuildId() || saving()"
              (click)="submitAddBuildModal()"
            >
              {{ t('common.add') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- Edit Metadata Modal Dialog -->
      @if (editMetaOpen()) {
        <app-dialog [title]="'Modifica Composizione'" size="md" (closed)="closeEditMeta()">
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
                rows="3"
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

      <!-- Weapon Spell Fixed Tooltip -->
      @if (activeWeaponTooltip(); as tip) {
        <div
          class="fixed z-50 pointer-events-none rounded-[var(--radius-cards)] p-3 border border-[var(--color-border)] shadow-2xl backdrop-blur-md bg-[var(--color-surface-1)] text-xs space-y-2 max-w-[280px]"
          [style.left.px]="tip.x"
          [style.top.px]="tip.y"
        >
          <div class="flex items-center gap-2.5 pb-2 border-b border-[var(--color-border)]">
            @if (tip.icon) {
              <img [src]="tip.icon" [alt]="tip.name" class="w-8 h-8 object-contain rounded bg-[var(--color-surface-2)] p-0.5 border border-[var(--color-border)]" />
            }
            <div class="min-w-0">
              <p class="font-bold text-[var(--color-text)] text-xs truncate">{{ tip.name }}</p>
              <p class="text-[10px] text-secondary truncate">{{ tip.buildName }} &bull; {{ roleLabel(tip.role) }}</p>
            </div>
          </div>
          @if (tip.spells.length > 0) {
            <div class="space-y-1.5">
              <span class="text-[9px] font-bold text-disabled uppercase tracking-wider block">Incantesimi Selezionati</span>
              <div class="space-y-1">
                @for (spell of tip.spells; track spell.key) {
                  <div class="flex items-center gap-2">
                    @if (spell.iconUrl) {
                      <img [src]="spell.iconUrl" [alt]="spell.name" class="w-5 h-5 object-contain rounded bg-[var(--color-surface-2)]" />
                    }
                    <span class="text-[11px] text-[var(--color-text)] font-medium truncate">{{ spell.name }}</span>
                  </div>
                }
              </div>
            </div>
          } @else {
            <p class="text-[10px] text-disabled italic">Nessun incantesimo salvato</p>
          }
        </div>
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
              (click)="confirmArchiveComp()"
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
  protected readonly viewMode = signal<'parties' | 'roles' | 'analytics'>('parties');
  protected readonly viewModeOptions = computed<readonly ViewToggleOption[]>(() => [
    { id: 'parties', label: `Parties Roster (${this.totalPartyCount()} Party)` },
    { id: 'roles', label: `Matrice Ruoli (${this.comp()?.builds.length ?? 0} Build)` },
    { id: 'analytics', label: 'Analisi & Tattica' },
  ]);

  protected readonly editMetaOpen = signal(false);
  protected readonly addBuildModalOpen = signal(false);
  protected readonly addBuildRoleFilter = signal<BuildRole | 'all'>('all');

  protected readonly inspectedBuildId = signal<number | null>(null);
  protected readonly inspectedBuild = computed(() =>
    this.inspectedBuildId() ? this.buildDetails().get(this.inspectedBuildId()!) ?? null : null,
  );
  protected readonly inspectedBuildLoadout = signal<BuildLoadout>('main');
  protected readonly inspectedItems = computed<BuildItemSlot[]>(() => {
    const b = this.inspectedBuild();
    if (!b) return [];
    return itemsForLoadout(b.items, this.inspectedBuildLoadout());
  });
  protected readonly inspectedAbilityRows = computed(() => {
    const b = this.inspectedBuild();
    if (!b) return [];
    const catalog = this.abilityCatalog();
    return this.inspectedItems().flatMap((item) => {
      const key = abilityKeyForItem(item);
      const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells);
      return slots.length === 0
        ? []
        : [{ slot: item.slot, itemName: item.openalbion_item_name, slots }];
    });
  });

  protected readonly activeWeaponTooltip = signal<{
    x: number;
    y: number;
    name: string;
    buildName: string;
    role: BuildRole;
    icon: string | null;
    spells: { key: string; name: string; iconUrl: string }[];
  } | null>(null);

  protected readonly pendingArchive = signal(false);
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

  protected readonly roles: BuildRole[] = ['tank', 'healer', 'support', 'dps', 'brawler', 'battle_mount'];

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

  /** Tinted pill background for a role group header — same hue as {@link roleColorHex}, low opacity. */
  protected roleBadgeBg(role: BuildRole): string {
    return `color-mix(in oklab, ${this.roleColorHex(role)} 16%, transparent)`;
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

  protected readonly filteredAvailableBuilds = computed(() => {
    let list = this.availableBuildOptions();
    const role = this.addBuildRoleFilter();
    if (role !== 'all') {
      list = list.filter((b) => b.role === role);
    }
    const q = this.newBuildSearch().trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) => b.name.toLowerCase().includes(q) || (b.category_name ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  });

  protected readonly partySimulation = computed(() => {
    const comp = this.comp();
    if (!comp || comp.builds.length === 0) return [];

    const allSeats: { buildId: number; build: BuildSummary; role: BuildRole }[] = [];
    for (const entry of comp.builds) {
      for (let i = 0; i < entry.quantity; i++) {
        allSeats.push({
          buildId: entry.build_id,
          build: entry.build,
          role: entry.build.role,
        });
      }
    }

    const rolePriority: Record<BuildRole, number> = {
      tank: 0,
      healer: 1,
      support: 2,
      brawler: 3,
      dps: 4,
      battle_mount: 5,
    };

    allSeats.sort((a, b) => (rolePriority[a.role] ?? 99) - (rolePriority[b.role] ?? 99));

    const partySize = 5;
    const totalParties = Math.max(1, Math.ceil(allSeats.length / partySize));
    const parties: {
      partyNumber: number;
      seats: {
        seatNumber: number;
        globalIndex: number;
        buildId: number;
        build: BuildSummary;
        role: BuildRole;
      }[];
    }[] = [];

    for (let p = 0; p < totalParties; p++) {
      parties.push({ partyNumber: p + 1, seats: [] });
    }

    allSeats.forEach((seat, idx) => {
      const partyIdx = Math.floor(idx / partySize);
      if (parties[partyIdx]) {
        parties[partyIdx].seats.push({
          seatNumber: (idx % partySize) + 1,
          globalIndex: idx + 1,
          buildId: seat.buildId,
          build: seat.build,
          role: seat.role,
        });
      }
    });

    return parties;
  });

  protected readonly totalPartyCount = computed(() => this.partySimulation().length);

  protected onViewModeChange(id: string): void {
    this.viewMode.set(id as 'parties' | 'roles' | 'analytics');
  }

  protected toggleEditMode(): void {
    this.mode.set(this.mode() === 'edit' ? 'view' : 'edit');
    if (this.mode() === 'view') {
      this.cancelEditBuild();
    }
  }

  protected isSelectedBuild(id: number): boolean {
    return this.newBuildId() === String(id);
  }

  protected openEditMeta(): void {
    const current = this.comp();
    if (!current) return;
    this.editName.set(current.name);
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editParentId.set(current.parent_id ? String(current.parent_id) : '');
    this.editDescription.set(current.description ?? '');
    this.editMetaOpen.set(true);
  }

  protected closeEditMeta(): void {
    this.editMetaOpen.set(false);
  }

  protected openAddBuildModal(): void {
    this.newBuildId.set('');
    this.newBuildSearch.set('');
    this.newBuildQuantity.set(1);
    this.addBuildRoleFilter.set('all');
    this.addBuildModalOpen.set(true);
  }

  protected closeAddBuildModal(): void {
    this.addBuildModalOpen.set(false);
  }

  protected selectAddBuild(build: BuildSummary): void {
    this.newBuildId.set(String(build.id));
  }

  protected async submitAddBuildModal(): Promise<void> {
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
      this.closeAddBuildModal();
      this.toasts.success(this.t('comps.buildAdded'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected itemSelectedSpells(item: BuildItemSlot): { key: string; name: string; iconUrl: string }[] {
    const catalog = this.abilityCatalog();
    const key = abilityKeyForItem(item);
    const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells);
    return slots
      .filter((s) => s.selected !== null)
      .map((s) => {
        const choice = s.choices.find((c) => c.id === s.selected);
        return {
          key: `${s.kind}-${s.index}`,
          name: choice?.name ?? s.label,
          iconUrl: s.selected ? albionAbilityIconUrl(s.selected) : '',
        };
      });
  }

  protected onWeaponMouseEnter(buildId: number, event: MouseEvent): void {
    const weapon = this.weaponItemFor(buildId);
    const detail = this.buildDetails().get(buildId);
    if (!weapon || !detail) return;

    const spells = this.itemSelectedSpells(weapon);
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    this.activeWeaponTooltip.set({
      x: Math.min(window.innerWidth - 300, Math.max(10, rect.left - 40)),
      y: rect.bottom + 8,
      name: weapon.openalbion_item_name,
      buildName: detail.name,
      role: detail.role,
      icon: weapon.openalbion_item_icon ?? null,
      spells,
    });
  }

  protected onWeaponMouseLeave(): void {
    this.activeWeaponTooltip.set(null);
  }

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
    this.editMetaOpen.set(false);
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
      this.editMetaOpen.set(false);
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<CompDetail>(`api/comps/${comp.id}`, request));
      this.mode.set('view');
      this.editMetaOpen.set(false);
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

  protected askArchiveComp(): void {
    this.pendingArchive.set(true);
  }

  protected closeArchiveConfirm(): void {
    this.pendingArchive.set(false);
  }

  /**
   * Archives the comp in place — unlike the old hard delete, this never fails on references, so
   * there's no blocking-reference branch to fall back to and no need to leave the page.
   */
  protected async confirmArchiveComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/${comp.id}/archive`, {}));
      this.pendingArchive.set(false);
      this.toasts.success(this.t('comps.archiveSuccess'));
      await this.load(this.compId());
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Unarchiving is always safe — no dialog, one click, back into every picker. */
  protected async unarchiveComp(): Promise<void> {
    const comp = this.comp();
    if (!comp) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/comps/${comp.id}/unarchive`, {}));
      this.toasts.success(this.t('comps.unarchiveSuccess'));
      await this.load(this.compId());
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

  /** Same 60/40 thresholds as {@link winRateColor}, expressed as a `StatCard` tone. */
  protected winRateTone(rate: number): 'success' | 'danger' | 'default' {
    if (rate >= 60) return 'success';
    if (rate < 40) return 'danger';
    return 'default';
  }

  protected winRateColor(rate: number): string {
    switch (this.winRateTone(rate)) {
      case 'success':
        return 'var(--color-success)';
      case 'danger':
        return 'var(--color-danger)';
      default:
        return 'var(--color-text)';
    }
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
