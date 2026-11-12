import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';

import type {
  AdjustProgressionRequest,
  AlbionGuildMember,
  AlbionLinkStatus,
  LeaderboardEntry,
  PaginatedData,
  PlayerReport,
  ProgressionMeView,
  UserProfile,
  UserRolesView,
  WarnSeverity,
  WarnView,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { BlockUserDialog } from './block-user-dialog';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';
import { WeaponRoster } from '../../shared/components/weapon-roster/weapon-roster';
import { matchesAlbionName, searchAlbionPlayers } from '../../shared/albion/albion-player-search';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

interface AdjustDraft {
  addXp: string;
  setLevel: string;
  setMultiplier: string;
  expiresAt: string;
  reason: string;
}

/** The sections of a member page. `progression` and `warns` need their permission. */
type UserDetailTab = 'overview' | 'combat' | 'weapons' | 'progression' | 'warns';

type WeeklyRow = PlayerReport['weekly'][number];

const USER_DETAIL_TABS: readonly UserDetailTab[] = [
  'overview',
  'combat',
  'weapons',
  'progression',
  'warns',
];

function isUserDetailTab(id: string): id is UserDetailTab {
  return (USER_DETAIL_TABS as readonly string[]).includes(id);
}

function emptyAdjustDraft(): AdjustDraft {
  return { addXp: '', setLevel: '', setMultiplier: '', expiresAt: '', reason: '' };
}

function asPaginated<T>(data: PaginatedData<T> | T[]): T[] {
  return Array.isArray(data) ? data : (data.items ?? []);
}

/**
 * Admin and officer member detail page.
 *
 * One record, so it uses the entity header: the status and role chips, the season XP band, and
 * the overflow menu (adjust, unlink, block or unblock). Sections switch with tabs: overview
 * (Albion link and Discord roles), combat intel, weapons, progression adjustment and warns.
 */
@Component({
  selector: 'app-user-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BlockUserDialog,
    DataTable,
    DataTableCell,
    DatePipe,
    DecimalPipe,
    Dialog,
    EntityHeader,
    ErrorState,
    FilterBar,
    Icon,
    Loading,
    PageStack,
    RouterLink,
    SearchableSelect,
    Stat,
    StatusChip,
    SummaryBand,
    Tabs,
    TooltipDirective,
    WeaponRoster,
  ],
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (notFound() || !member()) {
      <app-error-state
        variant="not-found"
        [message]="t('users.detail.notFound')"
        [hint]="t('ui.errorState.notFoundHint')"
      >
        <a class="btn btn--outline btn--sm" routerLink="/users">
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('users.detail.back') }}
        </a>
      </app-error-state>
    } @else if (member(); as user) {
      <app-page-stack>
        <div>
          <a class="btn btn--ghost btn--sm" routerLink="/users">
            <app-icon name="chevron-left" size="0.875rem" />
            {{ t('users.detail.back') }}
          </a>
        </div>

        <app-entity-header
          [title]="user.username"
          [menuItems]="menuItems()"
          [menuLabel]="t('entityHeader.moreActions')"
          (menuSelect)="onMenu($event)"
        >
          <span entityBadges class="inline-flex flex-wrap items-center gap-1.5">
            <app-status-chip
              [value]="user.blocked ? 'blocked' : 'active'"
              [label]="user.blocked ? t('users.status.blocked') : t('users.status.active')"
              [toneOverride]="user.blocked ? 'error' : 'neutral'"
              [icon]="user.blocked ? 'user-x' : undefined"
            />
            <app-status-chip [value]="user.role" />
          </span>

          <div entityMeta class="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>{{ user.email || t('common.noEmail') }}</span>
            <span class="mono">ID #{{ user.id }}</span>
          </div>

          <div entitySummary>
            <app-summary-band [ariaLabel]="t('profile.xp.title')">
              <app-stat [label]="t('profile.xp.level')" [value]="progression()?.level ?? 1" />
              <app-stat [label]="t('profile.xp.xp')" [value]="formatAmount(progression()?.xp ?? 0)" />
              <app-stat
                [label]="t('profile.xp.multiplier')"
                [value]="'×' + formatMultiplier(progression()?.multiplier ?? 1)"
              />
              <app-stat
                [label]="t('profile.xp.rank')"
                [value]="progression()?.rank != null ? '#' + progression()?.rank : t('profile.xp.unranked')"
              />
            </app-summary-band>
          </div>
        </app-entity-header>

        @if (user.blocked) {
          <section class="card p-4" role="status" aria-labelledby="member-blocked-heading">
            <div class="flex items-start gap-3">
              <app-icon name="user-x" size="1.25rem" color="var(--color-error)" />
              <div class="min-w-0">
                <h2 id="member-blocked-heading" class="text-sm font-semibold" style="color: var(--color-error)">
                  {{ t('users.blocked.banner') }}
                </h2>
                <p class="hint mt-1">
                  {{ t('users.blocked.by', { date: (user.blocked_at | date: 'mediumDate') ?? '', name: user.blocked_by ?? '' }) }}
                </p>
                @if (user.blocked_reason) {
                  <p class="hint mt-1">{{ t('users.blocked.reason', { reason: user.blocked_reason }) }}</p>
                }
              </div>
            </div>
          </section>
        }

        <app-tabs
          [options]="tabOptions()"
          [active]="activeTab()"
          [ariaLabel]="t('users.detail.sections')"
          (activeChange)="onTabChange($event)"
        />

        <!-- ================= OVERVIEW ================= -->
        @if (activeTab() === 'overview') {
          <section class="card p-4 grid gap-3" aria-labelledby="member-albion-heading">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <h2 id="member-albion-heading" class="section-title">{{ t('albion.title') }}</h2>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <app-status-chip
                  [value]="albionLink()?.linked ? 'linked' : 'not_linked'"
                  [label]="albionLinkText()"
                  [toneOverride]="albionLink()?.linked ? 'success' : 'warning'"
                />
                @if (canManageLinks()) {
                  <button type="button" class="btn btn--outline btn--sm" (click)="openLinkDialog()">
                    {{ albionLink()?.linked ? t('users.link.change') : t('albion.link_now') }}
                  </button>
                }
              </div>
            </div>
          </section>

          <section class="card p-4 grid gap-3" aria-labelledby="member-roles-heading">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 id="member-roles-heading" class="section-title">{{ t('users.roles.title') }}</h2>
                <p class="hint mt-1">{{ t('users.roles.hint') }}</p>
              </div>
              @if (canManageRoles() && memberRoles()?.discord_id && addableRoleOptions().length > 0) {
                <div class="min-w-56 flex-1 sm:max-w-xs">
                  <app-searchable-select
                    [options]="addableRoleOptions()"
                    [value]="pendingAddRoleId()"
                    [emptyLabel]="t('users.roles.add')"
                    [searchPlaceholder]="t('common.search')"
                    [noMatchesLabel]="t('picker.noMatches')"
                    [emptyOptionsLabel]="t('picker.empty')"
                    [ariaLabel]="t('users.roles.add')"
                    [disabled]="roleSaving()"
                    (valueChange)="addRole($event)"
                  />
                </div>
              }
            </div>

            @if (rolesLoading()) {
              <app-loading variant="spinner" [label]="t('common.loading')" />
            } @else if (rolesLoadFailed()) {
              <app-error-state
                [message]="t('users.roles.loadError')"
                [retryLabel]="t('common.retry')"
                (retry)="loadRoles()"
              />
            } @else if (!memberRoles()?.discord_id) {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('users.roles.noDiscord') }}</p>
            } @else if (heldRoles().length === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('users.roles.empty') }}</p>
            } @else {
              <ul class="flex flex-wrap gap-2" role="list">
                @for (role of heldRoles(); track role.role_id) {
                  <li class="chip chip--neutral inline-flex items-center gap-1.5">
                    <span>{{ role.role_name }}</span>
                    @if (role.is_staff) {
                      <span class="hint">{{ t('users.roles.staffAuto') }}</span>
                    }
                    @if (canManageRoles() && role.assignable) {
                      <button
                        type="button"
                        class="inline-flex cursor-pointer"
                        [disabled]="roleSaving()"
                        [attr.aria-label]="t('users.roles.remove') + ' ' + role.role_name"
                        [appTooltip]="t('users.roles.remove')"
                        tooltipPosition="top"
                        (click)="removeRole(role.role_id)"
                      >
                        <app-icon name="close" size="0.75rem" />
                      </button>
                    }
                  </li>
                }
              </ul>
            }
          </section>
        }

        <!-- ================= COMBAT ================= -->
        @if (activeTab() === 'combat') {
          @if (canViewPlayerIntel()) {
            <section class="card p-4 grid gap-4" aria-labelledby="player-intel-heading">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0">
                  <h2 id="player-intel-heading" class="section-title">{{ t('intel.player.title') }}</h2>
                  <p class="hint mt-1">{{ t('intel.player.hint') }}</p>
                </div>
                <a class="btn btn--ghost btn--sm" routerLink="/intel">{{ t('intel.player.viewFullReport') }}</a>
              </div>

              @if (playerIntelLoading()) {
                <app-loading variant="summary" [label]="t('common.loading')" />
              } @else if (playerIntel(); as pi) {
                @if (!pi.linked) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.notLinked') }}</p>
                }

                <app-summary-band [ariaLabel]="t('intel.player.title')">
                  <app-stat [label]="t('intel.fights')" [value]="pi.member.fights" />
                  <app-stat
                    label="K/D"
                    [value]="pi.member.kill_death_ratio | number: '1.2-2'"
                    [hint]="pi.member.kills + ' / ' + pi.member.deaths"
                  />
                  <app-stat [label]="t('intel.streak')" [value]="pi.win_streak" />
                  <app-stat [label]="t('intel.silverLost')" [value]="formatAmount(pi.member.silver_lost)" />
                  <app-stat [label]="t('intel.splitEarnings')" [value]="formatAmount(pi.member.split_earnings)" />
                  <app-stat
                    [label]="t('intel.fillRate')"
                    [value]="(pi.member.fill_rate | number: '1.0-0') + '%'"
                    [hint]="pi.member.events_signed + ' ' + t('intel.events')"
                  />
                </app-summary-band>

                @if (pi.weekly.length > 0) {
                  <div class="grid gap-2">
                    <h3 class="text-sm font-semibold" style="color: var(--color-text)">{{ t('intel.player.weekly') }}</h3>
                    <app-data-table
                      [columns]="weeklyColumns"
                      [rows]="pi.weekly"
                      [trackBy]="trackWeek"
                      [hideSearch]="true"
                      [hidePageSize]="true"
                      [syncUrl]="false"
                      [ariaLabel]="t('intel.player.weekly')"
                    >
                      <ng-template dataTableCell="week" let-row>
                        {{ row.week_start | date: 'mediumDate' }}
                      </ng-template>
                      <ng-template dataTableCell="fights" let-row>
                        <span class="num">{{ row.fights }}</span>
                      </ng-template>
                      <ng-template dataTableCell="record" let-row>
                        <span class="num">{{ row.wins }}–{{ row.losses }}</span>
                      </ng-template>
                      <ng-template dataTableCell="winRate" let-row>
                        <span class="num">{{ row.win_rate | number: '1.0-0' }}%</span>
                      </ng-template>
                      <ng-template dataTableCell="kills" let-row>
                        <span class="num">{{ row.kills }}</span>
                      </ng-template>
                      <ng-template dataTableCell="silverLost" let-row>
                        <span class="num">{{ formatAmount(row.silver_lost) }}</span>
                      </ng-template>
                    </app-data-table>
                  </div>
                }

                @if (pi.recent_fights.length > 0) {
                  <div class="grid gap-2">
                    <h3 class="text-sm font-semibold" style="color: var(--color-text)">{{ t('intel.player.recentFights') }}</h3>
                    <ul class="grid gap-1.5">
                      @for (fight of pi.recent_fights; track fight.battle_id) {
                        <li>
                          <a
                            class="flex items-center justify-between gap-3 rounded-[var(--radius-md)] px-3 py-2 no-underline transition-colors hover:opacity-90"
                            [style.background-color]="fight.is_win ? 'var(--color-success-container)' : 'var(--color-error-container)'"
                            [routerLink]="['/battles', fight.battle_id]"
                          >
                            <span class="text-xs font-semibold" [style.color]="fight.is_win ? 'var(--color-success)' : 'var(--color-error)'">
                              {{ fight.is_win ? t('common.win') : t('common.loss') }}
                            </span>
                            <span class="min-w-0 flex-1 truncate text-sm px-2" style="color: var(--color-text)">
                              {{ fight.opponent ?? t('intel.unknownOpponent') }}
                            </span>
                            <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                              {{ fight.kills }}k / {{ fight.deaths }}d
                            </span>
                            <span class="mono shrink-0 text-xs" style="color: var(--color-text-secondary)">
                              {{ fight.started_at | date: 'MMM d' }}
                            </span>
                          </a>
                        </li>
                      }
                    </ul>
                  </div>
                }
              } @else {
                <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.player.noFights') }}</p>
              }
            </section>
          } @else if (ownStanding(); as standing) {
            <section class="card p-4 grid gap-4" aria-labelledby="own-standing-heading">
              <div>
                <h2 id="own-standing-heading" class="section-title">{{ t('intel.player.ownStanding.title') }}</h2>
                <p class="hint mt-1">{{ t('intel.player.ownStanding.hint') }}</p>
              </div>
              @if (standing.length > 0) {
                <app-summary-band [ariaLabel]="t('intel.player.ownStanding.title')">
                  @for (board of standing; track board.key) {
                    <app-stat [label]="board.label" [value]="'#' + board.rank" [hint]="formatAmount(board.value)" />
                  }
                </app-summary-band>
              } @else {
                <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.player.ownStanding.unranked') }}</p>
              }
            </section>
          }
        }

        <!-- ================= WEAPONS ================= -->
        @if (activeTab() === 'weapons') {
          <app-weapon-roster mode="manage" [userId]="user.id" [editable]="canManageWeapons()" />
        }

        <!-- ================= PROGRESSION ================= -->
        @if (activeTab() === 'progression') {
          <form class="card p-4 grid gap-4" aria-labelledby="member-adjust-heading" (submit)="onAdjustSubmit($event)">
            <div>
              <h2 id="member-adjust-heading" class="section-title">{{ t('users.adjust.title') }}</h2>
              <p class="hint mt-1">{{ t('users.adjust.hint') }}</p>
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <label class="grid gap-1.5">
                <span class="label">{{ t('users.adjust.addXp') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  [placeholder]="t('users.adjust.addXpPlaceholder')"
                  [value]="draft().addXp"
                  (input)="updateDraft('addXp', $event)"
                />
              </label>
              <label class="grid gap-1.5">
                <span class="label">{{ t('users.adjust.setLevel') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="1"
                  [placeholder]="t('users.adjust.setLevelPlaceholder')"
                  [value]="draft().setLevel"
                  (input)="updateDraft('setLevel', $event)"
                />
              </label>
              <label class="grid gap-1.5">
                <span class="label">{{ t('users.adjust.setMultiplier') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  [placeholder]="t('users.adjust.setMultiplierPlaceholder')"
                  [value]="draft().setMultiplier"
                  (input)="updateDraft('setMultiplier', $event)"
                />
              </label>
              <label class="grid gap-1.5">
                <span class="label">{{ t('users.adjust.expires') }}</span>
                <input
                  class="input w-full"
                  type="datetime-local"
                  [value]="draft().expiresAt"
                  (input)="updateDraft('expiresAt', $event)"
                />
              </label>
            </div>

            <label class="grid gap-1.5">
              <span class="label">
                {{ t('users.adjust.reason') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input
                class="input w-full"
                required
                [placeholder]="t('users.adjust.reasonPlaceholder')"
                [value]="draft().reason"
                (input)="updateDraft('reason', $event)"
              />
            </label>

            <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-3" style="border-color: var(--color-border)">
              <p class="hint">{{ t('validation.requiredLegend') }}</p>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
                {{ t('users.adjust.submit') }}
              </button>
            </div>
          </form>
        }

        <!-- ================= WARNS ================= -->
        @if (activeTab() === 'warns') {
          <app-data-table
            [columns]="warnColumns"
            [rows]="warns()"
            [trackBy]="trackWarn"
            [bordered]="true"
            [hideSearch]="true"
            [hidePageSize]="true"
            [syncUrl]="false"
            [emptyLabel]="'users.warns.empty'"
            [ariaLabel]="t('users.warns.title')"
            mobileLayout="stack"
          >
            <ng-template dataTableCell="severity" let-row>
              <app-status-chip
                [value]="row.severity"
                [label]="severityLabel(row.severity)"
                [toneOverride]="severityTone(row.severity)"
              />
            </ng-template>
            <ng-template dataTableCell="reason" let-row>
              <span class="whitespace-pre-line">{{ row.reason }}</span>
            </ng-template>
            <ng-template dataTableCell="issued" let-row>
              <span class="num">{{ row.created_at | date: 'medium' }}</span>
            </ng-template>
            <ng-template dataTableCell="status" let-row>
              <app-status-chip
                [value]="row.revoked_at ? 'revoked' : 'active'"
                [label]="row.revoked_at ? t('warns.revoked') : t('warns.active')"
                [toneOverride]="'neutral'"
              />
            </ng-template>
          </app-data-table>
        }
      </app-page-stack>
    }

    <!-- Adjust Progression Confirmation Dialog -->
    @if (confirmOpen()) {
      <app-dialog [title]="t('users.adjust.confirm')" size="sm" (closed)="closeConfirm()">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('users.adjust.hint') }}
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline btn--sm" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--primary btn--sm" (click)="confirmAdjust()" [disabled]="saving()">
            {{ t('users.adjust.submit') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Admin Link Albion Character Dialog -->
    @if (linkDialogOpen()) {
      <app-dialog [title]="t('albion.link_now')" (closed)="closeLinkDialog()">
        <div class="grid gap-3">
          <p class="hint">
            {{ t('users.link.hint', { username: member()?.username ?? '' }) }}
          </p>

          <app-filter-bar
            [searchLabel]="t('users.link.searchLabel')"
            [searchPlaceholder]="t('users.link.searchPlaceholder')"
            [query]="rosterSearch()"
            (queryChange)="onRosterSearch($event)"
          />

          @if (rosterLoading()) {
            <app-loading variant="lines" [rows]="3" [label]="t('users.link.loadingRoster')" />
          } @else {
            @if (rosterSearching()) {
              <p class="hint" role="status">{{ t('common.loading') }}</p>
            }
            <div class="max-h-64 overflow-y-auto grid gap-1.5 pr-1">
              @for (player of filteredRoster(); track player.id) {
                <button
                  type="button"
                  class="flex items-center justify-between gap-3 p-2.5 rounded-[var(--radius-cards)] border text-left transition-colors hover:border-primary"
                  style="border-color: var(--color-border); background: var(--color-surface-1)"
                  (click)="confirmLink(player)"
                  [disabled]="savingLink()"
                >
                  <div class="min-w-0">
                    <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                      {{ player.name }}
                    </p>
                    <p class="hint">
                      @if (player.guild_name) {
                        {{ player.guild_name }} ·
                      }
                      ID: {{ player.id }}
                    </p>
                  </div>
                  <span class="text-xs font-medium shrink-0" style="color: var(--color-primary)">
                    {{ t('dashboard.attention.link_albion_action') }}
                  </span>
                </button>
              } @empty {
                <p class="text-sm text-center py-4" style="color: var(--color-text-secondary)">
                  {{ t('settings.albion.noPlayers') }}
                </p>
              }
            </div>
          }
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline btn--sm" (click)="closeLinkDialog()">
            {{ t('common.cancel') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Block or unblock the member -->
    @if (blockMode(); as mode) {
      @if (member(); as target) {
        <app-block-user-dialog
          [member]="target"
          [mode]="mode"
          (updated)="member.set($event)"
          (closed)="blockMode.set(null)"
        />
      }
    }

    <!-- Unlink Albion Character Confirmation Dialog -->
    @if (unlinkConfirmOpen()) {
      <app-dialog [title]="t('settings.albion.unlinkConfirmTitle')" size="sm" (closed)="unlinkConfirmOpen.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('users.link.unlinkConfirm', { name: albionLink()?.albion_player_name ?? '', username: member()?.username ?? '' }) }}
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline btn--sm" (click)="unlinkConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger btn--sm" (click)="confirmUnlink()" [disabled]="savingLink()">
            {{ t('settings.albion.unlinkConfirmTitle') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class UserDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly intel = inject(IntelService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly userId = input.required<string>();

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  /** The API answered 404: the member does not exist. Rendered as a not-found state, not an error. */
  protected readonly notFound = signal(false);
  protected readonly saving = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly member = signal<UserProfile | null>(null);
  protected readonly tab = signal<UserDetailTab>('overview');
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly warns = signal<WarnView[]>([]);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly draft = signal<AdjustDraft>(emptyAdjustDraft());

  protected readonly playerIntel = signal<PlayerReport | null>(null);
  protected readonly playerIntelLoading = signal(false);
  protected readonly ownStanding = signal<
    { key: string; label: string; rank: number; value: number }[] | null
  >(null);

  // Albion Link Management State
  protected readonly linkDialogOpen = signal(false);
  protected readonly unlinkConfirmOpen = signal(false);
  /** Which block/unblock dialog is open, if any. */
  protected readonly blockMode = signal<'block' | 'unblock' | null>(null);
  protected readonly rosterLoading = signal(false);
  protected readonly savingLink = signal(false);
  protected readonly rosterSearch = signal('');
  protected readonly rosterMembers = signal<AlbionGuildMember[]>([]);
  /** Matches from the all-players search for the current text (guild members ranked first). */
  protected readonly rosterMatches = signal<AlbionGuildMember[]>([]);
  protected readonly rosterSearching = signal(false);
  private rosterSearchTimer: ReturnType<typeof setTimeout> | undefined;
  private rosterSearchRequest = 0;

  private pendingBody: AdjustProgressionRequest | null = null;

  protected readonly canAdjust = computed(() => this.auth.hasPermission('progression.adjust'));
  protected readonly canViewWarns = computed(() => this.auth.hasPermission('warns.view'));
  /**
   * Same gate as `/intel` itself (`intel.report.view`): the per-player report
   * surfaces the identical silver/split figures the guild report's roster
   * table already shows for every member, just isolated to one row.
   */
  protected readonly canViewPlayerIntel = computed(() => this.auth.hasPermission('intel.report.view'));
  /** Declaring and locking another member's weapons takes `users.weapons.manage`. */
  protected readonly canManageWeapons = computed(() =>
    this.auth.hasPermission('users.weapons.manage'),
  );

  protected readonly canManageLinks = computed(
    () =>
      this.auth.hasPermission('roles.manage') ||
      this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly canManageRoles = computed(() => this.auth.hasPermission('roles.manage'));
  /** Blocking is gated by `roles.manage`, like role assignment. */
  protected readonly canBlock = computed(() => this.auth.hasPermission('roles.manage'));
  protected readonly ownUserId = computed(() => this.auth.profile()?.user_id ?? null);

  protected readonly memberRoles = signal<UserRolesView | null>(null);
  protected readonly rolesLoading = signal(false);
  protected readonly rolesLoadFailed = signal(false);
  protected readonly roleSaving = signal(false);
  protected readonly pendingAddRoleId = signal('');

  protected readonly heldRoles = computed(
    () => this.memberRoles()?.roles.filter((role) => role.held) ?? [],
  );
  protected readonly addableRoleOptions = computed(() =>
    (this.memberRoles()?.roles ?? [])
      .filter((role) => role.assignable && !role.held)
      .map((role) => ({ id: role.role_id, label: role.role_name })),
  );

  /**
   * Guild roster hits first (instant, case/diacritic-insensitive), then everyone else Albion
   * knows about from the global search, so a character outside the guild can be linked too.
   */
  protected readonly filteredRoster = computed(() => {
    const q = this.rosterSearch().trim();
    if (!q) return this.rosterMembers().slice(0, 30);
    const local = this.rosterMembers().filter((m) => matchesAlbionName(m.name, q));
    const seen = new Set(local.map((m) => m.id));
    const remote = this.rosterMatches().filter((m) => !seen.has(m.id));
    return [...local, ...remote].slice(0, 40);
  });

  /** The combat tab exists for officers (full report) and for a member viewing their own standing. */
  protected readonly showCombatTab = computed(
    () => this.canViewPlayerIntel() || this.ownStanding() !== null,
  );

  protected readonly tabOptions = computed<readonly TabOption[]>(() => {
    const options: TabOption[] = [{ id: 'overview', label: this.t('users.detail.tab.overview') }];
    if (this.showCombatTab()) {
      options.push({ id: 'combat', label: this.t('users.detail.tab.combat') });
    }
    options.push({ id: 'weapons', label: this.t('users.detail.tab.weapons') });
    if (this.canAdjust()) {
      options.push({ id: 'progression', label: this.t('users.detail.tab.progression') });
    }
    if (this.canViewWarns()) {
      options.push({ id: 'warns', label: this.t('users.warns.title'), count: this.warns().length });
    }
    return options;
  });

  /** The tab on screen; falls back to the overview when the requested section is not offered. */
  protected readonly activeTab = computed<UserDetailTab>(() => {
    const current = this.tab();
    return this.tabOptions().some((option) => option.id === current) ? current : 'overview';
  });

  /** Secondary actions. Block is the only destructive entry; it sits last, after a separator. */
  protected readonly menuItems = computed<EntityMenuItem[]>(() => {
    const user = this.member();
    if (!user) return [];
    const items: EntityMenuItem[] = [];
    if (this.canAdjust()) {
      items.push({ id: 'adjust', label: this.t('users.adjust.title') });
    }
    if (this.canManageLinks() && this.albionLink()?.linked) {
      items.push({ id: 'unlink', label: this.t('albion.unlink') });
    }
    if (this.canBlock() && user.id !== this.ownUserId()) {
      items.push(
        user.blocked
          ? { id: 'unblock', label: this.t('users.unblock.action'), separatorBefore: true }
          : { id: 'block', label: this.t('users.block.action'), danger: true, separatorBefore: true },
      );
    }
    return items;
  });

  protected readonly weeklyColumns: readonly DataTableColumn<WeeklyRow>[] = [
    { key: 'week', label: 'intel.trends.week' },
    { key: 'fights', label: 'intel.fights', align: 'right' },
    { key: 'record', label: 'intel.record', align: 'right' },
    { key: 'winRate', label: 'intel.winRate', align: 'right' },
    { key: 'kills', label: 'intel.kills', align: 'right' },
    { key: 'silverLost', label: 'intel.silverLost', align: 'right' },
  ];

  protected readonly warnColumns: readonly DataTableColumn<WarnView>[] = [
    { key: 'severity', label: 'warns.severity' },
    { key: 'reason', label: 'warns.reason' },
    { key: 'issued', label: 'warns.issued' },
    { key: 'status', label: 'warns.status' },
  ];

  protected readonly trackWeek = (row: WeeklyRow): string => row.week_start;
  protected readonly trackWarn = (row: WarnView): number => row.id;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /**
   * `userId` is a route-bound input, not a one-time constructor param.
   * Angular's default route-reuse strategy keeps this component instance
   * alive across navigations within the same route config (e.g. clicking
   * from one member's roster row to another's) — without watching the
   * signal here, the URL and `userId()` change but the page keeps showing
   * the previous member until a hard refresh.
   */
  constructor() {
    effect(() => {
      this.userId();
      untracked(() => {
        this.tab.set('overview');
        this.closeConfirm();
        this.linkDialogOpen.set(false);
        this.unlinkConfirmOpen.set(false);
        this.blockMode.set(null);
        this.playerIntel.set(null);
        this.ownStanding.set(null);
        this.memberRoles.set(null);
        this.pendingAddRoleId.set('');
        void this.load();
      });
    });
  }

  protected severityLabel(severity: WarnSeverity): string {
    if (severity === 'strike') return this.t('warns.severity.strike');
    if (severity === 'warn') return this.t('warns.severity.warn');
    return this.t('warns.severity.note');
  }

  protected severityTone(severity: WarnSeverity): 'error' | 'warning' | 'neutral' {
    if (severity === 'strike') return 'error';
    if (severity === 'warn') return 'warning';
    return 'neutral';
  }

  protected albionLinkText(): string {
    const link = this.albionLink();
    return link?.linked
      ? this.t('albion.linked', { name: link.albion_player_name ?? '' })
      : this.t('albion.not_linked');
  }

  protected formatAmount(value: number): string {
    return new Intl.NumberFormat().format(value);
  }

  protected formatMultiplier(value: string | number): string {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      return String(value);
    }
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  protected onTabChange(id: string): void {
    if (isUserDetailTab(id)) {
      this.tab.set(id);
    }
  }

  protected onMenu(id: string): void {
    switch (id) {
      case 'adjust':
        this.tab.set('progression');
        break;
      case 'unlink':
        this.askUnlink();
        break;
      case 'block':
        this.blockMode.set('block');
        break;
      case 'unblock':
        this.blockMode.set('unblock');
        break;
    }
  }

  protected updateDraft(field: keyof AdjustDraft, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.update((current) => ({ ...current, [field]: value }));
  }

  protected closeConfirm(): void {
    this.confirmOpen.set(false);
    this.pendingBody = null;
  }

  protected onAdjustSubmit(event: Event): void {
    event.preventDefault();
    if (!this.canAdjust() || this.saving()) {
      return;
    }
    const member = this.member();
    if (!member) {
      return;
    }
    const draft = this.draft();
    const reason = draft.reason.trim();
    if (!reason) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const body: AdjustProgressionRequest = { reason };
    if (draft.addXp.trim() !== '') {
      body.add_xp = Number(draft.addXp);
    }
    if (draft.setLevel.trim() !== '') {
      body.set_level = Number(draft.setLevel);
    }
    if (draft.setMultiplier.trim() !== '') {
      body.set_multiplier = Number(draft.setMultiplier);
    }
    if (draft.expiresAt.trim() !== '') {
      body.multiplier_expires_at = new Date(draft.expiresAt).toISOString();
    }
    if (
      body.add_xp === undefined &&
      body.set_level === undefined &&
      body.set_multiplier === undefined
    ) {
      this.toasts.error(this.t('users.adjust.hint'));
      return;
    }
    this.pendingBody = body;
    this.confirmOpen.set(true);
  }

  protected async confirmAdjust(): Promise<void> {
    const member = this.member();
    const body = this.pendingBody;
    if (!member || !body || this.saving()) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<ProgressionMeView>(`api/progression/users/${member.id}/adjust`, body),
      );
      this.progression.set(updated);
      this.draft.set(emptyAdjustDraft());
      this.closeConfirm();
      this.toasts.success(this.t('users.adjust.success'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async openLinkDialog(): Promise<void> {
    this.linkDialogOpen.set(true);
    this.rosterSearch.set('');
    if (this.rosterMembers().length === 0) {
      this.rosterLoading.set(true);
      try {
        const roster = await firstValueFrom(
          this.api.get<PaginatedData<AlbionGuildMember> | AlbionGuildMember[]>(
            'api/albion/guild/roster',
            { limit: 1000 },
          ),
        );
        this.rosterMembers.set(asPaginated(roster));
      } catch {
        this.toasts.error(this.t('events.roster.loadFailed'));
      } finally {
        this.rosterLoading.set(false);
      }
    }
  }

  protected closeLinkDialog(): void {
    this.linkDialogOpen.set(false);
    this.rosterSearch.set('');
    this.rosterMatches.set([]);
    clearTimeout(this.rosterSearchTimer);
  }

  /** Receives the roster search text from the filter bar. */
  protected onRosterSearch(text: string): void {
    this.rosterSearch.set(text);
    clearTimeout(this.rosterSearchTimer);
    const query = text.trim();
    const request = ++this.rosterSearchRequest;
    if (!query) {
      this.rosterMatches.set([]);
      this.rosterSearching.set(false);
      return;
    }
    this.rosterSearching.set(true);
    this.rosterSearchTimer = setTimeout(() => {
      void searchAlbionPlayers(this.api, query)
        .then((players) => {
          if (request === this.rosterSearchRequest) {
            this.rosterMatches.set(
              players.map((p) => ({ id: p.id, name: p.name, guild_name: p.guild_name })),
            );
          }
        })
        .catch(() => {
          // The guild roster hits are still listed; a failed global search must not block them.
          if (request === this.rosterSearchRequest) {
            this.rosterMatches.set([]);
          }
        })
        .finally(() => {
          if (request === this.rosterSearchRequest) {
            this.rosterSearching.set(false);
          }
        });
    }, 250);
  }

  protected async confirmLink(player: AlbionGuildMember): Promise<void> {
    const member = this.member();
    if (!member || this.savingLink()) return;

    this.savingLink.set(true);
    try {
      const linkStatus = await firstValueFrom(
        this.api.post<AlbionLinkStatus>(`api/albion/link/users/${member.id}`, {
          albion_player_id: player.id,
          albion_player_name: player.name,
        }),
      );
      this.albionLink.set(linkStatus);
      this.closeLinkDialog();
      this.toasts.success(this.t('users.link.success', { name: player.name, username: member.username }));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.savingLink.set(false);
    }
  }

  protected askUnlink(): void {
    this.unlinkConfirmOpen.set(true);
  }

  protected async confirmUnlink(): Promise<void> {
    const member = this.member();
    if (!member || this.savingLink()) return;

    this.savingLink.set(true);
    try {
      await firstValueFrom(this.api.delete<void>(`api/albion/link/users/${member.id}`));
      this.albionLink.set(null);
      this.unlinkConfirmOpen.set(false);
      this.toasts.success(this.t('albionSettings.link.unlinked'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.savingLink.set(false);
    }
  }

  protected async loadRoles(userId = Number(this.userId())): Promise<void> {
    if (!Number.isFinite(userId) || userId <= 0) return;
    this.rolesLoading.set(true);
    this.rolesLoadFailed.set(false);
    try {
      const roles = await firstValueFrom(this.api.get<UserRolesView>(`api/users/${userId}/roles`));
      this.memberRoles.set(roles);
      if (roles.highest_role) {
        this.member.update((current) =>
          current ? { ...current, role: roles.highest_role } : current,
        );
      }
    } catch {
      this.memberRoles.set(null);
      this.rolesLoadFailed.set(true);
    } finally {
      this.rolesLoading.set(false);
    }
  }

  protected async addRole(roleId: string): Promise<void> {
    const member = this.member();
    if (!member || !roleId || !this.canManageRoles() || this.roleSaving()) {
      this.pendingAddRoleId.set('');
      return;
    }
    this.roleSaving.set(true);
    this.pendingAddRoleId.set('');
    try {
      const updated = await firstValueFrom(
        this.api.post<UserRolesView>(`api/users/${member.id}/roles`, { role_id: roleId }),
      );
      this.memberRoles.set(updated);
      this.member.update((current) =>
        current ? { ...current, role: updated.highest_role } : current,
      );
      this.toasts.success(this.t('users.roles.added'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.roleSaving.set(false);
    }
  }

  protected async removeRole(roleId: string): Promise<void> {
    const member = this.member();
    if (!member || !this.canManageRoles() || this.roleSaving()) return;
    this.roleSaving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.delete<UserRolesView>(`api/users/${member.id}/roles/${encodeURIComponent(roleId)}`),
      );
      if (updated) {
        this.memberRoles.set(updated);
        this.member.update((current) =>
          current ? { ...current, role: updated.highest_role } : current,
        );
      }
      this.toasts.success(this.t('users.roles.removed'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.roleSaving.set(false);
    }
  }

  protected async loadPlayerIntel(userId: number): Promise<void> {
    this.playerIntelLoading.set(true);
    try {
      const report = await firstValueFrom(this.intel.playerReport(userId));
      this.playerIntel.set(report);
    } catch {
      // No combat record for this member in the window (404), or the caller
      // lost the permission mid-session — either way, just hide the section.
      this.playerIntel.set(null);
    } finally {
      this.playerIntelLoading.set(false);
    }
  }

  /**
   * A lighter standing panel for a member looking at their own profile
   * without `intel.report.view`. Backed by `/api/intel/leaderboards`, gated
   * only at `intel.view` deliberately, so every member can see where they
   * rank even without officer permissions.
   */
  protected async loadOwnStanding(): Promise<void> {
    const ownId = this.auth.profile()?.user_id;
    if (ownId == null || !this.auth.hasPermission('intel.view')) {
      this.ownStanding.set(null);
      return;
    }
    try {
      const leaderboards = await firstValueFrom(this.intel.leaderboards());
      const boards: { key: string; label: string; entries: LeaderboardEntry[] }[] = [
        { key: 'attendance', label: this.t('intel.trends.attendance'), entries: leaderboards.attendance },
        { key: 'kills', label: this.t('intel.kills'), entries: leaderboards.kills },
        { key: 'kill_fame', label: this.t('intel.killFame'), entries: leaderboards.kill_fame },
      ];
      const standing = boards
        .map(({ key, label, entries }) => {
          const rank = entries.findIndex((entry) => entry.user_id === ownId);
          return rank < 0 ? null : { key, label, rank: rank + 1, value: entries[rank].value };
        })
        .filter((row): row is { key: string; label: string; rank: number; value: number } => row !== null);
      this.ownStanding.set(standing);
    } catch {
      this.ownStanding.set(null);
    }
  }

  protected async load(): Promise<void> {
    const userId = Number(this.userId());
    if (!Number.isFinite(userId) || userId <= 0) {
      this.member.set(null);
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      const member = await firstValueFrom(this.api.get<UserProfile>(`api/users/${userId}`));
      this.member.set(member);

      void this.loadRoles(userId);

      const [xp, link] = await Promise.all([
        firstValueFrom(this.api.get<ProgressionMeView>(`api/progression/users/${userId}`)).catch(
          () => null,
        ),
        firstValueFrom(this.api.get<AlbionLinkStatus>(`api/albion/link/users/${userId}`)).catch(
          () => null,
        ),
      ]);
      this.progression.set(xp);
      this.albionLink.set(link);

      if (this.canViewWarns()) {
        const warns = await firstValueFrom(
          this.api.get<PaginatedData<WarnView> | WarnView[]>('api/warns', {
            user_id: userId,
            page: 1,
            limit: 50,
          }),
        ).catch((): WarnView[] => []);
        this.warns.set(asPaginated(warns));
      }

      if (this.canViewPlayerIntel()) {
        void this.loadPlayerIntel(userId);
      } else if (this.auth.profile()?.user_id === userId) {
        void this.loadOwnStanding();
      } else {
        this.playerIntel.set(null);
        this.ownStanding.set(null);
      }
    } catch (error) {
      this.member.set(null);
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      } else {
        this.loadFailed.set(true);
      }
    } finally {
      this.loading.set(false);
    }
  }
}
