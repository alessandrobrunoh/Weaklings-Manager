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

import { buildNeedsWeapon } from '../../shared/validation/build-validation';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildPerformanceView,
  BuildPriceView,
  BuildRole,
  BuildSlot,
  BuildSummary,
  ItemIpBreakdown,
  ItemPowerView,
  OpenAlbionItemAbilities,
  PaginatedData,
  UpdateBuildRequest,
} from '../../core/models/api.models';
import { albionTierLabel } from '../../shared/data/albion-item-enchantment';
import { DEFAULT_ALBION_ITEM_QUALITY, normalizeAlbionItemQuality } from '../../shared/data/albion-item-quality';
import { SLOT_LABEL_KEYS, SLOT_ORDER, itemsForLoadout } from './build-loadouts';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { VersionSwitcher } from '../../shared/components/version-switcher/version-switcher';
import { VersionDiffList } from '../../shared/components/version-diff-list/version-diff-list';
import {
  LoadoutEditor,
  type LoadoutChange,
} from '../../shared/components/loadout-editor/loadout-editor';
import { LoadoutView } from '../../shared/components/loadout-view/loadout-view';
import { RoleTag, roleLabelKey } from '../../shared/components/role-tag/role-tag';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import {
  DEFAULT_BUILD_DIFF_LABELS,
  abilityNameLookup,
  diffBuildVersions,
  type BuildDiffLabels,
  type VersionDiffEntry,
} from './version-diff';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { canChangeAuthored } from './comp-access';

interface AllianceShareStatus {
  shared: boolean;
  share?: {
    published_id: number;
    shared_at: string;
  };
}

/** One slot of the combined item power and price table. */
interface SlotFigure {
  readonly slot: BuildSlot;
  readonly label: string;
  readonly itemName: string | null;
  readonly tier: string;
  /** Item power of the slot at max spec, or `null` when the figure is not available. */
  readonly itemPower: number | null;
  /** Why the slot has no specialization bonus, when that is worth saying. */
  readonly itemPowerNote: string | null;
  readonly price: number | string | null;
  readonly city: string | null;
}

/** Longest build name the lists lay out without truncating awkwardly. */
const MAX_NAME_LENGTH = 80;

/**
 * Build detail page.
 *
 * Leads with a header (name, version, role, category, author, one primary action and an overflow
 * menu for everything else) and a band of key numbers: item power at max spec, win rate, market
 * price and signups, each shown once. Below it the loadout reads as slot rows with Main and Swap
 * side by side and the chosen spells inline; the item power and price of each slot share one table.
 *
 * Editing is one mode switched on by the header's Edit loadout action. The loadout becomes
 * `app-loadout-editor`: slot rows that open a single slot inspector, one Save and Discard for the
 * whole loadout, and an unsaved-changes count. Save sends every changed slot, one request each, and
 * leaves edit mode; if a request fails the build is reloaded so the draft shows what is left to do.
 *
 * @example
 * ```ts
 * routes.push({ path: 'builds/:buildId', loadComponent: () => import('./comp-build-detail').then(m => m.CompBuildDetailPage) });
 * ```
 */
