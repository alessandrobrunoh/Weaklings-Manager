import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { EChartsOption } from 'echarts';

import type {
  AttackerStyle,
  BuildDetail,
  BuildItemSlot,
  BuildSlot,
  BuildSummary,
  CompDetail,
  CompSummary,
  OpenAlbionItem,
  OpenAlbionItemAbilities,
  PaginatedData,
  RunDetail,
  RunSummary,
  ScenarioDeclaredCast,
  ScenarioDefinition,
  ScenarioDetail,
  ScenarioSide,
  ScenarioUnitGroup,
  UpdateScenarioRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  abilityCatalogKey,
  abilityKeyForItem,
  abilitySlotsFor,
} from '../../shared/data/albion-abilities';
import {
  albionCombatIconUrl,
  deduplicateAlbionCombatCatalog,
} from '../../shared/data/albion-equipment-catalog';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { Chart, type ChartTableRow } from '../../shared/components/chart/chart';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { VersionSwitcher } from '../../shared/components/version-switcher/version-switcher';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import { hpOverTimeSeries } from './hp-timeline';

type EditorTab = 'setup' | 'timeline' | 'results';

/** Line colours shared with the Units table's ally/enemy chips (`chip--info` / `chip--error`). */
const ALLY_LINE_COLOR = '#38bdf8';
const ENEMY_LINE_COLOR = '#f87171';

let groupSeq = 0;

function emptyDefinition(): ScenarioDefinition {
  return { groups: [], casts: [] };
}

/** All unit instance ids a definition's groups expand to — `"{id}#0"`..`"{id}#{count-1}"`. */
function unitIdsOf(definition: ScenarioDefinition): string[] {
  return definition.groups.flatMap((group) =>
    Array.from({ length: Math.max(1, group.count ?? 1) }, (_, n) => `${group.id}#${n}`),
  );
}

/**
 * Maps an ability catalog entry's `slot_type` back to the `BuildSlot` `abilitySlotsFor` needs to
 * pick the right Q/W/E/D/R/F labels. Off-hands, capes and the rest carry no abilities at all
 * (`slot_type` is absent from the catalog for them), so `weapon` is a harmless default there —
 * `abilitySlotsFor` returns nothing for a slot with zero configured active/passive counts anyway.
 */
function buildSlotForAbilities(abilities: OpenAlbionItemAbilities): BuildSlot {
  switch (abilities.slot_type) {
    case 'head':
      return 'head';
    case 'armor':
      return 'armor';
    case 'shoes':
      return 'shoes';
    default:
      return 'weapon';
  }
}

