import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BuildRole,
  CompBuildEntry,
  CompDetail,
  CompSummary,
  EventBattleSummary,
  EventDetailView,
  EventParticipant,
  EventStatus,
  OpponentPerformanceView,
  PaginatedData,
  ParticipateEventRequest,
  SplitSummary,
  UpdateEventBattlesRequest,
  UpdateEventRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import {
  SearchDialog,
  SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';

/**
 * Full-page analytics view for a single guild event.
 *
 * Replaces the legacy inline "Stats" expansion on the events list: instead of
 * cramming performance, opponents, battles, splits and participants inside a
 * small card, the whole route is dedicated to a single event so every metric
 * gets its own section and remains usable on small screens.
 *
 * @example
 * ```ts
 * routes.push({
 *   path: 'events/:eventId',
 *   loadComponent: () => import('./event-detail').then(m => m.EventDetailPage),
 * });
 * ```
 */
@Component({
  selector: 'app-event-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, Loading, SearchDialog, Icon, DataTable],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (event(); as detail) {
      <header class="event-detail__hero card p-5">
        <button type="button" class="btn btn--ghost" (click)="backToEvents()">
          ← {{ t('events.detail.back') }}
        </button>

        <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <h1 class="text-3xl font-bold" style="color: var(--color-text)">
                {{ detail.title }}
              </h1>
              <span class="chip" [class]="statusChip(detail.status)">{{ detail.status }}</span>
            </div>
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ formatDate(detail.event_date_utc) }} · {{ t('events.detail.comp') }}:
              {{ detail.active_comp_name || detail.comp_name }} ·
              {{ t('events.detail.comp_capacity') }}: {{ detail.active_comp_capacity }}
            </p>
            @if (detail.description) {
              <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
                {{ detail.description }}
              </p>
            }
          </div>

          <div class="flex flex-wrap gap-2">
            @if (detail.status === 'scheduled') {
              @if (currentParticipant(); as participation) {
                <span class="chip chip--success">
                  {{ t('events.detail.registered_as') }}:
                  {{ participation.primary_build_name }}
                  @if (participation.secondary_build_name) {
                    / {{ participation.secondary_build_name }}
                  }
                </span>
                <button type="button" class="btn btn--tonal" (click)="toggleJoinForm()">
                  {{ showJoinForm() ? t('common.close') : t('events.detail.change_build') }}
                </button>
                <button type="button" class="btn btn--outline" (click)="leave(detail.id)">
                  {{ t('events.leave') }}
                </button>
              } @else {
                <button type="button" class="btn btn--tonal" (click)="toggleJoinForm()">
                  {{ showJoinForm() ? t('common.close') : t('events.participate') }}
                </button>
              }
            }
            @if (canManage() && detail.status === 'scheduled') {
              <button type="button" class="btn btn--primary" (click)="start(detail.id)">
                {{ t('events.start') }}
              </button>
            }
            @if (canManage() && detail.status === 'live') {
              <button type="button" class="btn btn--danger" (click)="stop(detail.id)">
                {{ t('events.stop') }}
              </button>
            }
            @if (canEdit()) {
              <button type="button" class="btn btn--ghost" (click)="toggleEditForm()">
                {{ showEditForm() ? t('common.close') : t('common.edit') }}
              </button>
              <button type="button" class="btn btn--danger" (click)="deleteEvent()">
                {{ t('common.delete') }}
              </button>
            }
          </div>
        </div>
      </header>

      @if (showEditForm()) {
        <form class="mt-4 grid gap-3" (submit)="onUpdateSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              [value]="draftTitle()"
              (input)="onTitleChange($event)"
            />
          </label>
          <label>
            <span class="label">{{ t('common.optional') }}</span>
            <textarea
              class="textarea"
              rows="3"
              [value]="draftDescription()"
              (input)="onDescriptionChange($event)"
            ></textarea>
          </label>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <span class="label">{{ t('events.detail.comp') }}</span>
              <div class="flex items-center gap-2">
                <div class="flex-1 input flex items-center bg-[var(--color-surface-1)]">
                  <span class="truncate">{{ draftCompTitle() || 'No comp linked' }}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--outline whitespace-nowrap"
                  (click)="showCompSearch.set(true)"
                >
                  Link Comp
                </button>
                @if (draftCompId()) {
                  <button
                    type="button"
                    class="btn btn--danger whitespace-nowrap"
                    (click)="unlinkComp()"
                  >
                    <app-icon name="close" size="1rem" />
                  </button>
                }
              </div>
            </div>
            <label>
              <span class="label">{{ t('common.date') }}</span>
              <input
                class="input"
                type="datetime-local"
                [value]="draftScheduledAt()"
                (input)="onScheduledAtChange($event)"
              />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn--ghost" (click)="toggleEditForm()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      }

      @if (showJoinForm()) {
        <form class="mt-4 grid gap-3" (submit)="onJoinSubmit($event)">
          @if (compLoading()) {
            <app-loading [label]="t('common.loading')" />
          } @else if (availableBuilds().length === 0) {
            <p class="text-sm" style="color: var(--color-text-secondary)">
              {{ t('events.detail.no_builds') }}
            </p>
          } @else {
            <label>
              <span class="label">{{ t('events.detail.primary_build') }} *</span>
              <select
                class="select"
                [value]="draftPrimaryBuildId()"
                (change)="onPrimaryBuildChange($event)"
              >
                <option value="">—</option>
                @for (entry of availableBuilds(); track entry.build_id) {
                  <option [value]="entry.build_id">
                    {{ entry.build.name }} · {{ entry.build.role }}
                    @if (entry.build.category_name) {
                      ({{ entry.build.category_name }})
                    }
                  </option>
                }
              </select>
            </label>
            <label>
              <span class="label">{{ t('events.detail.secondary_build') }}</span>
              <select
                class="select"
                [value]="draftSecondaryBuildId()"
                (change)="onSecondaryBuildChange($event)"
              >
                <option value="">—</option>
                @for (entry of availableBuilds(); track entry.build_id) {
                  <option [value]="entry.build_id">
                    {{ entry.build.name }} · {{ entry.build.role }}
                  </option>
                }
              </select>
            </label>
            @if (joinError()) {
              <p class="text-sm" style="color: var(--color-danger)">{{ joinError() }}</p>
            }
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="toggleJoinForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="joinSubmitting()">
                {{ t('events.participate') }}
              </button>
            </div>
          }
        </form>
      }

      <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Performance">
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.win_rate') }}</p>
          <p class="event-detail__value">{{ formatPercent(detail.stats.win_rate) }}</p>
          <p class="event-detail__sub mb-2">
            {{ detail.stats.wins }} {{ t('events.detail.wins') }} · {{ detail.stats.losses }}
            {{ t('events.detail.losses') }}
          </p>
          @if (detail.stats.total_battles > 0) {
            <div class="event-detail__fill-bar" style="background: var(--color-danger)">
              <span
                [style.width.%]="(detail.stats.wins / detail.stats.total_battles) * 100"
                style="background: var(--color-success)"
              ></span>
            </div>
          }
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.kd') }}</p>
          <p class="event-detail__value">{{ formatRatio(detail.stats.kill_death_ratio) }}</p>
          <p class="event-detail__sub mb-2">
            {{ detail.stats.total_kills }} {{ t('events.detail.kills') }} ·
            {{ detail.stats.total_deaths }} {{ t('events.detail.deaths') }}
          </p>
          @if (detail.stats.total_kills + detail.stats.total_deaths > 0) {
            <div class="event-detail__fill-bar" style="background: var(--color-danger)">
              <span
                [style.width.%]="
                  (detail.stats.total_kills /
                    (detail.stats.total_kills + detail.stats.total_deaths)) *
                  100
                "
                style="background: var(--color-success)"
              ></span>
            </div>
          }
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.kill_fame') }}</p>
          <p class="event-detail__value">{{ formatCompact(detail.stats.total_kill_fame) }}</p>
        </article>
        <article class="surface p-4">
          <p class="event-detail__label">{{ t('events.detail.battles_count') }}</p>
          <p class="event-detail__value">{{ detail.stats.total_battles }}</p>
          <p class="event-detail__sub">
            {{ t('events.detail.avg_players') }}:
            {{ formatRatio(detail.stats.average_guild_players) }}
          </p>
        </article>
      </section>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.opponents') }}</h2>
        </header>
        @if (detail.stats.top_opponents.length > 0) {
          <app-data-table
            [columns]="opponentsColumns"
            [rows]="detail.stats.top_opponents"
            [trackBy]="trackOpponent"
          >
            <ng-template dataTableCell="guild_name" let-row>
              <span class="font-medium">{{ row.guild_name || t('common.none') }}</span>
            </ng-template>
            <ng-template dataTableCell="guild_kill_fame" let-row>
              {{ formatCompact(row.guild_kill_fame) }}
            </ng-template>
            <ng-template dataTableCell="opponent_kill_fame" let-row>
              <span style="color: var(--color-text-secondary)">{{
                formatCompact(row.opponent_kill_fame)
              }}</span>
            </ng-template>
          </app-data-table>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_opponents') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.battles') }}</h2>
          <div class="flex flex-wrap gap-2">
            @if (canEdit()) {
              <button type="button" class="btn btn--tonal" (click)="toggleBattleLinkForm()">
                {{ showBattleLinkForm() ? t('common.close') : t('events.detail.manage_battles') }}
              </button>
            }
            @if (detail.battles.length > 0) {
              <button type="button" class="btn btn--outline" (click)="openBattleGroup(detail)">
                {{ t('battles.group_selected') }}
              </button>
            }
          </div>
        </header>
        @if (showBattleLinkForm()) {
          <form class="grid gap-3 p-4" (submit)="onBattleLinksSubmit($event)">
            <div>
              <div class="flex justify-between items-center mb-2">
                <span class="label">{{ t('events.detail.battle_ids') }}</span>
                <button
                  type="button"
                  class="btn btn--outline text-xs"
                  (click)="showBattleSearch.set(true)"
                >
                  Add Battle
                </button>
              </div>

              <div class="flex flex-col gap-2">
                @for (link of draftBattleLinks(); track link.id) {
                  <div class="flex items-center gap-2">
                    <div class="flex-1 input flex items-center bg-[var(--color-surface-1)]">
                      <span class="truncate">{{ link.title }}</span>
                    </div>
                    <button
                      type="button"
                      class="btn btn--danger btn--icon whitespace-nowrap"
                      (click)="removeDraftBattle(link.id)"
                    >
                      <app-icon name="close" size="1rem" />
                    </button>
                  </div>
                }
                @if (draftBattleLinks().length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    No battles linked.
                  </p>
                }
              </div>
            </div>

            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('events.detail.battle_ids_help') }}
            </p>
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="toggleBattleLinkForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="battleLinksSaving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }
        @if (detail.battles.length > 0) {
          <app-data-table
            [columns]="battlesColumns"
            [rows]="detail.battles"
            [trackBy]="trackBattle"
          >
            <ng-template dataTableCell="albionbb_battle_id" let-row>
              <span class="font-medium">{{ row.albionbb_battle_id }}</span>
            </ng-template>
            <ng-template dataTableCell="battle_started_at" let-row>
              <span style="color: var(--color-text-secondary)">{{
                formatDate(row.battle_started_at)
              }}</span>
            </ng-template>
            <ng-template dataTableCell="is_win" let-row>
              <span
                class="chip"
                [class.chip--success]="row.is_win"
                [class.chip--danger]="!row.is_win"
              >
                {{ row.is_win ? t('events.detail.wins') : t('events.detail.losses') }}
              </span>
            </ng-template>
            <ng-template dataTableCell="guild_kill_fame" let-row>
              {{ formatCompact(row.guild_kill_fame) }}
            </ng-template>
            <ng-template dataTableCell="opponent_guild_name" let-row>
              {{ row.opponent_guild_name ?? t('common.none') }}
            </ng-template>
            <ng-template dataTableCell="actions" let-row>
              <button
                type="button"
                class="btn btn--ghost"
                (click)="openBattle(row.albionbb_battle_id)"
              >
                {{ t('events.detail.open_battle') }}
              </button>
            </ng-template>
          </app-data-table>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_battles') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.splits') }}</h2>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs" style="color: var(--color-text-secondary)">
              {{ formatNumber(totalSplitValue()) }}
            </span>
            @if (canEdit()) {
              <button
                type="button"
                class="btn btn--tonal text-xs"
                (click)="showSplitSearch.set(true)"
              >
                Link Split
              </button>
            }
          </div>
        </header>
        @if (detail.split_stats.total_splits > 0) {
          <section class="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Split summary">
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_total') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.total_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_completed') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.completed_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_pending') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.pending_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_lost') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ detail.split_stats.lost_splits }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_not_completed') }}</p>
              <p class="event-detail__value-sm">{{ detail.split_stats.not_completed_splits }}</p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_estimated') }}</p>
              <p class="event-detail__value-sm">
                {{ formatNumber(detail.split_stats.estimated_market_value) }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_repair') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ formatNumber(detail.split_stats.repair_value) }}
              </p>
            </article>
            <article class="surface p-3">
              <p class="event-detail__label">{{ t('events.detail.split_bags') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-danger)">
                {{ formatNumber(detail.split_stats.bags_value) }}
              </p>
            </article>
            <article class="surface p-3 sm:col-span-2 xl:col-span-2">
              <p class="event-detail__label">{{ t('events.detail.split_net') }}</p>
              <p class="event-detail__value-sm" style="color: var(--color-success)">
                {{ formatNumber(detail.split_stats.completed_net_value) }}
              </p>
            </article>
            <article class="surface p-3 sm:col-span-2 xl:col-span-2">
              <p class="event-detail__label">{{ t('events.detail.split_participant_entries') }}</p>
              <p class="event-detail__value-sm">
                {{ detail.split_stats.participant_entries }}
              </p>
            </article>
          </section>
        }
        @if (splits().length > 0) {
          <app-data-table [columns]="splitsColumns" [rows]="splits()" [trackBy]="trackSplit">
            <ng-template dataTableCell="note" let-row>
              <span class="font-medium">{{ row.note || 'Split #' + row.id }}</span>
            </ng-template>
            <ng-template dataTableCell="status" let-row>
              <span class="chip">{{ row.status }}</span>
            </ng-template>
            <ng-template dataTableCell="estimated_market_value" let-row>
              {{ formatNumber(row.estimated_market_value) }}
            </ng-template>
            <ng-template dataTableCell="net_value" let-row>
              <span [class.font-semibold]="row.net_value != null">{{
                formatNumber(row.net_value ?? row.estimated_market_value)
              }}</span>
            </ng-template>
            @if (canEdit()) {
              <ng-template dataTableCell="actions" let-row>
                <button
                  type="button"
                  class="btn btn--danger btn--icon"
                  (click)="unlinkSplit(row.id)"
                  title="Unlink Split"
                >
                  <app-icon name="close" size="1rem" />
                </button>
              </ng-template>
            }
          </app-data-table>
        } @else {
          <p class="event-detail__empty">{{ t('events.detail.no_splits') }}</p>
        }
      </article>

      <article class="mt-5 surface overflow-hidden">
        <header class="event-detail__section-header">
          <h2>{{ t('events.detail.participants') }}</h2>
          <span class="text-xs" style="color: var(--color-text-secondary)">
            {{ participantsTotal() }}
            @if (participantsTarget() > 0) {
              / {{ participantsTarget() }}
            } @else {
              / {{ detail.active_comp_capacity }}
            }
          </span>
        </header>
        @if (participantsTarget() > 0) {
          <div class="event-detail__global-fill">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium" style="color: var(--color-text)">
                {{ t('events.detail.comp_filling') }}
              </span>
              <span
                class="text-sm font-bold"
                [style.color]="
                  fillPercent(participantsTotal(), participantsTarget()) >= 100
                    ? 'var(--color-success)'
                    : fillPercent(participantsTotal(), participantsTarget()) >= 50
                      ? 'var(--color-warning)'
                      : 'var(--color-danger)'
                "
              >
                {{ fillPercent(participantsTotal(), participantsTarget()) }}%
              </span>
            </div>
            <div class="event-detail__fill-bar event-detail__fill-bar--lg">
              <span
                [style.width.%]="fillPercent(participantsTotal(), participantsTarget())"
                [class.event-detail__fill-bar__full]="
                  fillPercent(participantsTotal(), participantsTarget()) >= 100
                "
                [class.event-detail__fill-bar__half]="
                  fillPercent(participantsTotal(), participantsTarget()) >= 50 &&
                  fillPercent(participantsTotal(), participantsTarget()) < 100
                "
              ></span>
            </div>
            <p class="text-xs" style="color: var(--color-text-secondary)">
              {{ participantsTotal() }}
              {{ t('events.detail.filled_of') }}
              {{ participantsTarget() }}
              @if (participantsTarget() - participantsTotal() > 0) {
                · {{ participantsTarget() - participantsTotal() }}
                {{ t('events.detail.slots_left') }}
              } @else {
                · {{ t('events.detail.comp_full') }}
              }
            </p>
          </div>
        }
        @if (compLoading()) {
          <p class="event-detail__empty">{{ t('common.loading') }}</p>
        } @else if (detail.participants.length === 0) {
          <p class="event-detail__empty">{{ t('events.detail.no_participants') }}</p>
        } @else if (participantsByRole().length > 0) {
          <div class="grid gap-4 p-4">
            @for (group of participantsByRole(); track group.role) {
              <section class="event-detail__role-group">
                <header class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2">
                    <span class="chip" [class]="roleChip(group.role)">
                      {{ t(roleLabel(group.role)) }}
                    </span>
                    <span class="text-sm" style="color: var(--color-text-secondary)">
                      {{ group.participants.length }}
                      @if (group.target > 0) {
                        / {{ group.target }}
                      }
                    </span>
                  </div>
                  @if (group.target > 0) {
                    <span
                      class="text-xs"
                      [style.color]="
                        fillPercent(group.participants.length, group.target) >= 100
                          ? 'var(--color-success)'
                          : 'var(--color-warning)'
                      "
                    >
                      {{ fillPercent(group.participants.length, group.target) }}%
                    </span>
                  }
                </header>
                @if (group.target > 0) {
                  <div class="event-detail__fill-bar">
                    <span
                      [style.width.%]="fillPercent(group.participants.length, group.target)"
                      [class.event-detail__fill-bar__full]="
                        fillPercent(group.participants.length, group.target) >= 100
                      "
                    ></span>
                  </div>
                }
                <div class="flex flex-wrap gap-2">
                  @for (participant of group.participants; track participant.user_id) {
                    <span
                      class="chip"
                      [class.chip--info]="participant.user_id === currentParticipant()?.user_id"
                    >
                      {{ participant.username }}
                      <small style="color: var(--color-text-secondary)">
                        · {{ participant.primary_build_name || t('common.none') }}
                      </small>
                    </span>
                  }
                  @if (group.participants.length === 0) {
                    <span class="text-xs" style="color: var(--color-text-disabled)">
                      {{ t('events.detail.role_empty') }}
                    </span>
                  }
                </div>
              </section>
            }
          </div>
        } @else {
          <app-data-table
            [columns]="participantsColumns"
            [rows]="detail.participants"
            [trackBy]="trackParticipant"
          >
            <ng-template dataTableCell="username" let-row>
              <span class="font-medium">{{ row.username }}</span>
            </ng-template>
            <ng-template dataTableCell="primary_build_name" let-row>
              {{ row.primary_build_name || t('common.none') }}
            </ng-template>
            <ng-template dataTableCell="secondary_build_name" let-row>
              <span style="color: var(--color-text-secondary)">{{
                row.secondary_build_name ?? t('common.none')
              }}</span>
            </ng-template>
          </app-data-table>
        }
      </article>
    } @else {
      <app-empty-state [message]="t('common.empty')" icon="calendar" />
    }

    @if (showCompSearch()) {
      <app-search-dialog
        title="Link Comp"
        [options]="compSearchOptions()"
        [loading]="compSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onCompSearchFilter($event)"
        (select)="onCompSelected($event)"
        (close)="showCompSearch.set(false)"
      />
    }

    @if (showBattleSearch()) {
      <app-search-dialog
        title="Search Battles"
        [options]="battleSearchOptions()"
        [loading]="battleSearchLoading()"
        [showDateFilters]="false"
        (filterChange)="onBattleSearchFilter($event)"
        (select)="onBattleSelected($event)"
        (close)="showBattleSearch.set(false)"
      />
    }

    @if (showSplitSearch()) {
      <app-search-dialog
        title="Link Split"
        [options]="splitSearchOptions()"
        [loading]="splitSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onSplitSearchFilter($event)"
        (select)="onSplitSelected($event)"
        (close)="showSplitSearch.set(false)"
      />
    }
  `,
  styles: `
    @layer components {
      .event-detail__hero {
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .event-detail__label {
        color: var(--color-text-disabled);
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .event-detail__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.75rem);
        font-weight: 700;
      }
      .event-detail__value-sm {
        color: var(--color-text);
        font-size: 1.125rem;
        font-weight: 700;
      }
      .event-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.8rem;
        margin-top: 0.25rem;
      }
      .event-detail__section-header {
        align-items: center;
        border-bottom: 1px solid var(--color-border);
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: space-between;
        padding: 1rem;
      }
      .event-detail__section-header h2 {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
      }
      .event-detail__empty {
        color: var(--color-text-secondary);
        font-size: 0.875rem;
        padding: 1rem;
      }
      .event-detail__role-group {
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        display: grid;
        gap: 0.75rem;
        padding: 1rem;
      }
      .event-detail__fill-bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.5rem;
        overflow: hidden;
      }
      .event-detail__fill-bar--lg {
        height: 1rem;
      }
      .event-detail__fill-bar span {
        background: var(--color-warning);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
        transition: width 0.2s ease;
      }
      .event-detail__fill-bar__full {
        background: var(--color-success);
      }
      .event-detail__fill-bar__half {
        background: var(--color-warning);
      }
      .event-detail__global-fill {
        border-bottom: 1px solid var(--color-border);
        display: grid;
        gap: 0.5rem;
        padding: 1.25rem 1rem;
      }
    }
  `,
})
export class EventDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private eventId = 0;

  protected readonly event = signal<EventDetailView | null>(null);
  protected readonly loading = signal(false);
  protected readonly canEdit = signal(false);
  protected readonly showEditForm = signal(false);
  protected readonly saving = signal(false);
  protected readonly showBattleLinkForm = signal(false);

  protected readonly showCompSearch = signal(false);
  protected readonly compSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly compSearchLoading = signal(false);
  protected readonly draftCompTitle = signal('');

  protected readonly showBattleSearch = signal(false);
  protected readonly battleSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly battleSearchLoading = signal(false);
  protected readonly battleLinksSaving = signal(false);
  protected readonly draftBattleLinks = signal<{ id: string; title: string }[]>([]);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly splits = signal<SplitSummary[]>([]);
  protected readonly totalSplitValue = computed(() =>
    this.splits().reduce((sum, s) => sum + Number(s.net_value ?? s.estimated_market_value), 0),
  );

  protected readonly showSplitSearch = signal(false);
  protected readonly splitSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly splitSearchLoading = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftScheduledAt = signal('');
  protected readonly showJoinForm = signal(false);
  protected readonly joinFormLoading = signal(false);
  protected readonly compLoading = signal(false);
  protected readonly joinSubmitting = signal(false);
  protected readonly joinError = signal<string | null>(null);
  protected readonly availableBuilds = signal<CompBuildEntry[]>([]);
  protected readonly draftPrimaryBuildId = signal('');
  protected readonly draftSecondaryBuildId = signal('');
  protected readonly currentParticipant = computed<EventParticipant | null>(() => {
    const detail = this.event();
    const userId = this.auth.profile()?.user_id ?? null;
    if (!detail || userId === null) {
      return null;
    }
    return detail.participants.find((participant) => participant.user_id === userId) ?? null;
  });
  protected readonly buildIndex = computed<Map<number, CompBuildEntry>>(() => {
    const map = new Map<number, CompBuildEntry>();
    for (const entry of this.availableBuilds()) {
      map.set(entry.build_id, entry);
    }
    return map;
  });
  protected readonly participantsByRole = computed<RoleGrouping[]>(() => {
    const detail = this.event();
    if (!detail) {
      return [];
    }
    const index = this.buildIndex();
    const groups = new Map<BuildRole, RoleGrouping>();

    const ensureGroup = (role: BuildRole): RoleGrouping => {
      let group = groups.get(role);
      if (!group) {
        group = { role, target: 0, participants: [] };
        groups.set(role, group);
      }
      return group;
    };

    for (const entry of this.availableBuilds()) {
      const group = ensureGroup(entry.build.role);
      group.target += entry.quantity;
    }

    for (const participant of detail.participants) {
      const entry = index.get(participant.primary_build_id);
      const role = entry?.build.role ?? 'dps';
      ensureGroup(role).participants.push(participant);
    }

    return ROLE_ORDER.map((role) => groups.get(role)).filter(
      (group): group is RoleGrouping => !!group,
    );
  });
  protected readonly participantsTotal = computed(() =>
    this.participantsByRole().reduce((sum, group) => sum + group.participants.length, 0),
  );
  protected readonly participantsTarget = computed(() =>
    this.participantsByRole().reduce((sum, group) => sum + group.target, 0),
  );

  // Opponents table columns and trackBy
  protected readonly opponentsColumns: readonly DataTableColumn<OpponentPerformanceView>[] = [
    {
      key: 'guild_name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (opp) => opp.guild_name || '',
      comparator: (a, b) => (a.guild_name || '').localeCompare(b.guild_name || ''),
    },
    {
      key: 'battles',
      label: 'events.detail.battles_count',
      sortable: true,
      accessor: (opp) => opp.battles,
      comparator: (a, b) => a.battles - b.battles,
      align: 'right',
    },
    {
      key: 'wins',
      label: 'events.detail.wins',
      sortable: true,
      accessor: (opp) => opp.wins,
      comparator: (a, b) => a.wins - b.wins,
      align: 'right',
    },
    {
      key: 'losses',
      label: 'events.detail.losses',
      sortable: true,
      accessor: (opp) => opp.losses,
      comparator: (a, b) => a.losses - b.losses,
      align: 'right',
    },
    {
      key: 'guild_kill_fame',
      label: 'events.detail.kill_fame',
      sortable: true,
      accessor: (opp) => opp.guild_kill_fame,
      comparator: (a, b) => a.guild_kill_fame - b.guild_kill_fame,
      align: 'right',
    },
    {
      key: 'opponent_kill_fame',
      label: 'battles.opponent',
      sortable: true,
      accessor: (opp) => opp.opponent_kill_fame,
      comparator: (a, b) => a.opponent_kill_fame - b.opponent_kill_fame,
      align: 'right',
    },
  ];

  protected readonly trackOpponent = (opponent: OpponentPerformanceView): unknown =>
    `${opponent.guild_id || opponent.guild_name}`;

  // Splits table columns and trackBy
  protected readonly splitsColumns: readonly DataTableColumn<SplitSummary>[] = [
    {
      key: 'note',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (split) => split.note || `Split #${split.id}`,
      comparator: (a, b) => {
        const aName = a.note || `Split #${a.id}`;
        const bName = b.note || `Split #${b.id}`;
        return aName.localeCompare(bName);
      },
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (split) => split.status,
      comparator: (a, b) => a.status.localeCompare(b.status),
    },
    {
      key: 'estimated_market_value',
      label: 'splits.estimated',
      sortable: true,
      accessor: (split) => split.estimated_market_value,
      comparator: (a, b) => a.estimated_market_value - b.estimated_market_value,
      align: 'right',
    },
    {
      key: 'net_value',
      label: 'splits.net_value',
      sortable: true,
      accessor: (split) => split.net_value ?? split.estimated_market_value,
      comparator: (a, b) => {
        const aVal = a.net_value ?? a.estimated_market_value;
        const bVal = b.net_value ?? b.estimated_market_value;
        return aVal - bVal;
      },
      align: 'right',
    },
    {
      key: 'actions',
      label: 'common.actions',
      align: 'right',
    },
  ];

  protected readonly trackSplit = (split: SplitSummary): unknown => split.id;

  // Battles table columns and trackBy
  protected readonly battlesColumns: readonly DataTableColumn<EventBattleSummary>[] = [
    {
      key: 'albionbb_battle_id',
      label: 'events.detail.open_battle',
      sortable: true,
      accessor: (battle) => battle.albionbb_battle_id,
      comparator: (a, b) => a.albionbb_battle_id.localeCompare(b.albionbb_battle_id),
    },
    {
      key: 'battle_started_at',
      label: 'common.date',
      sortable: true,
      accessor: (battle) => battle.battle_started_at,
      comparator: (a, b) => a.battle_started_at.localeCompare(b.battle_started_at),
    },
    {
      key: 'is_win',
      label: 'common.status',
      sortable: true,
      accessor: (battle) => (battle.is_win ? 'win' : 'loss'),
      comparator: (a, b) => Number(a.is_win) - Number(b.is_win),
    },
    {
      key: 'guild_players_count',
      label: 'battles.players',
      sortable: true,
      accessor: (battle) => battle.guild_players_count,
      comparator: (a, b) => a.guild_players_count - b.guild_players_count,
      align: 'right',
    },
    {
      key: 'guild_kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (battle) => battle.guild_kills,
      comparator: (a, b) => a.guild_kills - b.guild_kills,
      align: 'right',
    },
    {
      key: 'guild_deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (battle) => battle.guild_deaths,
      comparator: (a, b) => a.guild_deaths - b.guild_deaths,
      align: 'right',
    },
    {
      key: 'guild_kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      accessor: (battle) => battle.guild_kill_fame,
      comparator: (a, b) => a.guild_kill_fame - b.guild_kill_fame,
      align: 'right',
    },
    {
      key: 'opponent_guild_name',
      label: 'battles.opponent',
      sortable: true,
      searchable: true,
      accessor: (battle) => battle.opponent_guild_name || '',
      comparator: (a, b) => {
        const aName = a.opponent_guild_name || '';
        const bName = b.opponent_guild_name || '';
        return aName.localeCompare(bName);
      },
    },
    {
      key: 'actions',
      label: 'common.actions',
      align: 'right',
    },
  ];

  protected readonly trackBattle = (battle: EventBattleSummary): unknown => battle.id;

  // Participants table columns and trackBy
  protected readonly participantsColumns: readonly DataTableColumn<EventParticipant>[] = [
    {
      key: 'username',
      label: 'common.username',
      sortable: true,
      searchable: true,
      accessor: (participant) => participant.username,
      comparator: (a, b) => a.username.localeCompare(b.username),
    },
    {
      key: 'primary_build_name',
      label: 'events.detail.primary_build',
      sortable: true,
      searchable: true,
      accessor: (participant) => participant.primary_build_name || '',
      comparator: (a, b) => {
        const aName = a.primary_build_name || '';
        const bName = b.primary_build_name || '';
        return aName.localeCompare(bName);
      },
    },
    {
      key: 'secondary_build_name',
      label: 'events.detail.secondary_build',
      sortable: true,
      searchable: true,
      accessor: (participant) => participant.secondary_build_name || '',
      comparator: (a, b) => {
        const aName = a.secondary_build_name || '';
        const bName = b.secondary_build_name || '';
        return aName.localeCompare(bName);
      },
    },
  ];

  protected readonly trackParticipant = (participant: EventParticipant): unknown =>
    participant.user_id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    this.canEdit.set(this.auth.hasPermission('events.manage'));
    this.route.paramMap.subscribe((params) => {
      const id = params.get('eventId');
      if (id) {
        this.eventId = Number(id);
        void this.load();
      }
    });
    this.onCompSearchFilter({ search: '', dateFrom: '', dateTo: '' });
    this.onBattleSearchFilter({ search: '', dateFrom: '', dateTo: '' });
  }

  protected async onCompSearchFilter(filter: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.compSearchLoading.set(true);
    try {
      const params: Record<string, string> = {};
      if (filter.search) params['search'] = filter.search;
      if (filter.dateFrom) params['date_from'] = filter.dateFrom;
      if (filter.dateTo) params['date_to'] = filter.dateTo;

      const data = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', params),
      );
      this.compSearchOptions.set(data.items.map((c) => ({ id: String(c.id), title: c.name })));
    } finally {
      this.compSearchLoading.set(false);
    }
  }

  protected onCompSelected(option: SearchDialogOption): void {
    this.draftCompId.set(String(option.id));
    this.draftCompTitle.set(option.title);
    this.showCompSearch.set(false);
  }

  protected unlinkComp(): void {
    this.draftCompId.set('');
    this.draftCompTitle.set('');
  }

  protected onBattleSearchFilter(filter: { search: string; dateFrom: string; dateTo: string }) {
    this.doBattleSearch(filter);
  }

  private async doBattleSearch(filter: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.battleSearchLoading.set(true);
    try {
      const params: Record<string, string> = {};
      if (filter.search) params['search'] = filter.search;
      const data = await firstValueFrom(this.api.get<any>('api/albionbb/battles', params));
      this.battleSearchOptions.set(
        (data.items || []).map((b: any) => ({
          id: b.id,
          title: `Battle ${b.id}`,
          subtitle: `${b.total_players} players · ${b.total_kills} kills`,
          chip: new Date(b.start_time).toLocaleString(),
        })),
      );
    } catch (err) {
      console.error(err);
    } finally {
      this.battleSearchLoading.set(false);
    }
  }

  protected onBattleSelected(option: SearchDialogOption): void {
    const current = this.draftBattleLinks();
    if (!current.find((b) => b.id === String(option.id))) {
      this.draftBattleLinks.set([...current, { id: String(option.id), title: option.title }]);
    }
    this.showBattleSearch.set(false);
  }

  protected removeDraftBattle(id: string): void {
    this.draftBattleLinks.update((list) => list.filter((b) => b.id !== id));
  }

  protected onSplitSearchFilter(filter: { search: string; dateFrom: string; dateTo: string }) {
    this.doSplitSearch(filter);
  }

  private async doSplitSearch(filter: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.splitSearchLoading.set(true);
    try {
      const params: Record<string, string> = { status: 'pending', limit: '50' };
      if (filter.search) params['search'] = filter.search;
      if (filter.dateFrom) params['date_from'] = filter.dateFrom;
      if (filter.dateTo) params['date_to'] = filter.dateTo;

      const data = await firstValueFrom(
        this.api.get<PaginatedData<SplitSummary>>('api/splits', params),
      );
      this.splitSearchOptions.set(
        data.items.map((s) => ({
          id: String(s.id),
          title: s.note || `Split #${s.id}`,
          subtitle: `Est. ${s.estimated_market_value} · By ${s.created_by_username}`,
          chip: s.status,
        })),
      );
    } catch (err) {
      console.error(err);
    } finally {
      this.splitSearchLoading.set(false);
    }
  }

  protected async onSplitSelected(option: SearchDialogOption): Promise<void> {
    this.showSplitSearch.set(false);
    try {
      await firstValueFrom(this.api.put(`api/splits/${option.id}`, { event_id: this.eventId }));
      this.toasts.success(this.t('events.detail.battles_saved'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async unlinkSplit(splitId: number): Promise<void> {
    try {
      await firstValueFrom(this.api.put(`api/splits/${splitId}`, { event_id: null }));
      this.toasts.success(this.t('events.detail.battles_saved'));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected backToEvents(): void {
    void this.router.navigate(['/events']);
  }

  protected toggleEditForm(): void {
    const detail = this.event();
    if (detail) {
      this.draftTitle.set(detail.title);
      this.draftDescription.set(detail.description || '');
      this.draftCompId.set(String(detail.active_comp_id || detail.comp_id));
      this.draftCompTitle.set(detail.comp_name || '');
      const d = new Date(detail.event_date_utc);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      this.draftScheduledAt.set(d.toISOString().slice(0, 16));
    }
    this.showEditForm.update((v) => !v);
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onScheduledAtChange(event: Event): void {
    this.draftScheduledAt.set((event.target as HTMLInputElement).value);
  }

  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
  }

  protected async onUpdateSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    if (!detail) {
      return;
    }

    const title = this.draftTitle().trim();
    if (!title) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const request: UpdateEventRequest = { title };
    const description = this.draftDescription().trim();
    request.description = description || undefined;
    const compId = Number(this.draftCompId());
    if (compId > 0) {
      request.comp_id = compId;
    }
    const scheduledAt = this.draftScheduledAt();
    if (scheduledAt) {
      request.event_date_utc = new Date(scheduledAt).toISOString();
    }

    this.saving.set(true);
    try {
      await firstValueFrom(this.api.patch(`api/events/${detail.id}`, request));
      this.showEditForm.set(false);
      await this.load();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected toggleBattleLinkForm(): void {
    if (this.showBattleLinkForm()) {
      this.showBattleLinkForm.set(false);
      return;
    }
    const detail = this.event();
    if (!detail) {
      return;
    }
    this.draftBattleLinks.set(
      detail.battles.map((b) => ({
        id: b.albionbb_battle_id,
        title: `Battle ${b.albionbb_battle_id}`,
      })),
    );
    this.showBattleLinkForm.set(true);
  }

  protected async onBattleLinksSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    if (!detail) {
      return;
    }
    this.battleLinksSaving.set(true);
    try {
      const ids = this.draftBattleLinks().map((b) => b.id);
      const req: UpdateEventBattlesRequest = { battle_ids: ids };
      await firstValueFrom(this.api.put(`api/events/${detail.id}/battles`, req));
      this.toasts.success(this.t('events.detail.battles_saved'));
      this.showBattleLinkForm.set(false);
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.battleLinksSaving.set(false);
    }
  }

  protected async deleteEvent(): Promise<void> {
    const detail = this.event();
    if (!detail) {
      return;
    }
    if (!window.confirm(this.t('events.detail.confirm_delete'))) {
      return;
    }

    try {
      await firstValueFrom(this.api.delete(`api/events/${detail.id}`));
      this.toasts.success(this.t('common.delete'));
      void this.router.navigate(['/events']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected canManage(): boolean {
    return this.auth.hasPermission('events.manage');
  }

  protected toggleJoinForm(): void {
    if (this.showJoinForm()) {
      this.showJoinForm.set(false);
      return;
    }
    const participation = this.currentParticipant();
    this.draftPrimaryBuildId.set(participation ? String(participation.primary_build_id) : '');
    this.draftSecondaryBuildId.set(
      participation?.secondary_build_id ? String(participation.secondary_build_id) : '',
    );
    this.joinError.set(null);
    this.showJoinForm.set(true);
    if (this.availableBuilds().length === 0) {
      void this.loadActiveComp();
    }
  }

  protected onPrimaryBuildChange(event: Event): void {
    this.draftPrimaryBuildId.set((event.target as HTMLSelectElement).value);
    this.joinError.set(null);
  }

  protected onSecondaryBuildChange(event: Event): void {
    this.draftSecondaryBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected async onJoinSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    if (!detail) {
      return;
    }

    const primaryBuildId = Number(this.draftPrimaryBuildId());
    if (primaryBuildId <= 0) {
      this.joinError.set(this.t('events.detail.primary_required'));
      return;
    }

    const request: ParticipateEventRequest = { primary_build_id: primaryBuildId };
    const secondaryRaw = this.draftSecondaryBuildId();
    if (secondaryRaw) {
      const secondaryBuildId = Number(secondaryRaw);
      if (secondaryBuildId > 0 && secondaryBuildId !== primaryBuildId) {
        request.secondary_build_id = secondaryBuildId;
      }
    }

    this.joinSubmitting.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<EventDetailView>(`api/events/${detail.id}/participate`, request),
      );
      this.event.set(updated);
      this.showJoinForm.set(false);
      this.toasts.success(this.t('events.detail.joined'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.joinSubmitting.set(false);
    }
  }

  protected async leave(id: number): Promise<void> {
    try {
      const updated = await firstValueFrom(
        this.api.delete<EventDetailView>(`api/events/${id}/participate`),
      );
      if (updated) {
        this.event.set(updated);
      } else {
        await this.load();
      }
      this.showJoinForm.set(false);
      this.toasts.success(this.t('events.detail.left'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async start(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/start`, 'POST', {});
  }

  protected async stop(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/stop`, 'POST', {});
  }

  protected openBattle(albionbbBattleId: string): void {
    void this.router.navigate(['/battles', albionbbBattleId]);
  }

  protected openBattleGroup(detail: EventDetailView): void {
    const ids = detail.battles.map((battle) => battle.albionbb_battle_id);
    if (ids.length === 0) {
      return;
    }
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  protected formatNumber(value: number | string): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  protected formatRatio(value: number): string {
    return value.toFixed(2);
  }

  protected roleLabel(role: BuildRole): TranslationKey {
    return ROLE_LABELS[role];
  }

  protected roleChip(role: BuildRole): string {
    return ROLE_CHIP[role];
  }

  protected fillPercent(current: number, target: number): number {
    if (target <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((current / target) * 100));
  }

  protected statusChip(status: EventStatus): string {
    if (status === 'live') {
      return 'chip chip--success';
    }
    if (status === 'auto_stopped') {
      return 'chip chip--warning';
    }
    return 'chip';
  }

  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  private async load(): Promise<void> {
    if (!this.eventId) {
      return;
    }
    this.loading.set(true);
    try {
      const detail = await firstValueFrom(
        this.api.get<EventDetailView>(`api/events/${this.eventId}`),
      );
      this.event.set(detail);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Loads the comps dropdown for the edit form (officers/admins only). */
  private async loadComps(): Promise<void> {
    try {
      const result = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 }),
      );
      this.comps.set(result.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  /** Loads the active comp builds so members can pick their primary/secondary. */
  private async loadActiveComp(): Promise<void> {
    const detail = this.event();
    if (!detail) {
      return;
    }
    const compId = detail.active_comp_id || detail.comp_id;
    if (!compId) {
      return;
    }

    this.compLoading.set(true);
    try {
      const comp = await firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`));
      this.availableBuilds.set(comp.builds ?? []);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compLoading.set(false);
    }
  }

  private async mutate(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<void> {
    try {
      if (method === 'POST') {
        await firstValueFrom(this.api.post<EventDetailView>(path, body));
      } else {
        await firstValueFrom(this.api.delete<EventDetailView>(path));
      }
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}

/**
 * Converts an ISO UTC timestamp into the `YYYY-MM-DDTHH:mm` value expected by
 * `<input type="datetime-local">`, expressed in the user's local timezone.
 */
function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Stable display order for build roles inside the participants panel.
 *
 * Tanks and healers come first because they are the hardest slots to fill;
 * brawler/battle_mount are niche roles and sit at the end.
 */
const ROLE_ORDER: readonly BuildRole[] = [
  'tank',
  'healer',
  'support',
  'dps',
  'battle_mount',
  'brawler',
];

/** Localized label key for each role. */
const ROLE_LABELS: Readonly<Record<BuildRole, TranslationKey>> = {
  tank: 'events.detail.role_tank',
  healer: 'events.detail.role_healer',
  support: 'events.detail.role_support',
  dps: 'events.detail.role_dps',
  battle_mount: 'events.detail.role_battle_mount',
  brawler: 'events.detail.role_brawler',
};

/** Chip color modifier per role for at-a-glance scanning of the comp. */
const ROLE_CHIP: Readonly<Record<BuildRole, string>> = {
  tank: 'chip chip--info',
  healer: 'chip chip--success',
  support: 'chip chip--warning',
  dps: 'chip chip--danger',
  battle_mount: 'chip',
  brawler: 'chip',
};

/** Aggregates participants and target capacity for a single role bucket. */
interface RoleGrouping {
  readonly role: BuildRole;
  target: number;
  participants: EventParticipant[];
}