@Component({
  selector: 'app-comp-build-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Dialog,
    EmptyState,
    EntityHeader,
    ErrorState,
    Icon,
    LoadoutEditor,
    LoadoutView,
    RoleTag,
    VersionDiffList,
    VersionSwitcher,
  ],
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    .bd-stack {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .bd-mono {
      font-family: var(--font-mono);
    }
    .bd-muted {
      color: var(--color-text-secondary);
    }
    .bd-tag {
      display: inline-flex;
      align-items: center;
      min-height: 1.375rem;
      padding: 0 0.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .bd-tag--state {
      border-color: color-mix(in oklab, var(--color-warning) 40%, transparent);
      background: var(--color-warning-container);
      color: var(--color-warning);
    }
    .bd-badges {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .bd-badges:empty {
      display: none;
    }
    .bd-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 1rem;
    }

    /* ---- summary band -------------------------------------------------- */
    .bd-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.875rem 1.5rem;
      margin: 0;
    }
    @media (min-width: 40rem) {
      .bd-stats {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .bd-stat dt {
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .bd-stat dd {
      margin: 0;
    }
    .bd-stat__value {
      font-family: var(--font-mono);
      font-size: 1.25rem;
      font-weight: 500;
      line-height: 1.75rem;
      color: var(--color-text-heading);
    }
    .bd-stat__hint {
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }

    /* ---- panels -------------------------------------------------------- */
    .bd-panel {
      min-width: 0;
      padding: 1rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .bd-panel__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.25rem 1rem;
      margin: 0 0 0.75rem;
    }
    .bd-panel__title {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .bd-panel__note {
      margin: 0;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .bd-notice {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid color-mix(in oklab, var(--color-warning) 40%, transparent);
      border-radius: var(--radius-md);
      background: var(--color-warning-container);
      font-size: 0.8125rem;
    }
    .bd-cols {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
    @media (min-width: 64rem) {
      .bd-cols--two {
        grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
      }
    }

    /* ---- slot table ---------------------------------------------------- */
    .bd-table-scroll {
      overflow-x: auto;
    }
    .bd-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    .bd-table th,
    .bd-table td {
      padding: 0.375rem 0.5rem;
      border-top: 1px solid var(--color-border);
      text-align: start;
      vertical-align: top;
    }
    .bd-table thead th {
      border-top: 0;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .bd-table tfoot th,
    .bd-table tfoot td {
      border-top: 1px solid var(--color-border-strong);
      font-weight: 600;
    }
    .bd-table .bd-num {
      text-align: end;
      white-space: nowrap;
      font-family: var(--font-mono);
    }
    .bd-table thead th.bd-num {
      font-family: inherit;
    }
    .bd-cell__sub {
      display: block;
      font-family: var(--font-sans);
      font-size: 0.75rem;
      font-weight: 400;
      line-height: 1rem;
      color: var(--color-text-secondary);
      white-space: normal;
    }
    .bd-cell__item {
      display: block;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }

    /* ---- battle performance ------------------------------------------- */
    .bd-facts {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0.5rem 1rem;
      margin: 0;
      font-size: 0.875rem;
    }
    .bd-facts dt {
      color: var(--color-text-secondary);
    }
    .bd-facts dd {
      margin: 0;
      font-family: var(--font-mono);
      text-align: end;
    }

    /* ---- skeleton ------------------------------------------------------ */
    .bd-skel__bar,
    .bd-skel__cell,
    .bd-skel__row,
    .bd-skel-inline {
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
    }
    .bd-skel__bar--title {
      width: min(18rem, 70%);
      height: 1.75rem;
    }
    .bd-skel__bar--meta {
      width: min(26rem, 90%);
      height: 1rem;
      margin-block-start: 0.625rem;
    }
    .bd-skel__stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem;
      margin-block: 1.25rem;
    }
    @media (min-width: 40rem) {
      .bd-skel__stats {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .bd-skel__cell {
      height: 3.25rem;
    }
    .bd-skel__row {
      height: 2.75rem;
      margin-block-start: 0.5rem;
    }
    .bd-skel-inline {
      display: inline-block;
      width: 4rem;
      height: 1.25rem;
      vertical-align: middle;
    }
    @media (prefers-reduced-motion: no-preference) {
      .bd-skel__bar,
      .bd-skel__cell,
      .bd-skel__row,
      .bd-skel-inline {
        animation: bd-pulse 1.4s ease-in-out infinite;
      }
    }
    @keyframes bd-pulse {
      50% {
        opacity: 0.5;
      }
    }
  `,
  template: `
    @if (loading()) {
      <div role="status" aria-busy="true">
        <span class="sr-only">{{ t('common.loading') }}</span>
        <div aria-hidden="true">
          <div class="bd-skel__bar bd-skel__bar--title"></div>
          <div class="bd-skel__bar bd-skel__bar--meta"></div>
          <div class="bd-skel__stats">
            <div class="bd-skel__cell"></div>
            <div class="bd-skel__cell"></div>
            <div class="bd-skel__cell"></div>
            <div class="bd-skel__cell"></div>
          </div>
          <div class="bd-skel__row"></div>
          <div class="bd-skel__row"></div>
          <div class="bd-skel__row"></div>
          <div class="bd-skel__row"></div>
          <div class="bd-skel__row"></div>
        </div>
      </div>
    } @else if (build(); as current) {
      <app-entity-header
        [title]="current.name"
        [description]="current.description"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <span entityBadges class="bd-badges">
          @if (current.archived_at) {
            <span class="bd-tag bd-tag--state">{{ t('comps.archived') }}</span>
          }
          @if (isGuildTenant() && shareStatus()?.shared) {
            <span class="bd-tag">{{ t('comps.sharedWithAlliance') }}</span>
          }
        </span>

        <div entityMeta class="bd-meta">
          @if ((current.versions ?? []).length > 1) {
            <app-version-switcher
              [versions]="current.versions ?? []"
              [currentId]="current.id"
              [busy]="saving()"
              [label]="t('comps.version')"
              [compact]="true"
              (select)="openVersion($event)"
            />
          } @else {
            <span class="bd-mono">v{{ current.version }}</span>
          }
          <app-role-tag [role]="current.role" />
          <span>{{ current.category_name || t('comps.noCategory') }}</span>
          <span>{{ t('buildDetail.byAuthor', { name: current.created_by_username }) }}</span>
          <span>{{ t('buildDetail.updatedOn', { date: formatDate(current.updated_at) }) }}</span>
        </div>

        @if (canManage() && !editing()) {
          <button
            entityPrimary
            type="button"
            class="btn btn--primary"
            [disabled]="saving()"
            (click)="startEdit()"
          >
            <app-icon name="edit" size="1rem" />
            {{ t('buildDetail.action.edit') }}
          </button>
        }

        <div entitySummary>
          <dl class="bd-stats">
            <div class="bd-stat">
              <dt>{{ t('buildDetail.stat.itemPower') }}</dt>
              <dd class="bd-stat__value">
                @if (metricsLoading()) {
                  <span class="bd-skel-inline" aria-hidden="true"></span>
                  <span class="sr-only">{{ t('common.loading') }}</span>
                } @else {
                  {{ itemPowerText() }}
                }
              </dd>
              @if (!metricsLoading() && itemPowerHint(); as hint) {
                <dd class="bd-stat__hint">{{ hint }}</dd>
              }
            </div>
            <div class="bd-stat">
              <dt>{{ t('comps.winrate') }}</dt>
              <dd class="bd-stat__value">
                @if (metricsLoading()) {
                  <span class="bd-skel-inline" aria-hidden="true"></span>
                  <span class="sr-only">{{ t('common.loading') }}</span>
                } @else {
                  {{ winRateText() }}
                }
              </dd>
              @if (!metricsLoading()) {
                <dd class="bd-stat__hint">{{ winRateHint() }}</dd>
              }
            </div>
            <div class="bd-stat">
              <dt>{{ t('buildDetail.stat.price') }}</dt>
              <dd class="bd-stat__value">
                @if (metricsLoading()) {
                  <span class="bd-skel-inline" aria-hidden="true"></span>
                  <span class="sr-only">{{ t('common.loading') }}</span>
                } @else {
                  {{ priceText() }}
                }
              </dd>
              @if (!metricsLoading() && marketPrice()) {
                <dd class="bd-stat__hint">{{ t('buildDetail.stat.priceHint') }}</dd>
              }
            </div>
            <div class="bd-stat">
              <dt>{{ t('buildDetail.stat.signups') }}</dt>
              <dd class="bd-stat__value">
                @if (metricsLoading()) {
                  <span class="bd-skel-inline" aria-hidden="true"></span>
                  <span class="sr-only">{{ t('common.loading') }}</span>
                } @else {
                  {{ signupsText() }}
                }
              </dd>
              @if (!metricsLoading() && signupsHint(); as hint) {
                <dd class="bd-stat__hint">{{ hint }}</dd>
              }
            </div>
          </dl>
        </div>
      </app-entity-header>

      <div class="bd-stack">
        @if (missingWeapon()) {
          <div class="bd-notice" role="status">
            <app-icon name="alert" size="1rem" />
            <span>{{ t('comps.weaponMissingWarning') }}</span>
          </div>
        }

        <!-- ================= LOADOUT ================= -->
        <section class="bd-panel" aria-labelledby="bd-loadout-title">
          <div class="bd-panel__head">
            <h2 class="bd-panel__title" id="bd-loadout-title">{{ t('buildDetail.loadout.title') }}</h2>
            @if (editing()) {
              <p class="bd-panel__note">{{ t('buildDetail.edit.hint') }}</p>
            }
          </div>
          @if (editing()) {
            <app-loadout-editor
              [items]="current.items"
              [saving]="saving()"
              (save)="saveLoadout($event)"
              (discard)="requestDiscard()"
              (dirtyChange)="dirty.set($event)"
            />
          } @else {
            <app-loadout-view [items]="current.items" />
          }
        </section>

        <div class="bd-cols" [class.bd-cols--two]="!!performance()?.stats">
          <!-- ================= ITEM POWER AND PRICE ================= -->
          <section class="bd-panel" aria-labelledby="bd-slots-title">
            <div class="bd-panel__head">
              <h2 class="bd-panel__title" id="bd-slots-title">{{ t('buildDetail.slots.title') }}</h2>
            </div>
            @if (metricsLoading()) {
              <div role="status" aria-busy="true">
                <span class="sr-only">{{ t('common.loading') }}</span>
                <div class="bd-skel__row" aria-hidden="true"></div>
                <div class="bd-skel__row" aria-hidden="true"></div>
                <div class="bd-skel__row" aria-hidden="true"></div>
              </div>
            } @else if (slotFigures().length === 0) {
              <p class="bd-panel__note">{{ t('buildDetail.slots.unavailable') }}</p>
            } @else {
              @if (itemPowerAtMax(); as ip) {
                @if (ip.breakdown.mastery_levels_known === false) {
                  <p class="bd-panel__note" role="note">{{ t('buildDetail.slots.lowerBound') }}</p>
                }
              }
              <div class="bd-table-scroll">
                <table class="bd-table">
                  <caption class="sr-only">{{ t('buildDetail.slots.caption') }}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{{ t('buildDetail.slots.col.slot') }}</th>
                      <th scope="col" class="bd-num">{{ t('buildDetail.slots.col.itemPower') }}</th>
                      <th scope="col" class="bd-num">{{ t('buildDetail.slots.col.price') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of slotFigures(); track row.slot) {
                      <tr>
                        <th scope="row">
                          {{ row.label }}
                          <span class="bd-cell__item">
                            {{ row.itemName ?? t('loadoutEditor.row.empty') }}
                            @if (row.tier) {
                              <span class="bd-mono">{{ row.tier }}</span>
                            }
                          </span>
                        </th>
                        <td class="bd-num">
                          {{ row.itemPower === null ? '—' : formatNumber(row.itemPower) }}
                          @if (row.itemPowerNote) {
                            <span class="bd-cell__sub">{{ row.itemPowerNote }}</span>
                          }
                        </td>
                        <td class="bd-num">
                          {{ row.price === null ? '—' : formatSilver(row.price) }}
                          @if (row.city) {
                            <span class="bd-cell__sub">{{ row.city }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">{{ t('buildDetail.slots.wholeSet') }}</th>
                      <td class="bd-num">
                        {{ itemPowerAtMax() ? formatNumber(itemPowerAtMax()!.breakdown.average) : '—' }}
                        <span class="bd-cell__sub">{{ t('buildDetail.slots.average') }}</span>
                      </td>
                      <td class="bd-num">
                        {{ marketPrice() ? formatSilver(marketPrice()!.total) : '—' }}
                        <span class="bd-cell__sub">{{ t('buildDetail.slots.total') }}</span>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              @if (!itemPowerAtMax()) {
                <p class="bd-panel__note">{{ t('buildDetail.slots.itemPowerUnavailable') }}</p>
              } @else if (emptySlotCount() > 0) {
                <p class="bd-panel__note">
                  {{ t('buildDetail.slots.emptyNote', { count: emptySlotCount() }) }}
                </p>
              }
              @if (!marketPrice()) {
                <p class="bd-panel__note">{{ t('comps.price.unavailable') }}</p>
              }
            }
          </section>

          <!-- ================= BATTLE PERFORMANCE ================= -->
          @if (performance()?.stats; as stats) {
            <section class="bd-panel" aria-labelledby="bd-perf-title">
              <div class="bd-panel__head">
                <h2 class="bd-panel__title" id="bd-perf-title">{{ t('buildDetail.performance.title') }}</h2>
              </div>
              <dl class="bd-facts">
                <dt>{{ t('buildDetail.performance.battles') }}</dt>
                <dd>{{ formatNumber(stats.battles) }}</dd>
                <dt>{{ t('buildDetail.performance.players') }}</dt>
                <dd>{{ formatNumber(stats.matched_players) }}</dd>
                <dt>{{ t('buildDetail.performance.killsDeaths') }}</dt>
                <dd>{{ formatNumber(stats.kills) }} / {{ formatNumber(stats.deaths) }}</dd>
                <dt>{{ t('buildDetail.performance.kd') }}</dt>
                <dd>{{ kdRatioText() }}</dd>
                <dt>{{ t('buildDetail.performance.killFame') }}</dt>
                <dd>{{ formatNumber(stats.kill_fame) }}</dd>
              </dl>
            </section>
          }
        </div>
      </div>

      <!-- ================= EDIT DETAILS ================= -->
      @if (editMetaOpen()) {
        <app-dialog [title]="t('comps.editBuildDetails')" size="md" (closed)="closeEditMeta()">
          <form class="grid gap-4" (submit)="saveEdit($event)">
            <p class="text-xs text-secondary">{{ t('validation.requiredLegend') }}</p>
            <div class="grid gap-4 md:grid-cols-2">
              <label>
                <span class="label">{{ t('common.name') }} <span class="text-error" aria-hidden="true">*</span></span>
                <input
                  class="input"
                  type="text"
                  required
                  [attr.aria-invalid]="nameError() ? 'true' : null"
                  [attr.aria-describedby]="nameError() ? 'bd-name-error' : null"
                  [value]="editName()"
                  (input)="onEditNameChange($event)"
                />
                @if (nameError(); as message) {
                  <span id="bd-name-error" class="text-xs text-error" role="alert">{{ message }}</span>
                }
              </label>
              <label>
                <span class="label">{{ t('common.category') }} <span class="text-error" aria-hidden="true">*</span></span>
                <select class="select" required (change)="onEditCategoryChange($event)">
                  @for (category of editCategoryOptions(); track category.id) {
                    <option [value]="category.id" [selected]="'' + category.id === editCategoryId()">
                      {{ category.name }}
                    </option>
                  }
                </select>
                <span class="text-xs text-secondary">{{ t('comps.categoryRequired') }}</span>
              </label>
            </div>
            <label>
              <span class="label">{{ t('common.role') }}</span>
              <select class="select" (change)="onEditRoleChange($event)">
                @for (role of roles; track role) {
                  <option [value]="role" [selected]="role === editRole()">{{ roleLabel(role) }}</option>
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

      <!-- ================= COMPARE VERSIONS ================= -->
      @if (comparing()) {
        <app-dialog [title]="t('comps.compare')" size="lg" (closed)="closeCompare()">
          <div class="grid gap-4">
            <label>
              <span class="label">{{ t('comps.compareWith') }}</span>
              <select class="select" (change)="onCompareTargetChange($event)">
                @for (entry of current.versions ?? []; track entry.id) {
                  @if (entry.id !== current.id) {
                    <option [value]="entry.id" [selected]="compareWithId() === '' + entry.id">
                      v{{ entry.version }}
                    </option>
                  }
                }
              </select>
            </label>

            @if (comparison(); as pair) {
              <p class="text-sm bd-muted">
                {{ t('compDetail.compare.direction', { from: 'v' + pair.before.version, to: 'v' + pair.after.version }) }}
              </p>
              <div class="grid gap-3 sm:grid-cols-2">
                <section class="bd-panel">
                  <h3 class="text-sm font-semibold">{{ t('compDetail.compare.older', { version: pair.before.version }) }}</h3>
                  <p class="text-sm bd-muted mt-1">{{ performanceSummary(pair.beforePerformance) }}</p>
                </section>
                <section class="bd-panel">
                  <h3 class="text-sm font-semibold">{{ t('compDetail.compare.newer', { version: pair.after.version }) }}</h3>
                  <p class="text-sm bd-muted mt-1">{{ performanceSummary(pair.afterPerformance) }}</p>
                </section>
              </div>

              <app-version-diff-list
                [entries]="compareDiff()"
                [emptyLabel]="t('comps.noDifferences')"
                [subjectLabel]="t('versionDiff.what')"
                [beforeLabel]="'v' + pair.before.version"
                [afterLabel]="'v' + pair.after.version"
                [changeLabel]="t('versionDiff.change')"
                [noneLabel]="t('versionDiff.none')"
                [addedLabel]="t('comps.added')"
                [removedLabel]="t('comps.removed')"
                [changedLabel]="t('comps.changed')"
              />
            } @else if (compareLoading()) {
              <p class="text-sm bd-muted" role="status">{{ t('common.loading') }}</p>
            }
          </div>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="closeCompare()">
              {{ t('common.close') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- ================= DISCARD CONFIRM ================= -->
      @if (pendingDiscard()) {
        <app-dialog [title]="t('buildDetail.discard.title')" size="sm" (closed)="keepEditing()">
          <p>{{ t('buildDetail.discard.message', { count: dirty() }) }}</p>
          <div dialogFooter>
            <button type="button" class="btn btn--ghost" (click)="keepEditing()">
              {{ t('buildDetail.discard.keep') }}
            </button>
            <button type="button" class="btn btn--tonal" (click)="confirmDiscard()">
              {{ t('buildDetail.discard.confirm') }}
            </button>
          </div>
        </app-dialog>
      }

      <!-- ================= ARCHIVE CONFIRM ================= -->
      @if (pendingArchive()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeArchiveConfirm()">
          <p>{{ t('comps.archiveConfirm') }}</p>
          <p class="mt-2 text-sm bd-muted">{{ current.name }}</p>
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
    } @else if (notFound()) {
      <app-empty-state
        icon="package"
        [message]="t('comps.buildNotFound')"
        [hint]="t('buildDetail.notFound.hint')"
      >
        <a class="btn btn--outline btn--sm" routerLink="/builds">
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('buildDetail.notFound.back') }}
        </a>
      </app-empty-state>
    } @else {
      <app-error-state
        [message]="t('common.error')"
        [hint]="t('buildDetail.error.load')"
        [retryLabel]="t('common.retry')"
        (retry)="load(buildId())"
      />
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
  private readonly albionAbilities = inject(AlbionAbilitiesService);
  private readonly destroyRef = inject(DestroyRef);

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
  protected readonly notFound = signal(false);
  protected readonly saving = signal(false);
  protected readonly build = signal<BuildDetail | null>(null);
  /** The key numbers (item power, win rate, price, signups) are still being fetched. */
  protected readonly metricsLoading = signal(true);
  /** A non-mount build without a main-hand weapon in its main loadout cannot be saved. */
  protected readonly missingWeapon = computed(() => {
    const current = this.build();
    return current !== null && buildNeedsWeapon(current.role) && !current.weapon_key;
  });
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
        name: current.category_name ?? `${this.t('common.category')} #${current.category_id}`,
      },
      ...categories,
    ];
  });

  /** True while the loadout editor is open. */
  protected readonly editing = signal(false);
  /** Slots the editor reports as different from the saved loadout. */
  protected readonly dirty = signal(0);
  /** Set while the discard dialog is up: what to do once the user confirms. */
  protected readonly pendingDiscard = signal(false);
  private discardAction: (() => void) | null = null;
  protected readonly editMetaOpen = signal(false);

  protected readonly pendingArchive = signal(false);
  protected readonly editName = signal('');
  protected readonly editDescription = signal('');
  protected readonly editCategoryId = signal('');
  protected readonly nameError = signal<string | null>(null);
  /** Existing build names, fetched lazily so a rename can be checked for duplicates. */
  protected readonly existingBuildNames = signal<string[]>([]);
  protected readonly editRole = signal('');

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /** Edit and delete apply to builds the caller authored; `comps.builds.manage` covers anyone's. */
  private canChange(own: string): boolean {
    return canChangeAuthored(
      this.build(),
      this.auth.profile()?.user_id,
      this.auth.hasPermission(own),
      this.auth.hasPermission('comps.builds.manage'),
    );
  }

  protected readonly canManage = computed(() => this.canChange('comps.builds.edit'));
  protected readonly canDelete = computed(() => this.canChange('comps.builds.delete'));
  /** A new version joins its author's group, so it follows the same author-or-manage rule. */
  protected readonly canVersion = computed(() => this.canChange('comps.builds.create'));
  protected readonly isGuildTenant = computed(
    () => this.auth.profile()?.tenant_kind !== 'alliance',
  );
  protected readonly canShare = computed(
    () => this.isGuildTenant() && this.auth.hasPermission('alliance.share'),
  );
  protected readonly shareStatus = signal<AllianceShareStatus | null>(null);
  /** The bundled ability catalog, loaded once, so the version diff can name spells. */
  protected readonly abilityCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});
  protected readonly performance = signal<BuildPerformanceView | null>(null);
  /**
   * This build's Item Power with every specialization node at 100 — the ceiling every member is
   * measured against, not any one person's actual figure. `null` while loading or on failure.
   */
  protected readonly itemPowerAtMax = signal<ItemPowerView | null>(null);
  /** The build's total market price, priced live from Albion Online Data. `null` while loading
   * or when pricing failed (e.g. the market API is unreachable) — the page degrades quietly. */
  protected readonly marketPrice = signal<BuildPriceView | null>(null);

  protected readonly comparing = signal(false);
  protected readonly compareLoading = signal(false);
  protected readonly compareWithId = signal('');
  protected readonly compareWith = signal<BuildDetail | null>(null);
  protected readonly comparePerformance = signal<BuildPerformanceView | null>(null);

  /** The pair being compared, oldest first, so the diff always reads older to newer. */
  protected readonly comparison = computed(() => {
    const current = this.build();
    const other = this.compareWith();
    if (!current || !other) {
      return null;
    }
    return other.version < current.version
      ? {
          before: other,
          after: current,
          beforePerformance: this.comparePerformance(),
          afterPerformance: this.performance(),
        }
      : {
          before: current,
          after: other,
          beforePerformance: this.performance(),
          afterPerformance: this.comparePerformance(),
        };
  });

  protected readonly compareDiff = computed<VersionDiffEntry[]>(() => {
    const pair = this.comparison();
    return pair
      ? diffBuildVersions(
          pair.before,
          pair.after,
          abilityNameLookup(this.abilityCatalog()),
          this.diffLabels(),
        )
      : [];
  });

  /** The words the diff uses, in the active language. */
  private readonly diffLabels = computed<BuildDiffLabels>(() => {
    const slot = { ...DEFAULT_BUILD_DIFF_LABELS.slot };
    for (const key of SLOT_ORDER) {
      slot[key] = this.t(SLOT_LABEL_KEYS[key]);
    }
    return {
      loadout: { main: this.t('loadout.main'), swap: this.t('loadout.swap') },
      slot,
      passive: this.t('loadout.passive'),
      item: this.t('versionDiff.item'),
      quality: (quality) => this.t(`loadout.quality.${normalizeAlbionItemQuality(quality)}` as TranslationKey),
    };
  });

  protected readonly menuItems = computed<EntityMenuItem[]>(() => {
    const current = this.build();
    if (!current) {
      return [];
    }
    const disabled = this.saving();
    const items: EntityMenuItem[] = [];
    if (this.canManage()) {
      items.push({ id: 'editDetails', label: this.t('buildDetail.action.editDetails'), disabled });
    }
    if ((current.versions ?? []).length > 1) {
      items.push({ id: 'compare', label: this.t('buildDetail.action.compareVersions') });
    }
    if (this.canVersion()) {
      items.push({ id: 'newVersion', label: this.t('comps.newVersion'), disabled });
    }
    if (this.canShare()) {
      items.push(
        this.shareStatus()?.shared
          ? { id: 'unshare', label: this.t('comps.unshareWithAlliance'), disabled }
          : { id: 'share', label: this.t('comps.shareWithAlliance'), disabled },
      );
    }
    if (this.canDelete()) {
      items.push(
        current.archived_at
          ? { id: 'unarchive', label: this.t('comps.unarchive'), disabled, separatorBefore: true }
          : {
              id: 'archive',
              label: this.t('comps.archive'),
              disabled,
              danger: true,
              separatorBefore: true,
            },
      );
    }
    return items;
  });

  // ---- key numbers ------------------------------------------------------------------------

  protected readonly itemPowerText = computed(() => {
    const view = this.itemPowerAtMax();
    return view ? this.formatNumber(view.breakdown.average) : '—';
  });

  protected readonly itemPowerHint = computed(() => {
    const view = this.itemPowerAtMax();
    if (!view) {
      return this.t('compDetail.perf.unavailableShort');
    }
    return view.breakdown.mastery_levels_known === false
      ? this.t('buildDetail.stat.itemPowerHint')
      : null;
  });

  protected readonly winRateText = computed(() => {
    const stats = this.performance()?.stats;
    return stats ? this.winRate(stats.wins, stats.losses) : '—';
  });

  protected readonly winRateHint = computed(() => {
    const report = this.performance();
    if (!report) {
      return this.t('compDetail.perf.unavailableShort');
    }
    return report.stats
      ? this.t('compDetail.stat.record', { wins: report.stats.wins, losses: report.stats.losses })
      : this.t('compDetail.perf.noBattles');
  });

  protected readonly priceText = computed(() => {
    const price = this.marketPrice();
    return price ? this.formatSilver(price.total) : '—';
  });

  protected readonly signupsText = computed(() => {
    const report = this.performance();
    return report ? this.formatNumber(this.totalSignups()) : '—';
  });

  protected readonly signupsHint = computed(() => {
    const report = this.performance();
    return report
      ? this.t('buildDetail.stat.signupsHint', {
          primary: report.signups_as_primary,
          secondary: report.signups_as_secondary,
        })
      : this.t('compDetail.perf.unavailableShort');
  });

  private readonly totalSignups = computed(() => {
    const report = this.performance();
    return (report?.signups_as_primary ?? 0) + (report?.signups_as_secondary ?? 0);
  });

  protected readonly kdRatioText = computed(() => {
    const stats = this.performance()?.stats;
    if (!stats) {
      return '—';
    }
    return stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : String(stats.kills);
  });

  /** One row per slot of the main loadout, with its item power and price side by side. */
  protected readonly slotFigures = computed<SlotFigure[]>(() => {
    const current = this.build();
    if (!current) {
      return [];
    }
    const main = new Map(itemsForLoadout(current.items ?? [], 'main').map((item) => [item.slot, item]));
    const power = new Map<BuildSlot, ItemIpBreakdown>(
      (this.itemPowerAtMax()?.breakdown.items ?? []).map((row) => [row.slot, row]),
    );
    const price = new Map((this.marketPrice()?.items ?? []).map((row) => [row.slot, row]));
    return SLOT_ORDER.flatMap((slot) => {
      const item = main.get(slot);
      const powerRow = power.get(slot);
      const priceRow = price.get(slot);
      if (!item && !powerRow && !priceRow) {
        return [];
      }
      return [
        {
          slot,
          label: this.t(SLOT_LABEL_KEYS[slot]),
          itemName: item?.openalbion_item_name ?? priceRow?.openalbion_item_name ?? null,
          tier: powerRow
            ? this.ipTierLabel(powerRow)
            : item
              ? albionTierLabel(item.openalbion_item_tier, item.openalbion_item_enchantment)
              : '',
          itemPower: powerRow ? Math.round(powerRow.total) : null,
          itemPowerNote: powerRow?.unknown_item
            ? this.t('buildDetail.slots.unknownItem')
            : powerRow && !powerRow.spec_node
              ? this.t('buildDetail.slots.noSpec')
              : null,
          price: priceRow ? priceRow.unit_price : null,
          city: priceRow?.city ?? null,
        },
      ];
    });
  });

  protected readonly emptySlotCount = computed(
    () => this.itemPowerAtMax()?.breakdown.empty_slots.length ?? 0,
  );

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
      this.resetForNewBuild();
      void this.load(id);
    });
    // Static application data; one fetch serves every build page in the session.
    void this.albionAbilities
      .load()
      .then((abilities) => this.abilityCatalog.set(abilities))
      .catch(() => this.abilityCatalog.set({}));

    this.destroyRef.onDestroy(() => (this.discardAction = null));
  }

  private resetForNewBuild(): void {
    this.editing.set(false);
    this.dirty.set(0);
    this.pendingDiscard.set(false);
    this.discardAction = null;
    this.comparing.set(false);
    this.editMetaOpen.set(false);
  }

  protected roleLabel(role: BuildRole): string {
    return this.t(roleLabelKey(role));
  }

  // ===========================================================================
  // Header
  // ===========================================================================

  protected onMenu(id: string): void {
    switch (id) {
      case 'editDetails':
        this.openEditMeta();
        break;
      case 'compare':
        this.openCompare();
        break;
      case 'newVersion':
        this.guardUnsaved(() => void this.createVersion());
        break;
      case 'share':
        void this.shareWithAlliance();
        break;
      case 'unshare':
        void this.unshareWithAlliance();
        break;
      case 'archive':
        this.pendingArchive.set(true);
        break;
      case 'unarchive':
        void this.unarchiveBuild();
        break;
    }
  }

  // ===========================================================================
  // Loadout editing
  // ===========================================================================

  protected startEdit(): void {
    if (!this.canManage() || this.saving()) {
      return;
    }
    this.dirty.set(0);
    this.editing.set(true);
    void this.loadExistingBuildNames();
  }

  private exitEdit(): void {
    this.editing.set(false);
    this.dirty.set(0);
  }

  /** Discard from the editor: leave at once when nothing changed, otherwise ask first. */
  protected requestDiscard(): void {
    this.guardUnsaved(() => this.exitEdit());
  }

  /** Runs `action` now, or after the user confirms losing the unsaved loadout changes. */
  private guardUnsaved(action: () => void): void {
    if (this.editing() && this.dirty() > 0) {
      this.discardAction = action;
      this.pendingDiscard.set(true);
      return;
    }
    action();
  }

  protected keepEditing(): void {
    this.discardAction = null;
    this.pendingDiscard.set(false);
  }

  protected confirmDiscard(): void {
    const action = this.discardAction;
    this.discardAction = null;
    this.pendingDiscard.set(false);
    this.exitEdit();
    action?.();
  }

  /** Closing the tab or reloading with unsaved loadout changes asks the browser to confirm. */
  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.editing() && this.dirty() > 0) {
      event.preventDefault();
    }
  }

  /**
   * Saves every changed slot, one request each, then leaves edit mode.
   *
   * The requests run in order and stop at the first failure. The build is then reloaded so the
   * editor's unsaved count shows only what has still to be done, and the editor stays open.
   */
  protected async saveLoadout(changes: readonly LoadoutChange[]): Promise<void> {
    const build = this.build();
    if (!build || changes.length === 0 || this.saving()) {
      return;
    }
    // The server refuses a build without a main-hand weapon (battle mounts excepted), so say so
    // before sending anything instead of leaving half the changes applied.
    if (buildNeedsWeapon(build.role) && !this.hasMainWeaponAfter(build, changes)) {
      this.toasts.error(this.t('comps.weaponRequired'));
      return;
    }
    this.saving.set(true);
    try {
      for (const change of changes) {
        await this.applyChange(build.id, change);
      }
      this.build.set(await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${build.id}`)));
      this.exitEdit();
      this.toasts.success(this.t('buildDetail.toast.loadoutSaved'));
      void this.loadMetrics(build.id);
    } catch {
      this.toasts.error(this.t('buildDetail.error.save'));
      try {
        this.build.set(
          await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${build.id}`)),
        );
      } catch {
        // The error toast above already told the user; the editor keeps their draft.
      }
    } finally {
      this.saving.set(false);
    }
  }

  private hasMainWeaponAfter(build: BuildDetail, changes: readonly LoadoutChange[]): boolean {
    const change = changes.find((entry) => entry.loadout === 'main' && entry.slot === 'weapon');
    if (change) {
      return change.item !== null;
    }
    return itemsForLoadout(build.items ?? [], 'main').some((item) => item.slot === 'weapon');
  }

  private async applyChange(buildId: number, change: LoadoutChange): Promise<void> {
    const url = `api/comps/builds/${buildId}/items/${change.slot}?loadout=${change.loadout}`;
    const item = change.item;
    if (!item) {
      await firstValueFrom(this.api.delete(url));
      return;
    }
    // The abilities always travel with the item so the server stores both or neither; sending an
    // empty selection clears what the slot had instead of keeping spells the draft removed.
    await firstValueFrom(
      this.api.put<BuildDetail>(url, {
        openalbion_item_type: item.openalbion_item_type,
        openalbion_item_id: item.openalbion_item_id,
        openalbion_item_name: item.openalbion_item_name,
        openalbion_item_icon: item.openalbion_item_icon ?? null,
        openalbion_item_tier: item.openalbion_item_tier ?? null,
        openalbion_item_quality: item.openalbion_item_quality ?? DEFAULT_ALBION_ITEM_QUALITY,
        openalbion_item_enchantment: item.openalbion_item_enchantment ?? 0,
        spells: item.spells ?? { active: {}, passive: {} },
      }),
    );
  }

  // ===========================================================================
  // Edit details dialog
  // ===========================================================================

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

  protected openEditMeta(): void {
    const current = this.build();
    if (!current) return;
    this.editName.set(current.name);
    this.editCategoryId.set(current.category_id ? String(current.category_id) : '');
    this.editRole.set(current.role);
    this.editDescription.set(current.description ?? '');
    this.nameError.set(null);
    this.editMetaOpen.set(true);
    void this.loadExistingBuildNames();
  }

  protected closeEditMeta(): void {
    this.editMetaOpen.set(false);
  }

  protected onEditNameChange(event: Event): void {
    this.editName.set((event.target as HTMLInputElement).value);
    this.nameError.set(null);
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

  /** The name rules, as translated messages: required, not too long, not already taken. */
  private validateName(name: string, current: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
      return this.t('validation.required');
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return this.t('compDetail.validation.nameLong', { max: MAX_NAME_LENGTH });
    }
    const lowered = trimmed.toLowerCase();
    const taken = this.existingBuildNames().some((existing) => {
      const normalized = existing.trim().toLowerCase();
      return normalized === lowered && normalized !== current.trim().toLowerCase();
    });
    return taken ? this.t('buildDetail.validation.nameTaken') : null;
  }

  protected async saveEdit(event: Event): Promise<void> {
    event.preventDefault();
    const build = this.build();
    if (!build) {
      return;
    }
    const error = this.validateName(this.editName(), build.name);
    this.nameError.set(error);
    if (error) {
      return;
    }

    // The server refuses to save a build without a main-hand weapon (battle mounts excepted), so
    // say so here instead of after the round trip.
    const effectiveRole = this.editRole() || build.role;
    if (buildNeedsWeapon(effectiveRole) && !build.weapon_key) {
      this.toasts.error(this.t('comps.weaponRequired'));
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
      this.editMetaOpen.set(false);
      return;
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch<BuildDetail>(`api/comps/builds/${build.id}`, request));
      this.editMetaOpen.set(false);
      await this.load(this.buildId(), true);
      this.toasts.success(this.t('buildDetail.toast.detailsSaved'));
    } catch {
      this.toasts.error(this.t('buildDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  // ===========================================================================
  // Archive
  // ===========================================================================

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
      await this.load(this.buildId(), true);
    } catch {
      this.toasts.error(this.t('buildDetail.error.action'));
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
      await this.load(this.buildId(), true);
    } catch {
      this.toasts.error(this.t('buildDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  // ===========================================================================
  // Numbers
  // ===========================================================================

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
    return this.t('compDetail.compare.summary', {
      rate: this.winRate(stats.wins, stats.losses),
      kills: stats.kills,
      deaths: stats.deaths,
      battles: stats.battles,
    });
  }

  protected formatSilver(value: number | string): string {
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return String(value);
    }
    return numeric.toLocaleString(this.translate.locale(), { maximumFractionDigits: 0 });
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 0 }).format(value);
  }

  protected formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.translate.locale(), { dateStyle: 'medium' }).format(date);
  }

  /** `T8.2` from a tier and an enchantment, the way the game writes it. */
  private ipTierLabel(entry: { tier: number; enchantment: number }): string {
    return entry.enchantment > 0 ? `T${entry.tier}.${entry.enchantment}` : `T${entry.tier}`;
  }

  // ===========================================================================
  // Compare versions
  // ===========================================================================

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
    this.compareLoading.set(true);
    this.compareWith.set(null);
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
    } catch {
      if (Number(this.compareWithId()) !== buildId) return;
      this.toasts.error(this.t('buildDetail.error.compare'));
    } finally {
      if (Number(this.compareWithId()) === buildId) {
        this.compareLoading.set(false);
      }
    }
  }

  // ===========================================================================
  // Versions
  // ===========================================================================

  protected openVersion(buildId: number): void {
    if (buildId === this.build()?.id) {
      return;
    }
    this.guardUnsaved(() => void this.router.navigate(['/builds', buildId]));
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
      await this.router.navigate(['/builds', created.id]);
    } catch {
      this.toasts.error(this.t('buildDetail.error.action'));
    } finally {
      this.saving.set(false);
    }
  }

  // ===========================================================================
  // Alliance sharing
  // ===========================================================================

  protected async shareWithAlliance(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(
        this.api.post<AllianceShareStatus['share']>('api/alliance/shares', {
          type: 'build',
          id: build.id,
        }),
      );
      this.toasts.success(this.t('comps.shareSuccess'));
      await this.loadShareStatus(build.id);
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async unshareWithAlliance(): Promise<void> {
    const build = this.build();
    if (!build) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/alliance/shares/build/${build.id}`));
      this.toasts.success(this.t('comps.unshareSuccess'));
      this.shareStatus.set({ shared: false });
    } catch (error) {
      this.toasts.error(this.shareErrorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** Only the one conflict a person can act on gets its own message; the rest stay generic. */
  private shareErrorMessage(error: unknown): string {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      error.message === 'guild is not an active member of an alliance'
    ) {
      return this.t('comps.shareNoAlliance');
    }
    return this.t('buildDetail.error.action');
  }

  private async loadShareStatus(buildId: number): Promise<void> {
    if (!this.isGuildTenant()) {
      this.shareStatus.set(null);
      return;
    }
    try {
      const status = await firstValueFrom(
        this.api.get<AllianceShareStatus>(`api/alliance/shares/build/${buildId}`),
      );
      if (buildId !== this.buildId()) {
        return;
      }
      this.shareStatus.set(status);
    } catch {
      if (buildId !== this.buildId()) {
        return;
      }
      this.shareStatus.set({ shared: false });
    }
  }

  // ===========================================================================
  // Loading
  // ===========================================================================

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

  private async loadMarketPrice(buildId: number): Promise<void> {
    try {
      const price = await firstValueFrom(
        this.api.get<BuildPriceView>(`api/comps/builds/${buildId}/price`),
      );
      if (buildId !== this.buildId()) return;
      this.marketPrice.set(price);
    } catch {
      if (buildId !== this.buildId()) return;
      this.marketPrice.set(null);
    }
  }

  private async loadItemPowerAtMax(buildId: number): Promise<void> {
    try {
      const itemPower = await firstValueFrom(
        this.api.get<ItemPowerView>(`api/comps/builds/${buildId}/item-power?spec=max`),
      );
      if (buildId !== this.buildId()) return;
      this.itemPowerAtMax.set(itemPower);
    } catch {
      if (buildId !== this.buildId()) return;
      this.itemPowerAtMax.set(null);
    }
  }

  /** Item power, price and battle numbers, fetched together so the key numbers appear as one. */
  private async loadMetrics(buildId: number): Promise<void> {
    this.metricsLoading.set(true);
    await Promise.all([
      this.loadPerformance(buildId),
      this.loadItemPowerAtMax(buildId),
      this.loadMarketPrice(buildId),
    ]);
    if (buildId === this.buildId()) {
      this.metricsLoading.set(false);
    }
  }

  /**
   * Loads the build and the numbers around it.
   *
   * `silent` refreshes in place (after saving details, an archive) without swapping the page for
   * the loading skeleton.
   */
  protected async load(buildId: number, silent = false): Promise<void> {
    if (!Number.isFinite(buildId) || buildId <= 0) {
      this.build.set(null);
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    if (!silent) {
      this.loading.set(true);
    }
    this.loadFailed.set(false);
    this.notFound.set(false);
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
      void this.loadMetrics(buildId);
      void this.loadShareStatus(buildId);
    } catch (error) {
      if (buildId !== this.buildId()) return;
      if (silent) {
        this.toasts.error(this.t('buildDetail.error.action'));
      } else if (error instanceof ApiError && error.status === 404) {
        this.build.set(null);
        this.notFound.set(true);
      } else {
        this.build.set(null);
        this.loadFailed.set(true);
      }
    } finally {
      if (buildId === this.buildId()) {
        this.loading.set(false);
      }
    }
  }
}