interface GroupedSpellOptions {
  readonly group: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/**
 * Editor for one combat test scenario version: its unit groups, its declared cast timeline, and
 * the results of running it through `POST /api/combat/tests/{id}/run`.
 *
 * Unlike a build or a comp, a test is a scratch document — edits go through `PATCH` in place
 * rather than minting a new version each time (see `combat::models::UpdateScenarioRequest`'s
 * docs). "New version" stays available for deliberately keeping a state around to compare against.
 */
@Component({
  selector: 'app-test-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Chart,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    SearchDialog,
    StatCard,
    VersionSwitcher,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('tests.notFound')"
        [retryLabel]="t('common.retry')"
        (retry)="load(testId())"
      />
    } @else if (scenario(); as current) {
      <app-page-header
        [title]="current.name"
        [subtitle]="t('tests.groupsCount', { count: draft().groups.length }) + ' · ' + t('tests.castsCount', { count: draft().casts.length })"
        [badge]="current.archived_at ? t('tests.archived') : undefined"
      >
        <div pageActions class="flex flex-wrap items-center gap-2">
          <a class="btn btn--ghost" routerLink="/tests">← {{ t('tests.title') }}</a>
          <app-version-switcher
            [versions]="current.versions"
            [currentId]="current.id"
            [canManage]="canManage()"
            [busy]="saving() || creatingVersion()"
            [label]="t('tests.version')"
            [createLabel]="t('tests.newVersion')"
            (select)="openVersion($event)"
            (create)="createVersion()"
          />
          @if (canManage()) {
            <button type="button" class="btn btn--outline btn--sm" (click)="openRename()">
              {{ t('tests.rename') }}
            </button>
            <button type="button" class="btn btn--outline btn--sm" (click)="toggleArchive()">
              {{ current.archived_at ? t('tests.unarchive') : t('tests.archive') }}
            </button>
            @if (dirty()) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="saving()"
                (click)="saveDefinition()"
              >
                {{ t('tests.saveChanges') }}
              </button>
            }
          }
          <button
            type="button"
            class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
            [disabled]="running()"
            (click)="runNow()"
          >
            <app-icon name="activity" size="0.875rem" />
            {{ running() ? t('tests.running') : t('tests.run') }}
          </button>
        </div>
        <app-view-toggle
          pageTabs
          [options]="tabOptions()"
          [active]="activeTab()"
          (activeChange)="switchTab($event)"
        />
      </app-page-header>

      <app-page-stack>
        @if (dirty()) {
          <div class="chip chip--warning text-xs w-fit">{{ t('tests.unsavedChanges') }}</div>
        }

        @switch (activeTab()) {
          @case ('setup') {
            <section class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-base font-bold text-[var(--color-text)]">{{ t('tests.groups') }}</h2>
                @if (canManage()) {
                  <div class="flex items-center gap-2">
                    <button type="button" class="btn btn--outline btn--sm" (click)="openBuildImport()">
                      <app-icon name="search" size="0.75rem" />
                      {{ t('tests.importBuild') }}
                    </button>
                    <button type="button" class="btn btn--outline btn--sm" (click)="openCompImport()">
                      <app-icon name="search" size="0.75rem" />
                      {{ t('tests.importComp') }}
                    </button>
                    <button type="button" class="btn btn--outline btn--sm" (click)="openScoutImport()">
                      <app-icon name="search" size="0.75rem" />
                      {{ t('tests.importScout') }}
                    </button>
                    <button type="button" class="btn btn--tonal btn--sm" (click)="addGroup()">
                      <app-icon name="plus" size="0.75rem" />
                      {{ t('tests.addGroup') }}
                    </button>
                  </div>
                }
              </div>
              @if (draft().groups.length === 0) {
                <app-empty-state [message]="t('tests.noGroups')" icon="activity" />
              } @else {
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-left">{{ t('tests.weapon') }}</th>
                        <th class="text-left">{{ t('tests.groupId') }}</th>
                        <th class="text-left">{{ t('tests.side') }}</th>
                        <th class="text-left">{{ t('tests.label') }}</th>
                        <th class="text-right">{{ t('tests.count') }}</th>
                        <th class="text-right">{{ t('tests.hitPoints') }}</th>
                        <th class="text-center">{{ t('common.actions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (group of draft().groups; track group.id + '#' + $index; let i = $index) {
                        <tr>
                          <td>
                            <div class="flex items-center gap-2">
                              @if (group.item_id) {
                                <img
                                  [src]="combatIconFor(group.item_id)"
                                  alt=""
                                  class="h-6 w-6 rounded shrink-0"
                                />
                              }
                              <button
                                type="button"
                                class="btn btn--outline btn--sm whitespace-nowrap"
                                [disabled]="!canManage()"
                                (click)="openWeaponPicker(i)"
                              >
                                {{ group.item_id ? t('tests.changeWeapon') : t('tests.pickWeapon') }}
                              </button>
                            </div>
                          </td>
                          <td>
                            <input
                              class="input input--sm font-mono"
                              type="text"
                              [value]="group.id"
                              [disabled]="!canManage()"
                              (change)="onGroupIdChange(i, $event)"
                            />
                          </td>
                          <td>
                            <select
                              class="select select--sm"
                              [value]="group.side"
                              [disabled]="!canManage()"
                              (change)="onGroupSideChange(i, $event)"
                            >
                              <option value="ally">{{ t('tests.ally') }}</option>
                              <option value="enemy">{{ t('tests.enemy') }}</option>
                            </select>
                          </td>
                          <td>
                            <input
                              class="input input--sm"
                              type="text"
                              [value]="group.label"
                              [disabled]="!canManage()"
                              (change)="onGroupLabelChange(i, $event)"
                            />
                          </td>
                          <td class="text-right">
                            <input
                              class="input input--sm text-right"
                              type="number"
                              min="1"
                              [value]="group.count ?? 1"
                              [disabled]="!canManage()"
                              (change)="onGroupCountChange(i, $event)"
                            />
                          </td>
                          <td class="text-right">
                            <input
                              class="input input--sm text-right"
                              type="number"
                              min="0"
                              [value]="group.hit_points ?? 1200"
                              [disabled]="!canManage()"
                              (change)="onGroupHitPointsChange(i, $event)"
                            />
                          </td>
                          <td class="text-center">
                            @if (canManage()) {
                              <button
                                type="button"
                                class="btn btn--ghost btn--sm"
                                (click)="removeGroup(i)"
                              >
                                <app-icon name="close" size="0.75rem" />
                              </button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </section>
          }

          @case ('timeline') {
            <section class="card p-5">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-base font-bold text-[var(--color-text)]">{{ t('tests.casts') }}</h2>
                @if (canManage()) {
                  <button
                    type="button"
                    class="btn btn--tonal btn--sm"
                    [disabled]="draft().groups.length === 0"
                    (click)="addCast()"
                  >
                    <app-icon name="plus" size="0.75rem" />
                    {{ t('tests.addCast') }}
                  </button>
                }
              </div>
              @if (draft().casts.length === 0) {
                <app-empty-state [message]="t('tests.noCasts')" icon="activity" />
              } @else {
                <p class="text-xs text-[var(--color-text-secondary)] mb-3">
                  {{ t('tests.targetsHint') }}
                </p>
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-left">{{ t('tests.caster') }}</th>
                        <th class="text-left">{{ t('tests.spellId') }}</th>
                        <th class="text-right">{{ t('tests.castAt') }}</th>
                        <th class="text-left">{{ t('tests.targets') }}</th>
                        <th class="text-left">{{ t('tests.attackerStyle') }}</th>
                        <th class="text-center">{{ t('common.actions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (cast of draft().casts; track $index; let i = $index) {
                        <tr>
                          <td>
                            <select
                              class="select select--sm"
                              [value]="cast.caster_group_id"
                              [disabled]="!canManage()"
                              (change)="onCastCasterChange(i, $event)"
                            >
                              @for (group of draft().groups; track group.id) {
                                <option [value]="group.id">{{ group.label }} ({{ group.id }})</option>
                              }
                            </select>
                          </td>
                          <td>
                            @if (groupedSpellOptionsFor(cast.caster_group_id).length > 0) {
                              <select
                                class="select select--sm"
                                [value]="cast.spell_id"
                                [disabled]="!canManage()"
                                (change)="onCastSpellIdChange(i, $event)"
                              >
                                <option value="">{{ t('tests.pickSpell') }}</option>
                                @for (grp of groupedSpellOptionsFor(cast.caster_group_id); track grp.group) {
                                  <optgroup [label]="grp.group">
                                    @for (opt of grp.options; track opt.value) {
                                      <option [value]="opt.value">{{ opt.label }}</option>
                                    }
                                  </optgroup>
                                }
                              </select>
                            } @else {
                              <input
                                class="input input--sm font-mono"
                                type="text"
                                placeholder="SPELL_ID"
                                [value]="cast.spell_id"
                                [disabled]="!canManage()"
                                (change)="onCastSpellIdChange(i, $event)"
                              />
                            }
                          </td>
                          <td class="text-right">
                            <input
                              class="input input--sm text-right"
                              type="number"
                              step="0.1"
                              min="0"
                              [value]="cast.cast_at"
                              [disabled]="!canManage()"
                              (change)="onCastAtChange(i, $event)"
                            />
                          </td>
                          <td>
                            <select
                              multiple
                              class="select select--sm"
                              style="min-height: 4.5rem"
                              [disabled]="!canManage()"
                              (change)="onCastTargetsChange(i, $event)"
                            >
                              @for (grp of unitOptionsGrouped(); track grp.groupLabel) {
                                <optgroup [label]="grp.groupLabel">
                                  @for (id of grp.ids; track id) {
                                    <option [value]="id" [selected]="cast.target_ids.includes(id)">
                                      {{ id }}
                                    </option>
                                  }
                                </optgroup>
                              }
                            </select>
                          </td>
                          <td>
                            <select
                              class="select select--sm"
                              [value]="cast.attacker_style ?? 'melee'"
                              [disabled]="!canManage()"
                              (change)="onCastAttackerStyleChange(i, $event)"
                            >
                              <option value="melee">{{ t('tests.melee') }}</option>
                              <option value="ranged">{{ t('tests.ranged') }}</option>
                              <option value="mounted">{{ t('tests.mounted') }}</option>
                            </select>
                          </td>
                          <td class="text-center">
                            @if (canManage()) {
                              <button
                                type="button"
                                class="btn btn--ghost btn--sm"
                                (click)="removeCast(i)"
                              >
                                <app-icon name="close" size="0.75rem" />
                              </button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                <p class="text-xs text-[var(--color-text-tertiary)] mt-3">
                  {{ t('tests.noGeometryWarning') }}
                </p>
              }
            </section>
          }

          @case ('results') {
            @if (!latestRun()) {
              <app-empty-state [message]="t('tests.noRunsYet')" icon="activity" />
            } @else {
              <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <app-stat-card
                  [label]="t('tests.deaths')"
                  [value]="latestRun()!.result.deaths"
                  icon="alert"
                  tone="danger"
                />
                <app-stat-card
                  [label]="t('tests.totalDamage')"
                  [value]="formatAmount(latestRun()!.result.total_damage_dealt)"
                  icon="swords"
                  tone="warning"
                />
                <app-stat-card
                  [label]="t('tests.totalHealing')"
                  [value]="formatAmount(latestRun()!.result.total_healing_done)"
                  icon="sparkles"
                  tone="success"
                />
                <app-stat-card
                  [label]="t('tests.avgTimeToKill')"
                  [value]="latestRun()!.result.average_time_to_kill !== null ? formatSeconds(latestRun()!.result.average_time_to_kill!) : '—'"
                  icon="activity"
                  tone="primary"
                />
                <app-stat-card
                  [label]="t('tests.overkillRatio')"
                  [value]="formatPercent(latestRun()!.result.overkill_ratio)"
                  icon="chart"
                  tone="neutral"
                />
              </div>

              @if (latestRun()!.result.unknown_spells.length > 0 || latestRun()!.result.casts_with_no_targets.length > 0) {
                <section class="card p-4 border border-[var(--color-warning)] bg-[var(--color-warning-container)]">
                  @if (latestRun()!.result.unknown_spells.length > 0) {
                    <p class="text-xs text-[var(--color-warning)]">
                      <strong>{{ t('tests.unknownSpells') }}:</strong>
                      {{ latestRun()!.result.unknown_spells.join(', ') }}
                    </p>
                  }
                  @if (latestRun()!.result.casts_with_no_targets.length > 0) {
                    <p class="text-xs text-[var(--color-warning)] mt-1">
                      <strong>{{ t('tests.castsWithNoTargets') }}:</strong>
                      {{ latestRun()!.result.casts_with_no_targets.join(', ') }}
                    </p>
                  }
                </section>
              }

              <section class="card p-5">
                <h2 class="mb-4 text-base font-bold text-[var(--color-text)]">{{ t('tests.hpOverTime') }}</h2>
                <app-chart
                  [option]="hpOverTimeOption()"
                  height="16rem"
                  [label]="t('tests.hpOverTime')"
                  [tableHead]="hpOverTimeTableHead()"
                  [tableRows]="hpOverTimeTableRows()"
                />
              </section>

              <section class="card p-5">
                <h2 class="mb-4 text-base font-bold text-[var(--color-text)]">{{ t('tests.unitOutcomes') }}</h2>
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-left">{{ common('common.name') }}</th>
                        <th class="text-left">{{ t('tests.side') }}</th>
                        <th class="text-right">{{ t('tests.startingHp') }}</th>
                        <th class="text-right">{{ t('tests.damageTaken') }}</th>
                        <th class="text-right">{{ t('tests.healingReceived') }}</th>
                        <th class="text-right">{{ t('tests.remainingHp') }}</th>
                        <th class="text-center">{{ t('common.status') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (unit of latestRun()!.result.units; track unit.id) {
                        <tr>
                          <td class="font-mono text-xs">{{ unit.id }}</td>
                          <td>
                            <span class="chip text-[10px]" [class.chip--info]="unit.side === 'ally'" [class.chip--error]="unit.side === 'enemy'">
                              {{ unit.side === 'ally' ? t('tests.ally') : t('tests.enemy') }}
                            </span>
                          </td>
                          <td class="text-right font-mono text-xs">{{ formatAmount(unit.starting_hp) }}</td>
                          <td class="text-right font-mono text-xs text-[var(--color-error)]">{{ formatAmount(unit.damage_taken) }}</td>
                          <td class="text-right font-mono text-xs text-[var(--color-success)]">{{ formatAmount(unit.healing_received) }}</td>
                          <td class="text-right font-mono text-xs">{{ formatAmount(unit.remaining_hp) }}</td>
                          <td class="text-center">
                            @if (unit.died_at !== null) {
                              <span class="chip chip--error text-[10px]">{{ t('tests.died') }} · {{ formatSeconds(unit.died_at) }}</span>
                            } @else {
                              <span class="chip chip--success text-[10px]">{{ t('tests.alive') }}</span>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="card p-5">
                <h2 class="mb-4 text-base font-bold text-[var(--color-text)]">{{ t('tests.castLog') }}</h2>
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th class="text-right">{{ t('tests.landAt') }}</th>
                        <th class="text-left">{{ t('tests.caster') }}</th>
                        <th class="text-left">{{ t('tests.spellId') }}</th>
                        <th class="text-left">{{ t('tests.targets') }}</th>
                        <th class="text-right">{{ t('tests.concurrentAttackers') }}</th>
                        <th class="text-right">{{ t('tests.escalation') }}</th>
                        <th class="text-right">{{ t('tests.focusFireReduction') }}</th>
                        <th class="text-right">{{ t('tests.perTargetChange') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (log of latestRun()!.result.casts; track $index) {
                        <tr>
                          <td class="text-right font-mono text-xs">{{ formatSeconds(log.land_at) }}</td>
                          <td class="font-mono text-xs">{{ log.caster_group_id }}</td>
                          <td class="font-mono text-xs">{{ log.spell_id }}</td>
                          <td class="font-mono text-xs">{{ log.target_ids.join(', ') }}</td>
                          <td class="text-right font-mono text-xs">{{ log.concurrent_attackers }}</td>
                          <td class="text-right font-mono text-xs">{{ formatMultiplier(log.escalation_multiplier) }}</td>
                          <td class="text-right font-mono text-xs">{{ formatPercent(log.focus_fire_reduction) }}</td>
                          <td class="text-right font-mono text-xs" [class.text-[var(--color-error)]]="log.per_target_health_change < 0" [class.text-[var(--color-success)]]="log.per_target_health_change > 0">
                            {{ formatAmount(log.per_target_health_change) }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="card p-5">
                <h2 class="mb-4 text-base font-bold text-[var(--color-text)]">{{ t('tests.pastRuns') }}</h2>
                @if (runs().length === 0) {
                  <p class="text-xs text-[var(--color-text-secondary)]">{{ t('tests.noPastRuns') }}</p>
                } @else {
                  <div class="overflow-x-auto">
                    <table class="table">
                      <thead>
                        <tr>
                          <th class="text-left">{{ t('tests.ranBy') }}</th>
                          <th class="text-left">{{ t('tests.ranAt') }}</th>
                          <th class="text-center">{{ t('common.actions') }}</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (run of runs(); track run.id) {
                          <tr>
                            <td class="text-xs">{{ run.ran_by_username }}</td>
                            <td class="text-xs">{{ formatDate(run.ran_at) }}</td>
                            <td class="text-center">
                              <button type="button" class="btn btn--ghost btn--sm" (click)="viewRun(run.id)">
                                {{ t('tests.viewRun') }}
                              </button>
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                }
              </section>
            }
          }
        }
      </app-page-stack>
    }

    @if (weaponPickerGroupIndex() !== null) {
      <app-search-dialog
        [title]="t('tests.pickWeapon')"
        [placeholder]="t('tests.searchWeaponPlaceholder')"
        [options]="weaponPickerOptions()"
        (filterChange)="onWeaponPickerFilter($event)"
        (select)="onWeaponSelected($event)"
        (close)="closeWeaponPicker()"
      />
    }

    @if (buildSearchOpen()) {
      <app-search-dialog
        [title]="t('tests.importBuild')"
        [placeholder]="t('tests.searchBuildPlaceholder')"
        [options]="buildSearchOptions()"
        [loading]="buildSearchLoading()"
        (filterChange)="onBuildSearchFilter($event)"
        (select)="onBuildSelected($event)"
        (close)="closeBuildImport()"
      />
    }

    @if (compSearchOpen()) {
      <app-search-dialog
        [title]="t('tests.importComp')"
        [placeholder]="t('tests.searchCompPlaceholder')"
        [options]="compSearchOptions()"
        [loading]="compSearchLoading()"
        (filterChange)="onCompSearchFilter($event)"
        (select)="onCompSelected($event)"
        (close)="closeCompImport()"
      />
    }

    @if (scoutSearchOpen()) {
      <app-search-dialog
        [title]="t('tests.importScout')"
        [placeholder]="t('tests.searchScoutPlaceholder')"
        [options]="scoutSearchOptions()"
        [loading]="scoutSearchLoading()"
        (filterChange)="onScoutSearchFilter($event)"
        (select)="onScoutSelected($event)"
        (close)="closeScoutImport()"
      />
    }

    @if (renameOpen()) {
      <app-dialog [title]="t('tests.renameTitle')" size="sm" (closed)="closeRename()">
        <form id="test-rename-form" class="grid gap-4" (submit)="onRenameSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              autofocus
              [value]="renameDraft()"
              (input)="renameDraft.set($any($event.target).value)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeRename()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            [attr.form]="'test-rename-form'"
            [disabled]="saving() || !renameDraft().trim()"
          >
            {{ t('common.save') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class TestDetailPage {
  private readonly albionAbilities = inject(AlbionAbilitiesService);
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly intel = inject(IntelService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly testId = signal(Number(this.route.snapshot.paramMap.get('testId')));

  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly scenario = signal<ScenarioDetail | null>(null);
  protected readonly savedDefinition = signal<ScenarioDefinition>(emptyDefinition());
  protected readonly draft = signal<ScenarioDefinition>(emptyDefinition());
  protected readonly activeTab = signal<EditorTab>('setup');
  protected readonly saving = signal(false);
  protected readonly creatingVersion = signal(false);
  protected readonly running = signal(false);
  protected readonly runs = signal<RunSummary[]>([]);
  protected readonly latestRun = signal<RunDetail | null>(null);
  protected readonly renameOpen = signal(false);
  protected readonly renameDraft = signal('');

  /** Every weapon/armor identifier the Setup tab can offer, one entry per base identifier. */
  protected readonly combatCatalog = signal<OpenAlbionItem[]>([]);
  /** `base_identifier -> abilities`, for scoping the Timeline tab's spell picker per group. */
  protected readonly abilitiesCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});

  protected readonly weaponPickerGroupIndex = signal<number | null>(null);
  protected readonly weaponSearchText = signal('');
  protected readonly weaponPickerOptions = computed<SearchDialogOption[]>(() => {
    const query = this.weaponSearchText().trim().toLowerCase();
    return this.combatCatalog()
      .filter((item) => !query || item.name.toLowerCase().includes(query))
      .slice(0, 100)
      .map((item) => ({
        id: item.identifier ?? String(item.id),
        title: item.name,
        subtitle: item.identifier ?? undefined,
        chip: item.type ?? undefined,
      }));
  });

  protected readonly buildSearchOpen = signal(false);
  protected readonly buildSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly buildSearchLoading = signal(false);

  protected readonly compSearchOpen = signal(false);
  protected readonly compSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly compSearchLoading = signal(false);

  protected readonly scoutSearchOpen = signal(false);
  protected readonly scoutSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly scoutSearchLoading = signal(false);

  protected readonly canManage = computed(() => this.auth.hasPermission('combat.tests.manage'));

  protected readonly dirty = computed(
    () => JSON.stringify(this.draft()) !== JSON.stringify(this.savedDefinition()),
  );

  /** Every unit instance a cast can target, grouped by the group it belongs to. */
  protected readonly unitOptionsGrouped = computed(() =>
    this.draft().groups.map((group) => ({
      groupLabel: `${group.label} (${group.side === 'ally' ? this.t('tests.ally') : this.t('tests.enemy')})`,
      ids: unitIdsOf({ groups: [group], casts: [] }),
    })),
  );

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'setup', label: this.t('tests.setup') },
    { id: 'timeline', label: this.t('tests.timeline') },
    { id: 'results', label: this.t('tests.results') },
  ]);

  /** Total HP remaining per side over the burst window, reconstructed from the latest run. */
  private readonly hpOverTimePoints = computed(() => {
    const run = this.latestRun();
    return run ? hpOverTimeSeries(run.result) : [];
  });

  protected readonly hpOverTimeOption = computed<EChartsOption>(() => {
    const points = this.hpOverTimePoints();
    return {
      aria: { enabled: true },
      grid: { left: 56, right: 16, top: 24, bottom: 40 },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'value',
        name: this.t('tests.landAt'),
        nameLocation: 'middle',
        nameGap: 28,
        axisLabel: { formatter: (value: number) => `${value}s` },
      },
      yAxis: { type: 'value', name: this.t('tests.hpOverTime') },
      series: [
        {
          name: this.t('tests.ally'),
          type: 'line',
          data: points.map((point) => [point.time, point.allyHp]),
          symbol: 'none',
          step: 'end',
          lineStyle: { width: 2, color: ALLY_LINE_COLOR },
          itemStyle: { color: ALLY_LINE_COLOR },
        },
        {
          name: this.t('tests.enemy'),
          type: 'line',
          data: points.map((point) => [point.time, point.enemyHp]),
          symbol: 'none',
          step: 'end',
          lineStyle: { width: 2, color: ENEMY_LINE_COLOR },
          itemStyle: { color: ENEMY_LINE_COLOR },
        },
      ],
    };
  });

  protected readonly hpOverTimeTableHead = computed(() => [
    this.t('tests.landAt'),
    this.t('tests.ally'),
    this.t('tests.enemy'),
  ]);

  protected readonly hpOverTimeTableRows = computed<ChartTableRow[]>(() =>
    this.hpOverTimePoints().map((point) => [
      this.formatSeconds(point.time),
      this.formatAmount(point.allyHp),
      this.formatAmount(point.enemyHp),
    ]),
  );

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
  protected common = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const id = Number(params.get('testId'));
      if (id === this.testId() && this.scenario()) return;
      this.testId.set(id);
      this.activeTab.set('setup');
      void this.load(id);
    });

    // Static application data shared with the comp/build editor; one fetch serves every test page.
    void this.albionCatalog
      .load()
      .then((items) => this.combatCatalog.set(deduplicateAlbionCombatCatalog(items)))
      .catch(() => this.combatCatalog.set([]));
    void this.albionAbilities
      .load()
      .then((abilities) => this.abilitiesCatalog.set(abilities))
      .catch(() => this.abilitiesCatalog.set({}));
  }

  protected switchTab(tab: string): void {
    if (tab === 'setup' || tab === 'timeline' || tab === 'results') {
      this.activeTab.set(tab);
    }
  }

  // ---- Groups ----

  protected addGroup(): void {
    groupSeq += 1;
    const group: ScenarioUnitGroup = {
      id: `group-${groupSeq}`,
      side: 'ally',
      label: this.t('tests.newGroupLabel'),
      item_id: null,
      count: 1,
      hit_points: 1200,
    };
    this.draft.update((def) => ({ ...def, groups: [...def.groups, group] }));
  }

  protected removeGroup(index: number): void {
    this.draft.update((def) => ({ ...def, groups: def.groups.filter((_, i) => i !== index) }));
  }

  protected updateGroup(index: number, patch: Partial<ScenarioUnitGroup>): void {
    this.draft.update((def) => ({
      ...def,
      groups: def.groups.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    }));
  }

  protected onGroupIdChange(index: number, event: Event): void {
    this.updateGroup(index, { id: (event.target as HTMLInputElement).value.trim() });
  }

  protected onGroupSideChange(index: number, event: Event): void {
    this.updateGroup(index, { side: (event.target as HTMLSelectElement).value as ScenarioSide });
  }

  protected onGroupLabelChange(index: number, event: Event): void {
    this.updateGroup(index, { label: (event.target as HTMLInputElement).value });
  }

  protected onGroupCountChange(index: number, event: Event): void {
    this.updateGroup(index, {
      count: Math.max(1, Math.round(Number((event.target as HTMLInputElement).value)) || 1),
    });
  }

  protected onGroupHitPointsChange(index: number, event: Event): void {
    this.updateGroup(index, {
      hit_points: Math.max(0, Number((event.target as HTMLInputElement).value) || 0),
    });
  }

  protected combatIconFor(itemId: string): string {
    return albionCombatIconUrl(itemId);
  }

  protected openWeaponPicker(index: number): void {
    this.weaponPickerGroupIndex.set(index);
    this.weaponSearchText.set('');
  }

  protected closeWeaponPicker(): void {
    this.weaponPickerGroupIndex.set(null);
  }

  protected onWeaponPickerFilter(filter: { search: string }): void {
    this.weaponSearchText.set(filter.search);
  }

  protected onWeaponSelected(option: SearchDialogOption): void {
    const index = this.weaponPickerGroupIndex();
    if (index === null) return;
    this.updateGroup(index, { item_id: String(option.id), label: option.title });
    this.weaponPickerGroupIndex.set(null);
  }

  /** Imports a unit group from an existing build: weapon and label prefilled, ready to run. */
  protected openBuildImport(): void {
    this.buildSearchOpen.set(true);
    this.buildSearchOptions.set([]);
  }

  protected closeBuildImport(): void {
    this.buildSearchOpen.set(false);
  }

  protected async onBuildSearchFilter(filter: { search: string }): Promise<void> {
    this.buildSearchLoading.set(true);
    try {
      const params: Record<string, string | number> = { limit: 20 };
      if (filter.search) params['search'] = filter.search;
      const data = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', params),
      );
      this.buildSearchOptions.set(
        data.items.map((build) => ({
          id: build.id,
          title: build.name,
          subtitle: build.category_name ?? undefined,
        })),
      );
    } finally {
      this.buildSearchLoading.set(false);
    }
  }

  protected async onBuildSelected(option: SearchDialogOption): Promise<void> {
    this.buildSearchOpen.set(false);
    try {
      const build = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${option.id}`));
      const weapon = build.items.find((item): item is BuildItemSlot => item.slot === 'weapon');
      groupSeq += 1;
      const group: ScenarioUnitGroup = {
        id: `group-${groupSeq}`,
        side: 'ally',
        label: weapon?.openalbion_item_name ?? build.name,
        item_id: weapon ? abilityKeyForItem(weapon) : null,
        count: 1,
        hit_points: 1200,
      };
      this.draft.update((def) => ({ ...def, groups: [...def.groups, group] }));
      this.toasts.success(this.t('tests.importedFromBuild', { name: build.name }));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  /** Imports one ally group per build in an existing comp, quantity and weapon prefilled. */
  protected openCompImport(): void {
    this.compSearchOpen.set(true);
    this.compSearchOptions.set([]);
  }

  protected closeCompImport(): void {
    this.compSearchOpen.set(false);
  }

  protected async onCompSearchFilter(filter: { search: string }): Promise<void> {
    this.compSearchLoading.set(true);
    try {
      const params: Record<string, string | number> = { limit: 20 };
      if (filter.search) params['search'] = filter.search;
      const data = await firstValueFrom(this.api.get<PaginatedData<CompSummary>>('api/comps', params));
      this.compSearchOptions.set(
        data.items.map((comp) => ({
          id: comp.id,
          title: comp.name,
          subtitle: comp.category_name ?? undefined,
        })),
      );
    } finally {
      this.compSearchLoading.set(false);
    }
  }

  protected async onCompSelected(option: SearchDialogOption): Promise<void> {
    this.compSearchOpen.set(false);
    try {
      const comp = await firstValueFrom(this.api.get<CompDetail>(`api/comps/${option.id}`));
      const builds = await Promise.all(
        comp.builds.map((entry) =>
          firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${entry.build_id}`)),
        ),
      );
      const groups: ScenarioUnitGroup[] = builds.map((build, index) => {
        const weapon = build.items.find((item): item is BuildItemSlot => item.slot === 'weapon');
        groupSeq += 1;
        return {
          id: `group-${groupSeq}`,
          side: 'ally',
          label: weapon?.openalbion_item_name ?? build.name,
          item_id: weapon ? abilityKeyForItem(weapon) : null,
          count: comp.builds[index].quantity,
          hit_points: 1200,
        };
      });
      this.draft.update((def) => ({ ...def, groups: [...def.groups, ...groups] }));
      this.toasts.success(this.t('tests.importedFromComp', { count: groups.length, name: comp.name }));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  /**
   * Imports one enemy group per weapon observed in a scout — a hypothesis, not observed fact:
   * scout data has no armor or ability information, only a weapon histogram and an aggregate IP.
   */
  protected openScoutImport(): void {
    this.scoutSearchOpen.set(true);
    this.scoutSearchOptions.set([]);
  }

  protected closeScoutImport(): void {
    this.scoutSearchOpen.set(false);
  }

  protected async onScoutSearchFilter(filter: { search: string }): Promise<void> {
    this.scoutSearchLoading.set(true);
    try {
      const data = await firstValueFrom(this.intel.listScouts({ q: filter.search || undefined, limit: 20 }));
      this.scoutSearchOptions.set(
        data.items.map((scout) => ({
          id: scout.id,
          title: scout.name,
          subtitle: scout.opponent_guild_name,
        })),
      );
    } finally {
      this.scoutSearchLoading.set(false);
    }
  }

  protected async onScoutSelected(option: SearchDialogOption): Promise<void> {
    this.scoutSearchOpen.set(false);
    try {
      const scout = await firstValueFrom(this.intel.getScout(Number(option.id)));
      const catalog = this.combatCatalog();
      const groups: ScenarioUnitGroup[] = Object.entries(scout.weapons).map(([rawIdentifier, count]) => {
        const baseIdentifier = abilityCatalogKey(rawIdentifier);
        const known = catalog.find((item) => item.identifier === baseIdentifier);
        groupSeq += 1;
        return {
          id: `group-${groupSeq}`,
          side: 'enemy',
          label: known?.name ?? baseIdentifier,
          item_id: baseIdentifier,
          count: Math.max(1, count),
          hit_points: 1200,
        };
      });
      this.draft.update((def) => ({ ...def, groups: [...def.groups, ...groups] }));
      this.toasts.success(this.t('tests.importedFromScout', { count: groups.length, name: scout.name }));
      this.toasts.info(this.t('tests.scoutImportWarning'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  /** This group's weapon's abilities, grouped by slot (Q/W/E/Passive) — empty until one is picked. */
  protected groupedSpellOptionsFor(casterGroupId: string): GroupedSpellOptions[] {
    const group = this.draft().groups.find((candidate) => candidate.id === casterGroupId);
    const itemId = group?.item_id;
    if (!itemId) return [];
    const abilities = this.abilitiesCatalog()[abilityCatalogKey(itemId)];
    if (!abilities) return [];
    const slots = abilitySlotsFor(buildSlotForAbilities(abilities), abilities, undefined);
    return slots
      .filter((slot) => slot.choices.length > 0)
      .map((slot) => ({
        group: slot.label,
        options: slot.choices.map((choice) => ({ value: choice.id, label: choice.name })),
      }));
  }

  // ---- Casts ----

  protected addCast(): void {
    const firstGroup = this.draft().groups[0];
    if (!firstGroup) return;
    const cast: ScenarioDeclaredCast = {
      caster_group_id: firstGroup.id,
      spell_id: '',
      cast_at: 0,
      target_ids: [],
      attacker_style: 'melee',
    };
    this.draft.update((def) => ({ ...def, casts: [...def.casts, cast] }));
  }

  protected removeCast(index: number): void {
    this.draft.update((def) => ({ ...def, casts: def.casts.filter((_, i) => i !== index) }));
  }

  protected updateCast(index: number, patch: Partial<ScenarioDeclaredCast>): void {
    this.draft.update((def) => ({
      ...def,
      casts: def.casts.map((cast, i) => (i === index ? { ...cast, ...patch } : cast)),
    }));
  }

  protected onCastCasterChange(index: number, event: Event): void {
    this.updateCast(index, { caster_group_id: (event.target as HTMLSelectElement).value });
  }

  protected onCastSpellIdChange(index: number, event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.updateCast(index, { spell_id: target.value.trim() });
  }

  protected onCastAtChange(index: number, event: Event): void {
    this.updateCast(index, { cast_at: Math.max(0, Number((event.target as HTMLInputElement).value) || 0) });
  }

  protected onCastTargetsChange(index: number, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const target_ids = Array.from(select.selectedOptions).map((option) => option.value);
    this.updateCast(index, { target_ids });
  }

  protected onCastAttackerStyleChange(index: number, event: Event): void {
    this.updateCast(index, { attacker_style: (event.target as HTMLSelectElement).value as AttackerStyle });
  }

  // ---- Persistence ----

  protected async saveDefinition(): Promise<void> {
    const id = this.testId();
    this.saving.set(true);
    try {
      const request: UpdateScenarioRequest = { definition: this.draft() };
      const updated = await firstValueFrom(
        this.api.patch<ScenarioDetail>(`api/combat/tests/${id}`, request),
      );
      this.applyScenario(updated);
      this.toasts.success(this.t('tests.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async openVersion(id: number): Promise<void> {
    if (id === this.scenario()?.id) return;
    await this.router.navigate(['/tests', id]);
  }

  protected async createVersion(): Promise<void> {
    const current = this.scenario();
    if (!current) return;
    this.creatingVersion.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<ScenarioDetail>(`api/combat/tests/${current.id}/versions`),
      );
      this.toasts.success(this.t('tests.versionCreated'));
      await this.router.navigate(['/tests', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creatingVersion.set(false);
    }
  }

  protected openRename(): void {
    this.renameDraft.set(this.scenario()?.name ?? '');
    this.renameOpen.set(true);
  }

  protected closeRename(): void {
    this.renameOpen.set(false);
  }

  protected async onRenameSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.renameDraft().trim();
    if (!name) return;
    this.saving.set(true);
    try {
      const request: UpdateScenarioRequest = { name };
      const updated = await firstValueFrom(
        this.api.patch<ScenarioDetail>(`api/combat/tests/${this.testId()}`, request),
      );
      this.applyScenario(updated);
      this.renameOpen.set(false);
      this.toasts.success(this.t('tests.renameSuccess'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async toggleArchive(): Promise<void> {
    const current = this.scenario();
    if (!current) return;
    try {
      const action = current.archived_at ? 'unarchive' : 'archive';
      const updated = await firstValueFrom(
        this.api.post<ScenarioDetail>(`api/combat/tests/${current.id}/${action}`),
      );
      this.applyScenario(updated);
      this.toasts.success(current.archived_at ? this.t('tests.unarchiveSuccess') : this.t('tests.archiveSuccess'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  // ---- Runs ----

  protected async runNow(): Promise<void> {
    const id = this.testId();
    this.running.set(true);
    try {
      const run = await firstValueFrom(this.api.post<RunDetail>(`api/combat/tests/${id}/run`));
      this.latestRun.set(run);
      this.activeTab.set('results');
      await this.loadRuns(id);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.running.set(false);
    }
  }

  protected async viewRun(runId: number): Promise<void> {
    try {
      const run = await firstValueFrom(this.api.get<RunDetail>(`api/combat/runs/${runId}`));
      this.latestRun.set(run);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  // ---- Loading ----

  protected async load(id: number): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const scenario = await firstValueFrom(this.api.get<ScenarioDetail>(`api/combat/tests/${id}`));
      this.applyScenario(scenario);
      await this.loadRuns(id);
      const latest = this.runs()[0];
      if (latest) {
        await this.viewRun(latest.id);
      } else {
        this.latestRun.set(null);
      }
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRuns(id: number): Promise<void> {
    try {
      const runs = await firstValueFrom(this.api.get<RunSummary[]>(`api/combat/tests/${id}/runs`));
      this.runs.set(runs);
    } catch {
      this.runs.set([]);
    }
  }

  private applyScenario(scenario: ScenarioDetail): void {
    this.scenario.set(scenario);
    this.savedDefinition.set(scenario.definition);
    this.draft.set(scenario.definition);
  }

  // ---- Formatting ----

  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  protected formatSeconds(value: number): string {
    return `${value.toFixed(1)}s`;
  }

  protected formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
  }

  protected formatMultiplier(value: number): string {
    return `×${value.toFixed(2)}`;
  }
}
