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
  Role,
  UserProfile,
  UserRolesView,
  UserSpecialization,
  WarnView,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { IntelService } from '../../core/services/intel.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import {
  mergeSpecializationNodes,
  type DestinyItemNode,
} from '../../shared/data/albion-destiny-board';
import { normalizeAlbionSpecializationKey } from '../../shared/data/albion-equipment-catalog';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
import { DestinyBoard } from '../../shared/components/destiny-board/destiny-board';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

interface AdjustDraft {
  addXp: string;
  setLevel: string;
  setMultiplier: string;
  expiresAt: string;
  reason: string;
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
 * Provides full management of the user's role, season XP adjustments, discipline
 * records (warns), and administrative Albion Online character link management.
 */
@Component({
  selector: 'app-user-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Avatar,
    DatePipe,
    DecimalPipe,
    DestinyBoard,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    StatCard,
    TooltipDirective,
  ],
  template: `
    @if (loading()) {
      <div class="p-8 flex justify-center">
        <app-loading [label]="t('common.loading')" />
      </div>
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!member()) {
      <app-empty-state icon="users" [message]="t('users.detail.notFound')" />
    } @else if (member(); as user) {
      <app-page-header [title]="user.username" [subtitle]="user.email">
        <a
          class="btn btn--ghost btn--sm flex items-center gap-1.5"
          routerLink="/users"
          [appTooltip]="t('users.detail.back')"
          tooltipPosition="bottom"
        >
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('users.detail.back') }}
        </a>

        @if (canAdjust()) {
          <button
            type="button"
            class="btn btn--outline btn--sm flex items-center gap-1.5"
            (click)="toggleEditing()"
            [appTooltip]="t('users.adjust.open')"
            tooltipPosition="bottom"
          >
            <app-icon name="sparkles" size="0.875rem" />
            {{ editing() ? t('common.close') : t('users.adjust.open') }}
          </button>
        }
      </app-page-header>

      <app-page-stack>
        <!-- User Profile Hero -->
        <section class="card p-6">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="flex items-center gap-4">
              <app-avatar
                [userId]="user.id"
                [username]="user.username"
                size="lg"
                shape="rounded"
              />
              <div>
                <div class="flex items-center gap-2">
                  <h1 class="text-xl font-bold tracking-tight" style="color: var(--color-text)">
                    {{ user.username }}
                  </h1>
                  <span class="chip" [class]="roleChip(user.role)">{{ user.role }}</span>
                </div>
                <p class="text-sm mt-0.5" style="color: var(--color-text-secondary)">
                  {{ user.email || 'Nessuna email registrata' }} · ID #{{ user.id }}
                </p>
              </div>
            </div>

            <!-- Albion Character Link Badge -->
            <div
              class="flex items-center gap-3 rounded-[var(--radius-cards)] p-3 border"
              style="background: var(--color-surface-2); border-color: var(--color-border)"
            >
              <div class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 rounded-full"
                  [style.background]="albionLink()?.linked ? 'var(--color-success)' : 'var(--color-warning)'"
                ></span>
                <div>
                  <p class="text-xs uppercase tracking-wider font-semibold" style="color: var(--color-text-secondary)">
                    Albion Online Link
                  </p>
                  <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                    {{ albionLink()?.linked ? albionLink()?.albion_player_name : 'Non collegato' }}
                  </p>
                </div>
              </div>

              @if (canManageLinks()) {
                <div class="flex items-center gap-1.5 ml-2">
                  @if (albionLink()?.linked) {
                    <button
                      type="button"
                      class="btn btn--outline btn--sm text-xs py-1 px-2.5"
                      (click)="askUnlink()"
                      [appTooltip]="'Scollega il personaggio Albion da questo utente'"
                      tooltipPosition="top"
                    >
                      Scollega
                    </button>
                  }
                  <button
                    type="button"
                    class="btn btn--primary btn--sm text-xs py-1 px-2.5 flex items-center gap-1"
                    (click)="openLinkDialog()"
                    [appTooltip]="albionLink()?.linked ? 'Modifica personaggio collegato' : 'Collega personaggio del roster'"
                    tooltipPosition="top"
                  >
                    <app-icon name="plus" size="0.75rem" />
                    {{ albionLink()?.linked ? 'Cambia' : 'Collega' }}
                  </button>
                </div>
              }
            </div>
          </div>
        </section>

        <section class="card p-6" aria-labelledby="member-roles-heading">
          <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h2 id="member-roles-heading" class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('users.roles.title') }}
              </h2>
              <p class="text-xs mt-1" style="color: var(--color-text-secondary)">
                {{ t('users.roles.hint') }}
              </p>
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
            <div class="p-4 flex justify-center">
              <app-loading [label]="t('common.loading')" />
            </div>
          } @else if (rolesLoadFailed()) {
            <app-error-state
              [message]="t('users.roles.loadError')"
              [retryLabel]="t('common.retry')"
              (retry)="loadRoles()"
            />
          } @else if (!memberRoles()?.discord_id) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('users.roles.noDiscord') }}
            </p>
          } @else if (heldRoles().length === 0) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('users.roles.empty') }}
            </p>
          } @else {
            <ul class="flex flex-wrap gap-2" role="list">
              @for (role of heldRoles(); track role.role_id) {
                <li
                  class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                  style="background: var(--color-surface-2); border: 1px solid var(--color-border); color: var(--color-text)"
                >
                  <span>{{ role.role_name }}</span>
                  @if (role.is_staff) {
                    <span style="color: var(--color-text-secondary)">{{ t('users.roles.staffAuto') }}</span>
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

        <!-- KPI Strip for Member -->
        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Member KPIs">
          <app-stat-card
            label="Livello Stagione"
            [value]="progression()?.level ?? 1"
            icon="trophy"
            tone="primary"
          />
          <app-stat-card
            label="XP Stagione"
            [value]="formatAmount(progression()?.xp ?? 0)"
            icon="sparkles"
            tone="neutral"
          />
          <app-stat-card
            label="Moltiplicatore XP"
            [value]="'×' + formatMultiplier(progression()?.multiplier ?? 1)"
            icon="activity"
            tone="warning"
          />
          <app-stat-card
            label="Rank Gilda"
            [value]="progression()?.rank != null ? '#' + progression()?.rank : 'N/A'"
            icon="shield"
            tone="success"
          />
        </section>

        <!-- Combat Intel -->
        @if (canViewPlayerIntel()) {
          <section class="card p-6" aria-labelledby="player-intel-heading">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 id="player-intel-heading" class="text-base font-semibold" style="color: var(--color-text)">
                  {{ t('intel.player.title') }}
                </h2>
                <p class="text-xs mt-1" style="color: var(--color-text-secondary)">{{ t('intel.player.hint') }}</p>
              </div>
              <a class="btn btn--ghost btn--sm" routerLink="/intel">{{ t('intel.player.viewFullReport') }}</a>
            </div>

            @if (playerIntelLoading()) {
              <div class="p-8 flex justify-center"><app-loading [label]="t('common.loading')" /></div>
            } @else if (playerIntel(); as pi) {
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-5">
                <app-stat-card [label]="t('intel.fights')" [value]="pi.member.fights.toString()" icon="swords" />
                <app-stat-card
                  label="K/D"
                  [value]="pi.member.kill_death_ratio | number: '1.2-2'"
                  [sub]="pi.member.kills + ' / ' + pi.member.deaths"
                />
                <app-stat-card [label]="t('intel.killFame')" [value]="formatAmount(pi.member.kill_fame)" icon="sparkles" />
                <app-stat-card
                  [label]="t('intel.streak')"
                  [value]="pi.win_streak.toString()"
                  [tone]="pi.win_streak > 0 ? 'success' : 'neutral'"
                />
                <app-stat-card [label]="t('intel.silverLost')" [value]="formatAmount(pi.member.silver_lost)" tone="warning" />
                <app-stat-card [label]="t('intel.splitEarnings')" [value]="formatAmount(pi.member.split_earnings)" tone="success" />
                <app-stat-card
                  [label]="t('intel.fillRate')"
                  [value]="(pi.member.fill_rate | number: '1.0-0') + '%'"
                  [sub]="pi.member.events_signed + ' ' + t('intel.events')"
                />
                @if (!pi.linked) {
                  <app-stat-card [label]="t('common.status')" [value]="t('intel.notLinked')" tone="warning" />
                }
              </div>

              @if (pi.weekly.length > 0) {
                <div class="overflow-x-auto mb-5">
                  <h3 class="text-sm font-medium mb-2" style="color: var(--color-text)">{{ t('intel.player.weekly') }}</h3>
                  <table class="w-full text-xs" style="border-collapse: collapse">
                    <thead>
                      <tr style="border-block-end: 1px solid var(--color-border)">
                        <th class="text-start py-1.5 pe-3" style="color: var(--color-text-secondary)">{{ t('intel.trends.week') }}</th>
                        <th class="text-end py-1.5 px-3" style="color: var(--color-text-secondary)">{{ t('intel.fights') }}</th>
                        <th class="text-end py-1.5 px-3" style="color: var(--color-text-secondary)">{{ t('intel.record') }}</th>
                        <th class="text-end py-1.5 px-3" style="color: var(--color-text-secondary)">{{ t('intel.winRate') }}</th>
                        <th class="text-end py-1.5 px-3" style="color: var(--color-text-secondary)">{{ t('intel.kills') }}</th>
                        <th class="text-end py-1.5 ps-3" style="color: var(--color-text-secondary)">{{ t('intel.silverLost') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (week of pi.weekly; track week.week_start) {
                        <tr style="border-block-end: 1px solid var(--color-border)">
                          <td class="mono py-1.5 pe-3">{{ week.week_start | date: 'mediumDate' }}</td>
                          <td class="mono text-end py-1.5 px-3">{{ week.fights }}</td>
                          <td class="mono text-end py-1.5 px-3">{{ week.wins }}–{{ week.losses }}</td>
                          <td class="mono text-end py-1.5 px-3">{{ week.win_rate | number: '1.0-0' }}%</td>
                          <td class="mono text-end py-1.5 px-3">{{ week.kills }}</td>
                          <td class="mono text-end py-1.5 ps-3">{{ formatAmount(week.silver_lost) }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }

              @if (pi.recent_fights.length > 0) {
                <div>
                  <h3 class="text-sm font-medium mb-2" style="color: var(--color-text)">{{ t('intel.player.recentFights') }}</h3>
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
              } @else {
                <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.player.noFights') }}</p>
              }
            }
          </section>
        } @else if (ownStanding(); as standing) {
          <section class="card p-6" aria-labelledby="own-standing-heading">
            <h2 id="own-standing-heading" class="text-base font-semibold" style="color: var(--color-text)">
              {{ t('intel.player.ownStanding.title') }}
            </h2>
            <p class="text-xs mt-1 mb-4" style="color: var(--color-text-secondary)">{{ t('intel.player.ownStanding.hint') }}</p>
            @if (standing.length > 0) {
              <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                @for (board of standing; track board.key) {
                  <app-stat-card [label]="board.label" [value]="'#' + board.rank" [sub]="formatAmount(board.value)" />
                }
              </div>
            } @else {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('intel.player.ownStanding.unranked') }}</p>
            }
          </section>
        }

        <!-- Adjust Progression Form (if active) -->
        @if (editing()) {
          <form class="card grid gap-4 p-6 border-primary" (submit)="onAdjustSubmit($event)">
            <div>
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('users.adjust.title') }}
              </h2>
              <p class="text-xs mt-1" style="color: var(--color-text-secondary)">
                {{ t('users.adjust.hint') }}
              </p>
            </div>

            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.addXp') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  placeholder="+500 o -200"
                  [value]="draft().addXp"
                  (input)="updateDraft('addXp', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.setLevel') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="1"
                  placeholder="Es. 10"
                  [value]="draft().setLevel"
                  (input)="updateDraft('setLevel', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.setMultiplier') }}</span>
                <input
                  class="input w-full"
                  type="number"
                  min="0"
                  max="5"
                  step="0.1"
                  placeholder="Es. 1.5"
                  [value]="draft().setMultiplier"
                  (input)="updateDraft('setMultiplier', $event)"
                />
              </label>
              <label class="block">
                <span class="label text-xs mb-1 block">{{ t('users.adjust.expires') }}</span>
                <input
                  class="input w-full"
                  type="datetime-local"
                  [value]="draft().expiresAt"
                  (input)="updateDraft('expiresAt', $event)"
                />
              </label>
            </div>

            <label class="block">
              <span class="label text-xs mb-1 block">{{ t('users.adjust.reason') }} *</span>
              <input
                class="input w-full"
                required
                placeholder="Motivazione per il registro di audit"
                [value]="draft().reason"
                (input)="updateDraft('reason', $event)"
              />
            </label>

            <div class="flex justify-end gap-2 pt-2 border-t" style="border-color: var(--color-border)">
              <button type="button" class="btn btn--ghost btn--sm" (click)="toggleEditing()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
                {{ t('users.adjust.submit') }}
              </button>
            </div>
          </form>
        }

        <!-- Albion Combat Specializations -->
        <section class="card p-6" aria-labelledby="specializations-heading">
          <div class="mb-4">
            <h2 id="specializations-heading" class="text-base font-semibold" style="color: var(--color-text)">
              {{ t('destiny.title') }}
            </h2>
            <p class="text-xs mt-1" style="color: var(--color-text-secondary)">
              {{ t('destiny.subtitle') }}
            </p>
          </div>
          <app-destiny-board
            [nodes]="specializationNodes()"
            [editable]="canManageSpecializations()"
            [loading]="specLoading()"
            [loadFailed]="specLoadFailed()"
            [saving]="specSaving()"
            (retry)="loadSpecializations()"
            (save)="saveSpecializations($event)"
          />
        </section>

        <!-- Warns Section -->
        @if (canViewWarns()) {
          <section class="card p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-base font-semibold" style="color: var(--color-text)">
                {{ t('users.warns.title') }}
              </h2>
              <span class="chip font-mono text-xs">{{ warns().length }} infrazioni</span>
            </div>

            @if (warns().length === 0) {
              <div class="p-6 text-center rounded-[var(--radius-cards)] border" style="background: var(--color-surface-2); border-color: var(--color-border)">
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  Nessun warn o sanzione registrata per questo membro.
                </p>
              </div>
            } @else {
              <ul class="grid gap-2.5">
                @for (warn of warns(); track warn.id) {
                  <li
                    class="rounded-[var(--radius-cards)] p-3.5 border text-sm transition-colors"
                    style="background: var(--color-surface-2); border-color: var(--color-border)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="chip" [class]="severityChip(warn.severity)">{{ warn.severity }}</span>
                      @if (warn.revoked_at) {
                        <span class="chip chip--neutral text-xs">{{ t('warns.revoked') }}</span>
                      }
                    </div>
                    <p class="mt-2 font-medium" style="color: var(--color-text)">{{ warn.reason }}</p>
                    <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
                      Registrato il {{ formatDate(warn.created_at) }}
                    </p>
                  </li>
                }
              </ul>
            }
          </section>
        }
      </app-page-stack>
    }

    <!-- Adjust Progression Confirmation Dialog -->
    @if (confirmOpen()) {
      <app-dialog [title]="t('users.adjust.confirm')" (closed)="closeConfirm()">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('users.adjust.hint') }}
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            (click)="confirmAdjust()"
            [disabled]="saving()"
          >
            {{ t('users.adjust.submit') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Admin Link Albion Character Dialog -->
    @if (linkDialogOpen()) {
      <app-dialog title="Collega Personaggio Albion" (closed)="closeLinkDialog()">
        <div class="grid gap-3">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            Cerca e seleziona un membro del roster attuale della gilda per collegarlo all'account di {{ member()?.username }}.
          </p>

          <input
            type="search"
            class="input w-full"
            placeholder="Cerca nome giocatore nel roster..."
            [value]="rosterSearch()"
            (input)="onRosterSearchInput($event)"
            autofocus
          />

          @if (rosterLoading()) {
            <div class="p-6 flex justify-center">
              <app-loading label="Caricamento roster di gilda..." />
            </div>
          } @else {
            <div class="max-h-64 overflow-y-auto grid gap-1.5 pr-1">
              @for (player of filteredRoster(); track player.id) {
                <button
                  type="button"
                  class="flex items-center justify-between p-2.5 rounded-[var(--radius-cards)] border text-left transition-colors hover:border-primary hover:bg-surface-2"
                  style="border-color: var(--color-border); background: var(--color-surface-1)"
                  (click)="confirmLink(player)"
                  [disabled]="savingLink()"
                >
                  <div>
                    <p class="text-sm font-semibold mono" style="color: var(--color-text)">
                      {{ player.name }}
                    </p>
                    <p class="text-xs" style="color: var(--color-text-secondary)">
                      ID: {{ player.id }}
                    </p>
                  </div>
                  <span class="btn btn--tonal btn--sm text-xs py-1 px-2.5">
                    Collega
                  </span>
                </button>
              } @empty {
                <p class="text-sm text-center py-4" style="color: var(--color-text-secondary)">
                  Nessun giocatore trovato nel roster con questo nome.
                </p>
              }
            </div>
          }
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeLinkDialog()">
            {{ t('common.cancel') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- Admin Unlink Albion Character Dialog -->
    @if (unlinkConfirmOpen()) {
      <app-dialog title="Scollega Personaggio Albion" (closed)="unlinkConfirmOpen.set(false)">
        <p class="text-sm" style="color: var(--color-text-secondary)">
          Sei sicuro di voler scollegare il personaggio <strong>{{ albionLink()?.albion_player_name }}</strong> dall'utente <strong>{{ member()?.username }}</strong>?
        </p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="unlinkConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--outline btn--sm text-error border-[var(--color-error)]/30 hover:bg-[var(--color-error-container)]"
            (click)="confirmUnlink()"
            [disabled]="savingLink()"
          >
            Conferma Scollegamento
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
  private readonly albionCatalog = inject(AlbionCatalogService);

  /** Bound from the route via `withComponentInputBinding`. */
  readonly userId = input.required<string>();

  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly editing = signal(false);
  protected readonly confirmOpen = signal(false);
  protected readonly member = signal<UserProfile | null>(null);
  protected readonly progression = signal<ProgressionMeView | null>(null);
  protected readonly warns = signal<WarnView[]>([]);
  protected readonly albionLink = signal<AlbionLinkStatus | null>(null);
  protected readonly draft = signal<AdjustDraft>(emptyAdjustDraft());

  protected readonly playerIntel = signal<PlayerReport | null>(null);
  protected readonly playerIntelLoading = signal(false);
  protected readonly ownStanding = signal<
    { key: string; label: string; rank: number; value: number }[] | null
  >(null);

  protected readonly specLoading = signal(false);
  protected readonly specLoadFailed = signal(false);
  protected readonly specSaving = signal(false);
  protected readonly specializationNodes = signal<DestinyItemNode[]>([]);

  // Albion Link Management State
  protected readonly linkDialogOpen = signal(false);
  protected readonly unlinkConfirmOpen = signal(false);
  protected readonly rosterLoading = signal(false);
  protected readonly savingLink = signal(false);
  protected readonly rosterSearch = signal('');
  protected readonly rosterMembers = signal<AlbionGuildMember[]>([]);

  private pendingBody: AdjustProgressionRequest | null = null;

  protected readonly canAdjust = computed(() => this.auth.hasPermission('progression.adjust'));
  protected readonly canViewWarns = computed(() => this.auth.hasPermission('warns.view'));
  /**
   * Same gate as `/intel` itself (`intel.report.view`): the per-player report
   * surfaces the identical silver/split figures the guild report's roster
   * table already shows for every member, just isolated to one row.
   */
  protected readonly canViewPlayerIntel = computed(() => this.auth.hasPermission('intel.report.view'));
  protected readonly canManageSpecializations = computed(() => {
    const target = this.member()?.id;
    const ownId = this.auth.profile()?.user_id;
    return (
      (target != null && ownId === target) ||
      this.auth.hasPermission('users.specializations.manage')
    );
  });

  protected readonly canManageLinks = computed(
    () =>
      this.auth.hasPermission('roles.manage') ||
      this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly canManageRoles = computed(() => this.auth.hasPermission('roles.manage'));

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

  protected readonly filteredRoster = computed(() => {
    const q = this.rosterSearch().toLowerCase().trim();
    if (!q) return this.rosterMembers().slice(0, 30);
    return this.rosterMembers()
      .filter((m) => m.name.toLowerCase().includes(q))
      .slice(0, 30);
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

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
        this.editing.set(false);
        this.closeConfirm();
        this.linkDialogOpen.set(false);
        this.unlinkConfirmOpen.set(false);
        this.playerIntel.set(null);
        this.ownStanding.set(null);
        this.memberRoles.set(null);
        this.pendingAddRoleId.set('');
        void this.load();
      });
    });
  }

  protected roleChip(role: Role): string {
    if (role === 'SuperAdmin') {
      return 'chip chip--error';
    }
    if (role === 'Admin') {
      return 'chip chip--warning';
    }
    if (role === 'Officer') {
      return 'chip chip--success';
    }
    return 'chip';
  }

  protected severityChip(severity: WarnView['severity']): string {
    if (severity === 'strike') {
      return 'chip chip--error';
    }
    if (severity === 'warn') {
      return 'chip chip--warning';
    }
    return 'chip';
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

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected async saveSpecializations(nodes: DestinyItemNode[]): Promise<void> {
    const member = this.member();
    if (!member || !this.canManageSpecializations() || this.specSaving()) return;
    if (nodes.some((node) => !Number.isInteger(node.level) || node.level < 0 || node.level > 120)) {
      this.toasts.error(this.t('destiny.invalidLevel'));
      return;
    }
    this.specSaving.set(true);
    try {
      const payload = nodes.map(({ icon: _icon, identifier: _identifier, ...node }) => node);
      const updated: UserSpecialization[] = [];
      for (let offset = 0; offset < payload.length; offset += 500) {
        const batch = payload.slice(offset, offset + 500);
        const result = await firstValueFrom(
          this.api.put<UserSpecialization[]>(`api/users/${member.id}/specializations`, {
            specializations: batch,
          }),
        );
        updated.push(...result);
      }
      const updatedByKey = new Map(
        updated.map((row) => [normalizeAlbionSpecializationKey(row.node_key), row.level]),
      );
      this.specializationNodes.set(
        nodes.map((node) => ({
          ...node,
          level: updatedByKey.get(node.node_key) ?? node.level,
        })),
      );
      this.toasts.success(this.t('destiny.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.specSaving.set(false);
    }
  }

  protected toggleEditing(): void {
    if (!this.canAdjust()) {
      return;
    }
    this.editing.update((open) => !open);
    if (!this.editing()) {
      this.draft.set(emptyAdjustDraft());
      this.closeConfirm();
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
      this.editing.set(false);
      this.closeConfirm();
      this.toasts.success(this.t('users.adjust.success'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
          this.api.get<PaginatedData<AlbionGuildMember> | AlbionGuildMember[]>('api/albion/guild/roster'),
        );
        this.rosterMembers.set(asPaginated(roster));
      } catch {
        this.toasts.error('Impossibile caricare il roster di gilda da Albion');
      } finally {
        this.rosterLoading.set(false);
      }
    }
  }

  protected closeLinkDialog(): void {
    this.linkDialogOpen.set(false);
    this.rosterSearch.set('');
  }

  protected onRosterSearchInput(event: Event): void {
    this.rosterSearch.set((event.target as HTMLInputElement).value);
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
      this.toasts.success(`Personaggio ${player.name} collegato a ${member.username}`);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante il collegamento');
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
      this.toasts.success('Personaggio scollegato con successo');
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : 'Errore durante lo scollegamento');
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
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
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.roleSaving.set(false);
    }
  }

  protected async loadSpecializations(userId = Number(this.userId())): Promise<void> {
    if (!Number.isFinite(userId) || userId <= 0) return;
    this.specLoading.set(true);
    this.specLoadFailed.set(false);
    try {
      const [saved, catalog] = await Promise.all([
        firstValueFrom(this.api.get<UserSpecialization[]>(`api/users/${userId}/specializations`)),
        this.albionCatalog.load(),
      ]);
      this.specializationNodes.set(mergeSpecializationNodes(saved, catalog));
    } catch (error) {
      this.specLoadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('destiny.loadError'));
    } finally {
      this.specLoading.set(false);
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
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const member = await firstValueFrom(this.api.get<UserProfile>(`api/users/${userId}`));
      this.member.set(member);

      void this.loadSpecializations(userId);
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
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
