import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BattleDetail,
  BattleLossEstimate,
  BattleSummary,
  BuildDetail,
  BuildItemSlot,
  BuildRole,
  BuildSlot,
  CompBuildEntry,
  CompDetail,
  CompSummary,
  EventBattleSummary,
  EventDetailView,
  EventParticipant,
  OpponentPerformanceView,
  PaginatedData,
  ParticipateEventRequest,
  SplitSummary,
  UpdateEventBattlesRequest,
  UpdateEventRequest,
  UserProfile,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
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
  imports: [EmptyState, ErrorState, Loading, SearchDialog, Icon, DataTable, StatusChip],
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
                @if (detail.call_to_arms) {
                  <span class="cta-star" title="{{ t('events.call_to_arms') }}">★</span>
                }
                {{ detail.title }}
              </h1>
              <app-status-chip [value]="detail.status" />
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
            <span class="label">{{ t('common.description') }}</span>
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
                  <span class="truncate">{{ draftCompTitle() || t('events.detail.no_comp_linked') }}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--outline whitespace-nowrap"
                  (click)="showCompSearch.set(true)"
                >
                  {{ t('events.detail.link_comp') }}
                </button>
                @if (draftCompId()) {
                  <button
                    type="button"
                    class="btn btn--danger whitespace-nowrap"
                    (click)="unlinkComp()"
                    [attr.aria-label]="t('events.detail.unlink_comp')"
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
                [attr.min]="minScheduledAt"
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
          <label class="flex items-center gap-2">
            <input
              class="checkbox"
              type="checkbox"
              [checked]="draftCallToArms()"
              (change)="onCallToArmsChange($event)"
            />
            <span>{{ t('events.call_to_arms') }}</span>
          </label>
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
        <article class="surface p-4 sm:col-span-2 xl:col-span-4">
          <p class="event-detail__label">{{ t('events.detail.our_guild_loss') }}</p>
          <p class="event-detail__value">
            {{ formatCompact(eventLossEstimate().total_estimated_loss) }}
          </p>
          <p class="event-detail__sub">
            {{ eventLossEstimate().priced_items }} / {{ eventLossEstimate().total_items }}
            {{ t('events.detail.our_guild_loss_hint') }}
          </p>
        </article>
      </section>

      <section class="mt-5 grid gap-4 xl:grid-cols-3" aria-label="Event charts">
        <article class="surface p-4">
          <header class="event-detail__chart-header">
            <h2>{{ t('events.detail.battles') }}</h2>
            <span>{{ detail.stats.total_battles }}</span>
          </header>
          <div class="event-detail__donut" [style.--event-detail-chart-angle.deg]="winRateAngle()">
            <span>{{ formatPercent(detail.stats.win_rate) }}</span>
          </div>
          <div class="event-detail__legend">
            @for (row of outcomeChartRows(); track row.label) {
              <span><i [style.background]="row.color"></i>{{ row.label }}: {{ row.value }}</span>
            }
          </div>
        </article>

        <article class="surface p-4">
          <header class="event-detail__chart-header">
            <h2>{{ t('events.detail.opponents') }}</h2>
            <span>{{ detail.stats.top_opponents.length }}</span>
          </header>
          @if (opponentChartRows().length > 0) {
            <div class="event-detail__bar-list">
              @for (row of opponentChartRows(); track row.label) {
                <div class="event-detail__bar-row">
                  <div class="event-detail__bar-label">
                    <span>{{ row.label }}</span>
                    <strong>{{ formatCompact(row.value) }}</strong>
                  </div>
                  <div class="event-detail__fill-bar">
                    <span [style.width.%]="chartPercent(row.value, opponentChartRows())"></span>
                  </div>
                </div>
              }
            </div>
          } @else {
            <p class="event-detail__empty event-detail__empty--compact">
              {{ t('events.detail.no_opponents') }}
            </p>
          }
        </article>

        <article class="surface p-4">
          <header class="event-detail__chart-header">
            <h2>{{ t('events.detail.participants') }}</h2>
            <span
              >{{ participantsTotal() }} /
              {{ participantsTarget() || detail.active_comp_capacity }}</span
            >
          </header>
          <div class="event-detail__bar-list">
            @for (row of roleChartRows(); track row.label) {
              <div class="event-detail__bar-row">
                <div class="event-detail__bar-label">
                  <span>{{ row.label }}</span>
                  <strong>{{ row.value }} / {{ row.target || 0 }}</strong>
                </div>
                <div class="event-detail__fill-bar">
                  <span
                    [style.width.%]="row.target ? fillPercent(row.value, row.target) : 0"
                  ></span>
                </div>
              </div>
            }
          </div>
        </article>

        <article class="surface p-4 xl:col-span-3">
          <header class="event-detail__chart-header">
            <h2>{{ t('events.detail.our_guild_losses_by_player') }}</h2>
            <span>{{ formatCompact(eventLossEstimate().total_estimated_loss) }}</span>
          </header>
          @if (lossPlayerChartRows().length > 0) {
            <div class="event-detail__bar-list">
              @for (row of lossPlayerChartRows(); track row.label) {
                <div class="event-detail__bar-row">
                  <div class="event-detail__bar-label">
                    <span>{{ row.label }}</span>
                    <strong>{{ formatCompact(row.value) }}</strong>
                  </div>
                  <div class="event-detail__fill-bar">
                    <span [style.width.%]="chartPercent(row.value, lossPlayerChartRows())"></span>
                  </div>
                </div>
              }
            </div>
          } @else {
            <p class="event-detail__empty event-detail__empty--compact">
              No priced equipment losses for our guild members yet. Open linked battles or refresh
              battle data.
            </p>
          }
        </article>

        <article class="surface p-4 xl:col-span-3">
          <header class="event-detail__chart-header">
            <h2>{{ t('events.detail.splits') }}</h2>
            <span>{{ detail.split_stats.total_splits }}</span>
          </header>
          <div class="event-detail__status-grid">
            @for (row of splitStatusChartRows(); track row.label) {
              <div class="event-detail__status-card">
                <span>{{ row.label }}</span>
                <strong>{{ row.value }}</strong>
                <div class="event-detail__fill-bar">
                  <span [style.width.%]="chartPercent(row.value, splitStatusChartRows())"></span>
                </div>
              </div>
            }
          </div>
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
                  {{ t('events.detail.add_battle') }}
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
                      [attr.aria-label]="t('events.detail.remove_battle')"
                    >
                      <app-icon name="close" size="1rem" />
                    </button>
                  </div>
                }
                @if (draftBattleLinks().length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">
                    {{ t('events.detail.no_battles_linked') }}
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
                [class.chip--error]="!row.is_win"
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
                {{ t('events.detail.link_split') }}
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
              <span class="font-medium">{{ row.note || t('events.detail.split_number') + row.id }}</span>
            </ng-template>
            <ng-template dataTableCell="status" let-row>
              <app-status-chip [value]="row.status" />
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
                  [attr.aria-label]="t('events.detail.unlink_split')"
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

      @if (detail.status === 'scheduled' && canManageParticipants()) {
        <article class="event-detail__board mt-5 surface">
          @if (compLoading()) {
            <p class="event-detail__board-empty">{{ t('common.loading') }}</p>
          } @else if (availableBuilds().length === 0) {
            <p class="event-detail__board-empty">{{ t('events.detail.no_builds') }}</p>
          } @else {
            <div class="event-detail__board-header">
              <span class="event-detail__board-comp">
                {{ t('events.detail.comp') }}: {{ detail.active_comp_name }}
              </span>
              <span class="event-detail__board-count">
                {{ filledSlotsCount() }} / {{ compSlots().length }}
              </span>
            </div>

            <div class="event-detail__board-body">
              @for (group of compSlotsByRole(); track group.role) {
                <section class="event-detail__board-group">
                  <h3 class="event-detail__board-role">{{ t(roleLabel(group.role)) }}</h3>

                  @for (slot of group.slots; track slot.key) {
                    <div
                      class="event-detail__board-slot"
                      (mouseenter)="onSlotHover(slot)"
                      (mouseleave)="onSlotLeave()"
                    >
                      <button
                        type="button"
                        class="event-detail__board-slot-icon"
                        [class]="roleChip(slot.role)"
                        [attr.aria-label]="t('events.detail.view_loadout') + ': ' + slot.build.name"
                        [attr.aria-expanded]="slotTooltipVisible(slot)"
                        (click)="toggleSlotTooltip(slot)"
                      >
                        @if (weaponRenderIconUrl(slot); as icon) {
                          <img
                            class="event-detail__board-slot-render"
                            [src]="icon"
                            [alt]="slot.build.name"
                            loading="lazy"
                          />
                        } @else {
                          <span class="event-detail__board-slot-glyph">{{
                            roleGlyph(slot.role)
                          }}</span>
                        }
                      </button>
                      <span class="event-detail__board-slot-name">{{ slot.build.name }}</span>
                      <select
                        class="select event-detail__board-slot-select"
                        [value]="slotAssignmentValue(slot)"
                        (change)="onSlotAssign(slot, $event)"
                        [disabled]="slotSavingKey() === slot.key"
                      >
                        <option value="">{{ t('events.detail.select_player') }}</option>
                        @for (
                          participant of slotParticipantOptions(slot);
                          track participant.user_id
                        ) {
                          <option [value]="participant.user_id">
                            {{ participant.username }}
                          </option>
                        }
                        <option value="__add__">+ {{ t('events.detail.add_participant') }}</option>
                      </select>

                      @if (slotTooltipVisible(slot)) {
                        <div class="event-detail__tooltip" role="tooltip">
                          <div class="event-detail__tooltip-items">
                            @for (item of slotTooltipItems(slot.buildId); track item.slot) {
                              <div class="event-detail__tooltip-item">
                                @if (item.openalbion_item_icon) {
                                  <img
                                    [src]="renderItemIconUrl(item)"
                                    [alt]="item.openalbion_item_name"
                                    loading="lazy"
                                  />
                                } @else {
                                  <span class="event-detail__tooltip-item-placeholder">
                                    {{ slotGlyph(item.slot) }}
                                  </span>
                                }
                                <span class="event-detail__tooltip-item-name">
                                  {{ item.openalbion_item_name }}
                                </span>
                              </div>
                            } @empty {
                              <span class="event-detail__tooltip-empty">
                                {{ t('events.detail.no_build_items') }}
                              </span>
                            }
                          </div>
                        </div>
                      }
                    </div>
                  }
                </section>
              }
            </div>
          }
        </article>
      }
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else {
      <app-empty-state [message]="t('common.empty')" icon="calendar" />
    }

    @if (showCompSearch()) {
      <app-search-dialog
        [title]="t('events.detail.link_comp')"
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
        [title]="t('events.detail.search_battles')"
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
        [title]="t('events.detail.link_split')"
        [options]="splitSearchOptions()"
        [loading]="splitSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onSplitSearchFilter($event)"
        (select)="onSplitSelected($event)"
        (close)="showSplitSearch.set(false)"
      />
    }

    @if (showMemberSearch()) {
      <app-search-dialog
        [title]="t('events.detail.add_participant')"
        [options]="memberSearchOptions()"
        [loading]="memberSearchLoading()"
        [showDateFilters]="false"
        (filterChange)="onMemberSearchFilter($event)"
        (select)="onMemberSelected($event)"
        (close)="closeMemberSearch()"
      />
    }

    @if (draftMember(); as member) {
      <div class="modal-backdrop" (click)="closeMemberForm()" (keydown.escape)="closeMemberForm()">
        <div
          #assignBuildsPanel
          class="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="assign-builds-title"
          tabindex="-1"
          (click)="$event.stopPropagation()"
        >
          <header class="event-detail__section-header">
            <h2 id="assign-builds-title">{{ t('events.detail.assign_builds') }} · {{ member.title }}</h2>
            <button
              type="button"
              class="btn btn--ghost btn--icon"
              (click)="closeMemberForm()"
              [attr.aria-label]="t('common.close')"
            >
              <app-icon name="close" size="1rem" />
            </button>
          </header>
          <form class="grid gap-3 p-4" (submit)="onAddMemberSubmit($event)">
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
                  [value]="draftMemberPrimaryBuildId()"
                  (change)="onDraftMemberPrimaryChange($event)"
                >
                  <option value="">—</option>
                  @for (entry of availableBuilds(); track entry.build_id) {
                    <option [value]="entry.build_id">
                      {{ entry.build.name }} · {{ entry.build.role }}
                    </option>
                  }
                </select>
              </label>
              <label>
                <span class="label">{{ t('events.detail.secondary_build') }}</span>
                <select
                  class="select"
                  [value]="draftMemberSecondaryBuildId()"
                  (change)="onDraftMemberSecondaryChange($event)"
                >
                  <option value="">—</option>
                  @for (entry of availableBuilds(); track entry.build_id) {
                    <option [value]="entry.build_id">
                      {{ entry.build.name }}
                    </option>
                  }
                </select>
              </label>
            }
            @if (memberError()) {
              <p class="text-sm" style="color: var(--color-danger)">{{ memberError() }}</p>
            }
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost" (click)="closeMemberForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary" [disabled]="memberSaving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: `
    @layer components {
      /* Sticky only from sm up. On a phone this hero stacks the title,
         description and a wrapped row of join/leave/edit buttons — easily
         over half the viewport tall. Pinning that at all times left barely
         any room to see the event content it's supposed to introduce. */
      .event-detail__hero {
        z-index: 10;
      }
      @media (min-width: 640px) {
        .event-detail__hero {
          position: sticky;
          top: 0;
        }
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
      .event-detail__chart-header {
        align-items: center;
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 1rem;
      }
      .event-detail__chart-header h2,
      .event-detail__chart-header span {
        color: var(--color-text);
        font-weight: 700;
      }
      .event-detail__donut {
        --event-detail-chart-angle: 0deg;
        aspect-ratio: 1;
        background: conic-gradient(
          var(--color-success) 0deg var(--event-detail-chart-angle),
          var(--color-danger) var(--event-detail-chart-angle) 360deg
        );
        border-radius: 50%;
        display: grid;
        margin: 0 auto 1rem;
        max-width: 12rem;
        place-items: center;
        position: relative;
      }
      .event-detail__donut::after {
        background: var(--color-surface-1);
        border-radius: inherit;
        content: '';
        inset: 22%;
        position: absolute;
      }
      .event-detail__donut span {
        color: var(--color-text);
        font-weight: 800;
        position: relative;
        z-index: 1;
      }
      .event-detail__legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
      }
      .event-detail__legend span {
        align-items: center;
        color: var(--color-text-secondary);
        display: inline-flex;
        font-size: 0.8rem;
        gap: 0.35rem;
      }
      .event-detail__legend i {
        border-radius: var(--radius-full);
        display: inline-block;
        height: 0.625rem;
        width: 0.625rem;
      }
      .event-detail__bar-list {
        display: grid;
        gap: 0.85rem;
      }
      .event-detail__bar-row {
        display: grid;
        gap: 0.35rem;
      }
      .event-detail__bar-label {
        align-items: center;
        color: var(--color-text-secondary);
        display: flex;
        font-size: 0.8rem;
        justify-content: space-between;
        gap: 1rem;
      }
      .event-detail__bar-label strong {
        color: var(--color-text);
      }
      .event-detail__status-grid {
        display: grid;
        gap: 0.75rem;
        grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      }
      .event-detail__status-card {
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        display: grid;
        gap: 0.5rem;
        padding: 0.875rem;
      }
      .event-detail__status-card span {
        color: var(--color-text-secondary);
        font-size: 0.8rem;
      }
      .event-detail__status-card strong {
        color: var(--color-text);
        font-size: 1.25rem;
      }
      .event-detail__empty--compact {
        padding: 0;
      }

      .event-detail__board {
        border: 1px solid var(--color-border);
        border-radius: 0.5rem;
        overflow: hidden;
      }
      .event-detail__board-empty {
        padding: 1.5rem;
        text-align: center;
        color: var(--color-text-secondary);
      }
      .event-detail__board-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        background: var(--color-surface-1);
        border-bottom: 1px solid var(--color-border);
        font-size: 0.875rem;
        color: var(--color-text);
      }
      .event-detail__board-comp {
        font-weight: 600;
      }
      .event-detail__board-count {
        color: var(--color-text-secondary);
      }
      .event-detail__board-body {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
      .event-detail__board-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
      }
      .event-detail__board-role {
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-secondary);
        margin: 0 0 0.25rem 0.25rem;
      }
      .event-detail__board-slot {
        position: relative;
        display: grid;
        grid-template-columns: 2.25rem minmax(7rem, 1fr) minmax(0, 1.4fr);
        align-items: center;
        gap: 0.75rem;
        padding: 0.35rem 0.6rem;
        border-radius: 0.4rem;
        transition: background-color 120ms ease;
      }
      .event-detail__board-slot:hover {
        background: var(--color-surface-1);
      }
      .event-detail__board-slot-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.25rem;
        height: 2.25rem;
        border: none;
        border-radius: 0.4rem;
        background: var(--color-surface-1);
        overflow: hidden;
        padding: 0;
        cursor: pointer;
      }
      .event-detail__board-slot-icon:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
      }
      .event-detail__board-slot-render {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .event-detail__board-slot-glyph {
        font-size: 1rem;
        color: var(--color-text-secondary);
      }
      .event-detail__board-slot-name {
        font-weight: 600;
        color: var(--color-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event-detail__board-slot-select {
        width: 100%;
      }
      @media (max-width: 36rem) {
        .event-detail__board-slot {
          grid-template-columns: 2.25rem 1fr;
        }
        .event-detail__board-slot-select {
          grid-column: 1 / -1;
        }
      }

      /* left: 2.5rem + min-width: 18rem alone can exceed a phone's viewport
         width outright — now that a tap can pin this open (not just hover),
         it needs to not run off-screen there too. max-width is clamped to
         the viewport everywhere; below 30rem it also re-centers under the
         slot row instead of hanging off a fixed left offset, since that
         offset was sized for a wide desktop grid. */
      .event-detail__tooltip {
        position: absolute;
        top: calc(100% + 0.4rem);
        left: 2.5rem;
        z-index: 50;
        min-width: 18rem;
        max-width: min(26rem, calc(100vw - 2rem));
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 0.6rem;
        padding: 0.6rem;
        box-shadow: 0 0.6rem 1.5rem rgba(0, 0, 0, 0.35);
      }
      @media (max-width: 30rem) {
        .event-detail__tooltip {
          left: 50%;
          transform: translateX(-50%);
          min-width: 0;
          width: calc(100vw - 2rem);
        }
      }
      .event-detail__tooltip-items {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(5rem, 1fr));
        gap: 0.5rem;
      }
      .event-detail__tooltip-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.2rem;
        text-align: center;
      }
      .event-detail__tooltip-item img {
        width: 3rem;
        height: 3rem;
        object-fit: contain;
        background: var(--color-surface-1);
        border-radius: 0.3rem;
      }
      .event-detail__tooltip-item-placeholder {
        width: 3rem;
        height: 3rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 1.4rem;
        background: var(--color-surface-1);
        border-radius: 0.3rem;
      }
      .event-detail__tooltip-item-name {
        font-size: 0.7rem;
        color: var(--color-text);
        word-break: break-word;
      }
      .event-detail__tooltip-empty {
        color: var(--color-text-secondary);
        font-size: 0.8rem;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 1rem;
      }
      .modal-card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 0.75rem;
        max-width: 32rem;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
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
  protected readonly eventLossEstimate = signal<BattleLossEstimate>(emptyLossEstimate());
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly canEdit = signal(false);
  protected readonly showEditForm = signal(false);
  protected readonly saving = signal(false);
  protected readonly showBattleLinkForm = signal(false);

  protected readonly showCompSearch = signal(false);
  protected readonly compSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly compSearchLoading = signal(false);
  protected readonly draftCompTitle = signal('');

  protected readonly showBattleSearch = signal(false);
  /** Raw list of guild battles fetched from the backend (unfiltered). */
  protected readonly battleSearchRaw = signal<SearchDialogOption[]>([]);
  /** Current text typed into the battle search dialog. */
  protected readonly battleSearchTerm = signal('');
  /** Visible options after applying the client-side text filter. */
  protected readonly battleSearchOptions = computed<SearchDialogOption[]>(() => {
    const term = this.battleSearchTerm().trim().toLowerCase();
    const items = this.battleSearchRaw();
    if (!term) {
      return items;
    }
    return items.filter(
      (option) =>
        option.title.toLowerCase().includes(term) ||
        (option.subtitle?.toLowerCase().includes(term) ?? false) ||
        (option.chip?.toLowerCase().includes(term) ?? false),
    );
  });
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
  protected readonly draftCallToArms = signal(false);
  protected readonly draftScheduledAt = signal('');
  /** Floor for the reschedule date picker — mirrors event-create.ts's
   *  minScheduledAt(), same local-time-via-UTC-offset trick toggleEditForm()
   *  already uses below to populate the field itself. */
  protected readonly minScheduledAt = (() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  })();
  protected readonly showJoinForm = signal(false);
  protected readonly joinFormLoading = signal(false);
  protected readonly compLoading = signal(false);
  protected readonly joinSubmitting = signal(false);
  protected readonly joinError = signal<string | null>(null);
  protected readonly availableBuilds = signal<CompBuildEntry[]>([]);
  protected readonly draftPrimaryBuildId = signal('');
  protected readonly draftSecondaryBuildId = signal('');

  /** True for the event creator OR any user holding `events.manage`. */
  protected readonly canManageParticipants = computed(() => {
    const detail = this.event();
    const userId = this.auth.profile()?.user_id ?? null;
    if (userId === null) {
      return false;
    }
    return this.canManage() || detail?.created_by === userId;
  });

  /** Member picker state for the manual-add dialog. */
  protected readonly showMemberSearch = signal(false);
  protected readonly memberSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly memberSearchLoading = signal(false);
  protected readonly draftMember = signal<SearchDialogOption | null>(null);
  /** Same reasoning as regears.ts's dialog focus handling: this is a plain
   *  overlay `<div>`, not a native <dialog>, so nothing moves focus into it
   *  on open or gives it back on close without doing it by hand. */
  private readonly assignBuildsPanel = viewChild<ElementRef<HTMLElement>>('assignBuildsPanel');
  private previouslyFocusedMemberTrigger: HTMLElement | null = null;
  protected readonly draftMemberPrimaryBuildId = signal('');
  protected readonly draftMemberSecondaryBuildId = signal('');
  protected readonly memberSaving = signal(false);
  protected readonly memberError = signal<string | null>(null);

  /**
   * Draft board model: every comp build slot becomes a row in the grid.
   * `slotKey` is `${build_id}#${slotIndex}` and is stable across renders.
   */
  protected readonly slotAssignments = signal<Map<string, number | null>>(new Map());
  protected readonly slotSavingKey = signal<string | null>(null);
  protected readonly slotRemovingKey = signal<string | null>(null);
  /**
   * Build detail cache for hover tooltips and row icons. Preloaded in bulk
   * when the management board opens so the weapon render is visible immediately.
   */
  protected readonly buildDetails = signal<Map<number, BuildDetail>>(new Map());
  protected readonly buildDetailsLoading = signal<Set<number>>(new Set());
  protected readonly hoveredSlotKey = signal<string | null>(null);
  protected readonly pinnedSlotKey = signal<string | null>(null);
  /**
   * Maps each `build_id` to its weapon `BuildItemSlot` so row icons can render
   * the Albion item render without a separate lookup per row.
   */
  protected readonly buildWeaponByBuildId = computed<Map<number, BuildItemSlot>>(() => {
    const map = new Map<number, BuildItemSlot>();
    for (const [buildId, detail] of this.buildDetails()) {
      const weapon = detail.items.find((item) => item.slot === 'weapon');
      if (weapon) {
        map.set(buildId, weapon);
      }
    }
    return map;
  });
  /** Build id preselected when the user opens the manual-add dialog from a slot. */
  private readonly pendingAddSlotBuildId = signal<number | null>(null);
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
  protected readonly participantsTotal = computed(() => this.event()?.participants.length ?? 0);
  protected readonly participantsTarget = computed(() =>
    this.participantsByRole().reduce((sum, group) => sum + group.target, 0),
  );

  /**
   * Flat list of draft-board slots derived from the active comp.
   * Each `CompBuildEntry` with `quantity` N expands into N slot rows so the
   * UI can render a seat for every filled position, not just per build.
   */
  protected readonly compSlots = computed<CompSlotRow[]>(() => {
    const slots: CompSlotRow[] = [];
    for (const entry of this.availableBuilds()) {
      for (let slotIndex = 0; slotIndex < entry.quantity; slotIndex++) {
        const key = `${entry.build_id}#${slotIndex}`;
        slots.push({
          key,
          buildId: entry.build_id,
          build: entry.build,
          slotIndex,
          role: entry.build.role,
        });
      }
    }
    return slots;
  });
  /** Same list regrouped by role, preserving ROLE_ORDER for stable rendering. */
  protected readonly compSlotsByRole = computed<CompSlotGroup[]>(() => {
    const groups = new Map<BuildRole, CompSlotRow[]>();
    for (const slot of this.compSlots()) {
      let bucket = groups.get(slot.role);
      if (!bucket) {
        bucket = [];
        groups.set(slot.role, bucket);
      }
      bucket.push(slot);
    }
    return ROLE_ORDER.filter((role) => groups.has(role)).map((role) => ({
      role,
      slots: groups.get(role) ?? [],
    }));
  });
  /**
   * Mirror of `compSlots` rebuilt whenever the backend snapshot changes so the
   * initial assignment state is recomputed. Local edits go into
   * `slotAssignments` which overrides these defaults until saved.
   */
  protected readonly initialSlotAssignments = computed<Map<string, number | null>>(() => {
    const slots = this.compSlots();
    const detail = this.event();
    const assignments = new Map<string, number | null>();
    if (slots.length === 0 || !detail) {
      return assignments;
    }
    // Group participants by their primary build id so we can pop them off as
    // we walk the slots, leaving surplus participants unassigned.
    const byBuild = new Map<number, EventParticipant[]>();
    for (const participant of detail.participants) {
      const bucket = byBuild.get(participant.primary_build_id);
      if (bucket) {
        bucket.push(participant);
      } else {
        byBuild.set(participant.primary_build_id, [participant]);
      }
    }
    for (const slot of slots) {
      const bucket = byBuild.get(slot.buildId);
      const next = bucket?.shift();
      assignments.set(slot.key, next ? next.user_id : null);
    }
    return assignments;
  });
  /** Participants not assigned to any slot (orphans after a comp swap). */
  protected readonly unassignedParticipants = computed<EventParticipant[]>(() => {
    const detail = this.event();
    if (!detail) {
      return [];
    }
    const assigned = new Set<number>();
    for (const value of this.resolvedAssignments().values()) {
      if (value !== null) {
        assigned.add(value);
      }
    }
    return detail.participants.filter((participant) => !assigned.has(participant.user_id));
  });
  /**
   * Local overrides layered on top of `initialSlotAssignments` so we can show
   * drafts before they hit the backend.
   */
  protected readonly resolvedAssignments = computed<Map<string, number | null>>(() => {
    const merged = new Map<string, number | null>(this.initialSlotAssignments());
    for (const [key, value] of this.slotAssignments()) {
      merged.set(key, value);
    }
    return merged;
  });
  /** Number of slots currently filled in the resolved state. */
  protected readonly filledSlotsCount = computed(() => {
    let count = 0;
    for (const value of this.resolvedAssignments().values()) {
      if (value !== null) {
        count++;
      }
    }
    return count;
  });
  protected readonly outcomeChartRows = computed<ChartMetric[]>(() => {
    const stats = this.event()?.stats;
    if (!stats) {
      return [];
    }
    return [
      { label: this.t('events.detail.wins'), value: stats.wins, color: 'var(--color-success)' },
      { label: this.t('events.detail.losses'), value: stats.losses, color: 'var(--color-danger)' },
    ];
  });
  protected readonly opponentChartRows = computed<ChartMetric[]>(() =>
    (this.event()?.stats.top_opponents ?? []).map((opponent) => ({
      label: opponent.guild_name || this.t('common.none'),
      value: Math.max(opponent.opponent_kill_fame, opponent.battles),
      color: 'var(--color-warning)',
    })),
  );
  protected readonly roleChartRows = computed<ChartMetric[]>(() =>
    this.participantsByRole().map((group) => ({
      label: this.t(this.roleLabel(group.role)),
      value: group.participants.length,
      target: group.target,
      color: 'var(--color-info)',
    })),
  );
  protected readonly lossPlayerChartRows = computed<ChartMetric[]>(() =>
    this.eventLossEstimate()
      .players.slice(0, 10)
      .map((player) => ({
        label: player.player_name,
        value: player.estimated_loss,
        color: 'var(--color-danger)',
      })),
  );
  protected readonly splitStatusChartRows = computed<ChartMetric[]>(() => {
    const stats = this.event()?.split_stats;
    if (!stats) {
      return [];
    }
    return [
      { label: 'Pending', value: stats.pending_splits, color: 'var(--color-warning)' },
      { label: 'Completed', value: stats.completed_splits, color: 'var(--color-success)' },
      {
        label: 'Not completed',
        value: stats.not_completed_splits,
        color: 'var(--color-text-secondary)',
      },
      { label: 'Lost', value: stats.lost_splits, color: 'var(--color-danger)' },
    ];
  });
  protected readonly winRateAngle = computed(
    () => ((this.event()?.stats.win_rate ?? 0) / 100) * 360,
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

    effect(() => {
      if (this.draftMember() !== null) {
        this.previouslyFocusedMemberTrigger = document.activeElement as HTMLElement | null;
        this.assignBuildsPanel()?.nativeElement.focus();
      } else if (this.previouslyFocusedMemberTrigger) {
        this.previouslyFocusedMemberTrigger.focus();
        this.previouslyFocusedMemberTrigger = null;
      }
    });
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
    // `/api/battles` is guild-scoped and does not accept a search parameter,
    // so the text filter is applied client-side over the already-loaded
    // battles. The backend is only hit on dialog open.
    this.battleSearchTerm.set(filter.search);
    if (this.battleSearchRaw().length === 0) {
      void this.loadGuildBattles();
    }
  }

  private async loadGuildBattles(): Promise<void> {
    this.battleSearchLoading.set(true);
    try {
      // Use the guild-scoped endpoint: the backend only returns battles
      // involving the configured Weaklings guild, so members cannot
      // accidentally link foreign battles to an event.
      const data = await firstValueFrom(this.api.get<PaginatedData<BattleSummary>>('api/battles'));
      this.battleSearchRaw.set(
        data.items.map((battle) => ({
          id: battle.battle_id,
          title: `Battle ${battle.battle_id}`,
          subtitle: `${battle.total_players} players · ${battle.total_kills} kills`,
          chip: new Date(battle.start_time).toLocaleString(),
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
    if (!confirm(this.t('common.confirm'))) return;
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
      this.draftCallToArms.set(detail.call_to_arms);
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

  /** Two-way bind helper for the call-to-arms checkbox in the edit form. */
  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
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
    request.call_to_arms = this.draftCallToArms();
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

  /**
   * Returns the user id currently assigned to a slot, honouring local draft
   * overrides. Returns `null` when the slot is empty.
   */
  protected slotAssignment(slot: CompSlotRow): number | null {
    return this.resolvedAssignments().get(slot.key) ?? null;
  }

  /**
   * Stringified assignment for `<select [value]>` bindings. Angular templates
   * cannot reference the global `String` constructor, so we expose this helper
   * to coerce numbers into option values.
   */
  protected slotAssignmentValue(slot: CompSlotRow): string {
    const value = this.slotAssignment(slot);
    return value === null ? '' : String(value);
  }

  /**
   * True when the slot's local draft differs from the persisted snapshot.
   * Drives the per-row Save button enabled state.
   */
  protected isSlotDirty(slot: CompSlotRow): boolean {
    const initial = this.initialSlotAssignments().get(slot.key) ?? null;
    const current = this.slotAssignment(slot);
    return initial !== current;
  }

  /**
   * Fires when an officer picks or clears a player on a slot. Auto-saves
   * immediately — no Submit button. When the slot had a previous occupant
   * who is being replaced, the old user's participation is deleted first.
   */
  protected async onSlotAssign(slot: CompSlotRow, event: Event): Promise<void> {
    const value = (event.target as HTMLSelectElement).value;
    if (value === '__add__') {
      this.pendingAddSlotBuildId.set(slot.buildId);
      this.openMemberSearch();
      (event.target as HTMLSelectElement).value = this.slotAssignmentValue(slot);
      return;
    }

    const userId = value ? Number(value) : null;
    const detail = this.event();
    if (!detail) {
      return;
    }

    // Optimistically update local state.
    const next = new Map(this.slotAssignments());
    if (userId !== null) {
      for (const [key, assigned] of next) {
        if (assigned === userId && key !== slot.key) {
          next.set(key, null);
        }
      }
    }
    next.set(slot.key, userId);
    this.slotAssignments.set(next);

    this.slotSavingKey.set(slot.key);
    try {
      if (userId === null) {
        // Slot cleared: delete the previous occupant if one was persisted.
        const previous = this.initialSlotAssignments().get(slot.key) ?? null;
        if (previous !== null) {
          const updated = await firstValueFrom(
            this.api.delete<EventDetailView>(`api/events/${detail.id}/participants/${previous}`),
          );
          if (updated) {
            this.event.set(updated);
          }
        }
      } else {
        const updated = await firstValueFrom(
          this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${userId}`, {
            primary_build_id: slot.buildId,
          }),
        );
        this.event.set(updated);
      }
      this.slotAssignments.update((map) => {
        const cleaned = new Map(map);
        cleaned.delete(slot.key);
        return cleaned;
      });
    } catch (error) {
      // Revert local state on failure.
      this.slotAssignments.update((map) => {
        const reverted = new Map(map);
        reverted.delete(slot.key);
        return reverted;
      });
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.slotSavingKey.set(null);
    }
  }

  /** Shows the tooltip on hover. Build details are preloaded. */
  protected onSlotHover(slot: CompSlotRow): void {
    this.hoveredSlotKey.set(slot.key);
  }

  protected onSlotLeave(): void {
    this.hoveredSlotKey.set(null);
  }

  /**
   * Tap/click-to-pin fallback for the loadout tooltip. `mouseenter` never
   * fires on touch, so without this the equipment preview was entirely
   * unreachable on phones and tablets — this also gives keyboard users a
   * real activation instead of relying on hover.
   */
  protected toggleSlotTooltip(slot: CompSlotRow): void {
    this.pinnedSlotKey.update((current) => (current === slot.key ? null : slot.key));
  }

  protected slotTooltipItems(buildId: number): BuildItemSlot[] {
    const detail = this.buildDetails().get(buildId);
    if (!detail) {
      return [];
    }
    return [...detail.items].sort(sortBySlotOrder);
  }

  protected slotTooltipVisible(slot: CompSlotRow): boolean {
    const isActive = this.hoveredSlotKey() === slot.key || this.pinnedSlotKey() === slot.key;
    return isActive && this.buildDetails().has(slot.buildId);
  }

  /**
   * Converts any stored icon reference into Sandbox Interactive's public PNG
   * render endpoint. Older build rows may still hold CDN/OpenAlbion URLs; this
   * extracts the Albion item identifier (for example `T8_2H_HAMMER_UNDEAD`)
   * and rebuilds the canonical render URL used by Albion itself.
   */
  protected weaponRenderIconUrl(slot: CompSlotRow): string {
    const weapon = this.buildWeaponByBuildId().get(slot.buildId);
    return weapon ? this.renderItemIconUrl(weapon) : '';
  }

  protected renderItemIconUrl(item: BuildItemSlot): string {
    const icon = item.openalbion_item_icon?.trim();
    if (!icon) {
      return '';
    }
    const identifier = icon
      .split('/')
      .pop()
      ?.split('?')
      .shift()
      ?.split('@')
      .shift()
      ?.replace(/\.png$/i, '')
      .trim();
    if (!identifier) {
      return icon;
    }
    return `https://render.albiononline.com/v1/item/${encodeURIComponent(identifier)}.png?quality=1&size=96`;
  }

  /**
   * Resolves a slot's local assignment to the corresponding participant row
   * so the template can render the username next to the dropdown.
   */
  protected slotParticipant(slot: CompSlotRow): EventParticipant | null {
    const userId = this.slotAssignment(slot);
    if (userId === null) {
      return null;
    }
    return this.event()?.participants.find((participant) => participant.user_id === userId) ?? null;
  }

  /**
   * Users available to assign to a slot. Includes the slot's current occupant
   * plus any user not yet pinned to another slot, so the dropdown stays valid
   * after each pick.
   */
  protected slotParticipantOptions(slot: CompSlotRow): EventParticipant[] {
    const detail = this.event();
    if (!detail) {
      return [];
    }
    const assignedElsewhere = new Set<number>();
    for (const [key, value] of this.resolvedAssignments()) {
      if (key !== slot.key && value !== null) {
        assignedElsewhere.add(value);
      }
    }
    return detail.participants.filter((participant) => !assignedElsewhere.has(participant.user_id));
  }

  /** Persists the local draft for a single slot via the officer endpoint. */
  protected async saveSlot(slot: CompSlotRow): Promise<void> {
    const detail = this.event();
    if (!detail) {
      return;
    }
    const userId = this.slotAssignment(slot);
    if (userId === null) {
      this.toasts.error(this.t('events.detail.no_builds_assigned'));
      return;
    }

    this.slotSavingKey.set(slot.key);
    try {
      const updated = await firstValueFrom(
        this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${userId}`, {
          primary_build_id: slot.buildId,
        }),
      );
      this.event.set(updated);
      this.slotAssignments.update((map) => {
        const next = new Map(map);
        next.delete(slot.key);
        return next;
      });
      this.toasts.success(this.t('events.detail.participant_updated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.slotSavingKey.set(null);
    }
  }

  /**
   * Empties a slot on the draft board. If the user is persisted on the
   * backend, we DELETE their participation; otherwise we just clear the
   * local override.
   */
  protected async clearSlot(slot: CompSlotRow): Promise<void> {
    const detail = this.event();
    if (!detail) {
      return;
    }
    const userId = this.slotAssignment(slot);
    if (userId === null) {
      // Nothing to clear: just drop any local override.
      this.slotAssignments.update((map) => {
        const next = new Map(map);
        next.set(slot.key, null);
        return next;
      });
      return;
    }

    const participant = detail.participants.find((p) => p.user_id === userId);
    if (
      participant &&
      !window.confirm(`${this.t('events.detail.remove_participant')} — ${participant.username}?`)
    ) {
      return;
    }

    this.slotRemovingKey.set(slot.key);
    try {
      const updated = await firstValueFrom(
        this.api.delete<EventDetailView>(`api/events/${detail.id}/participants/${userId}`),
      );
      if (updated) {
        this.event.set(updated);
      } else {
        await this.load();
      }
      this.slotAssignments.update((map) => {
        const next = new Map(map);
        next.set(slot.key, null);
        return next;
      });
      this.toasts.success(this.t('events.detail.participant_removed'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.slotRemovingKey.set(null);
    }
  }

  /** Opens the member search dialog used to manually add someone. */
  protected openMemberSearch(): void {
    this.showMemberSearch.set(true);
    if (this.memberSearchOptions().length === 0) {
      void this.onMemberSearchFilter({ search: '', dateFrom: '', dateTo: '' });
    }
  }

  protected closeMemberSearch(): void {
    this.showMemberSearch.set(false);
  }

  protected async onMemberSearchFilter(filter: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.memberSearchLoading.set(true);
    try {
      const params: Record<string, string> = { limit: '50' };
      if (filter.search) {
        params['username'] = filter.search;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', params),
      );
      const existing = new Set((this.event()?.participants ?? []).map((p) => p.user_id));
      this.memberSearchOptions.set(
        data.items
          .filter((user) => !existing.has(user.id))
          .map((user) => ({
            id: user.id,
            title: user.username,
            subtitle: user.email || undefined,
            chip: user.role,
          })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.memberSearchLoading.set(false);
    }
  }

  /** User picked from the search dialog: open the build assignment form. */
  protected onMemberSelected(option: SearchDialogOption): void {
    this.draftMember.set(option);
    // Pre-fill the primary build when the dialog was triggered from a slot.
    const preselectedBuildId = this.pendingAddSlotBuildId();
    this.draftMemberPrimaryBuildId.set(
      preselectedBuildId !== null ? String(preselectedBuildId) : '',
    );
    this.draftMemberSecondaryBuildId.set('');
    this.memberError.set(null);
    this.showMemberSearch.set(false);
    this.pendingAddSlotBuildId.set(null);
    if (this.availableBuilds().length === 0) {
      void this.loadActiveComp();
    }
  }

  protected closeMemberForm(): void {
    this.draftMember.set(null);
    this.draftMemberPrimaryBuildId.set('');
    this.draftMemberSecondaryBuildId.set('');
    this.memberError.set(null);
  }

  protected onDraftMemberPrimaryChange(event: Event): void {
    this.draftMemberPrimaryBuildId.set((event.target as HTMLSelectElement).value);
    this.memberError.set(null);
  }

  protected onDraftMemberSecondaryChange(event: Event): void {
    this.draftMemberSecondaryBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected async onAddMemberSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    const member = this.draftMember();
    if (!detail || !member) {
      return;
    }
    const primaryBuildId = Number(this.draftMemberPrimaryBuildId());
    if (primaryBuildId <= 0) {
      this.memberError.set(this.t('events.detail.no_builds_assigned'));
      return;
    }

    const body: ParticipateEventRequest = { primary_build_id: primaryBuildId };
    const secondaryRaw = this.draftMemberSecondaryBuildId();
    if (secondaryRaw) {
      const secondaryBuildId = Number(secondaryRaw);
      if (secondaryBuildId > 0 && secondaryBuildId !== primaryBuildId) {
        body.secondary_build_id = secondaryBuildId;
      }
    }

    this.memberSaving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${member.id}`, body),
      );
      this.event.set(updated);
      this.closeMemberForm();
      this.toasts.success(this.t('events.detail.participant_added'));
    } catch (error) {
      this.memberError.set(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.memberSaving.set(false);
    }
  }

  protected async start(id: number): Promise<void> {
    await this.mutate(`api/events/${id}/start`, 'POST', {});
  }

  /** Stopping closes participation and triggers regear extraction from every
   *  linked battle — a real, mostly-irreversible consequence, unlike `leave`. */
  protected async stop(id: number): Promise<void> {
    if (!confirm(this.t('common.confirm'))) return;
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

  /**
   * Compact glyph shown in the slot row's leading badge. Kept short so it fits
   * in a 1.5rem square without overflowing on narrow screens.
   */
  protected roleGlyph(role: BuildRole): string {
    return ROLE_GLYPH[role] ?? '•';
  }

  /**
   * Fallback icon for equipment slots that lack a remote image, mirroring the
   * Albion paperdoll layout the user is already familiar with.
   */
  protected slotGlyph(slot: BuildSlot): string {
    return SLOT_GLYPH[slot] ?? '•';
  }

  protected slotLabel(slot: BuildSlot): string {
    return SLOT_LABELS[slot] ?? slot;
  }

  protected fillPercent(current: number, target: number): number {
    if (target <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((current / target) * 100));
  }

  protected chartPercent(value: number, rows: readonly ChartMetric[]): number {
    const maxValue = rows.reduce((max, row) => Math.max(max, row.value), 0);
    if (maxValue <= 0) {
      return 0;
    }
    return Math.max(4, Math.round((value / maxValue) * 100));
  }

  protected opponentKey(opponent: OpponentPerformanceView): string {
    return opponent.guild_id ?? opponent.guild_name;
  }

  protected async load(): Promise<void> {
    if (!this.eventId) {
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(
        this.api.get<EventDetailView>(`api/events/${this.eventId}`),
      );
      this.event.set(detail);
      this.eventLossEstimate.set(detail.estimated_losses ?? emptyLossEstimate());
      await Promise.all([this.loadActiveComp(), this.loadLinkedBattleLosses(detail)]);
    } catch (error) {
      this.loadFailed.set(true);
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
      // Preload every build's details so the row weapon render and tooltip
      // items are available without per-row hover requests.
      void this.preloadBuildDetails(comp.builds ?? []);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compLoading.set(false);
    }
  }

  /**
   * Fetches `BuildDetail` for every build in the comp in parallel and merges
   * the results into `buildDetails`. Already-cached builds are skipped so
   * repeated calls (e.g. after a comp swap) only fetch the new entries.
   */
  private async preloadBuildDetails(entries: readonly CompBuildEntry[]): Promise<void> {
    const cache = this.buildDetails();
    const missing = entries.filter((entry) => !cache.has(entry.build_id));
    if (missing.length === 0) {
      return;
    }
    const results = await Promise.allSettled(
      missing.map((entry) =>
        firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${entry.build_id}`)),
      ),
    );
    const next = new Map(this.buildDetails());
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        next.set(missing[index].build_id, result.value);
      }
    });
    this.buildDetails.set(next);
  }

  private async loadLinkedBattleLosses(detail: EventDetailView): Promise<void> {
    if (detail.battles.length === 0) {
      return;
    }
    try {
      const battleDetails = await Promise.all(
        detail.battles.map((battle) =>
          firstValueFrom(
            this.api.get<BattleDetail>(`api/battles/${battle.albionbb_battle_id}`),
          ).catch(() => null),
        ),
      );
      const estimates = battleDetails
        .filter((battle): battle is BattleDetail => battle !== null)
        .map((battle) => battle.estimated_losses);
      if (estimates.length === 0) {
        return;
      }
      this.eventLossEstimate.set(mergeLossEstimates(estimates));
    } catch (error) {
      console.error(error);
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
function emptyLossEstimate(): BattleLossEstimate {
  return {
    total_estimated_loss: 0,
    priced_items: 0,
    total_items: 0,
    players: [],
    guilds: [],
  };
}

function mergeLossEstimates(estimates: readonly BattleLossEstimate[]): BattleLossEstimate {
  const merged = emptyLossEstimate();
  const playerRows = new Map<string, BattleLossEstimate['players'][number]>();
  const guildRows = new Map<string, BattleLossEstimate['guilds'][number]>();

  for (const estimate of estimates) {
    merged.total_estimated_loss += estimate.total_estimated_loss;
    merged.priced_items += estimate.priced_items;
    merged.total_items += estimate.total_items;
    for (const player of estimate.players) {
      const row = playerRows.get(player.player_name) ?? {
        ...player,
        estimated_loss: 0,
        deaths: 0,
        priced_items: 0,
        total_items: 0,
      };
      row.estimated_loss += player.estimated_loss;
      row.deaths += player.deaths;
      row.priced_items += player.priced_items;
      row.total_items += player.total_items;
      playerRows.set(player.player_name, row);
    }
    for (const guild of estimate.guilds) {
      const row = guildRows.get(guild.guild_name) ?? {
        ...guild,
        estimated_loss: 0,
        deaths: 0,
        priced_items: 0,
        total_items: 0,
      };
      row.estimated_loss += guild.estimated_loss;
      row.deaths += guild.deaths;
      row.priced_items += guild.priced_items;
      row.total_items += guild.total_items;
      guildRows.set(guild.guild_name, row);
    }
  }

  merged.players = Array.from(playerRows.values()).sort(
    (left, right) => right.estimated_loss - left.estimated_loss,
  );
  merged.guilds = Array.from(guildRows.values()).sort(
    (left, right) => right.estimated_loss - left.estimated_loss,
  );
  return merged;
}

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
  dps: 'chip chip--error',
  battle_mount: 'chip',
  brawler: 'chip',
};

/**
 * Unicode role icons rendered as plain text so the slot row stays light and
 * doesn't depend on a font-icon set when used inside a tooltip.
 */
const ROLE_GLYPH: Readonly<Record<BuildRole, string>> = {
  tank: '♜',
  healer: '✚',
  support: '✦',
  dps: '⚒',
  battle_mount: '♞',
  brawler: '◈',
};

const SLOT_GLYPH: Readonly<Record<BuildSlot, string>> = {
  weapon: '⚔',
  off_hand: '◉',
  head: '⛑',
  armor: '▣',
  shoes: '👞',
  cape: '🜂',
  bag: '🎒',
  potion: '⚗',
  food: '🍲',
  mount: '♞',
};

const SLOT_LABELS: Readonly<Record<BuildSlot, string>> = {
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

/** Aggregates participants and target capacity for a single role bucket. */
interface RoleGrouping {
  readonly role: BuildRole;
  target: number;
  participants: EventParticipant[];
}

interface ChartMetric {
  readonly label: string;
  readonly value: number;
  readonly color: string;
  readonly target?: number;
}

/**
 * One seat on the draft board: a build instance plus the role it belongs to.
 * `key` is `${build_id}#${slotIndex}` so Angular can `trackBy` it.
 */
interface CompSlotRow {
  readonly key: string;
  readonly buildId: number;
  readonly build: import('../../core/models/api.models').BuildSummary;
  readonly slotIndex: number;
  readonly role: BuildRole;
}

interface CompSlotGroup {
  readonly role: BuildRole;
  readonly slots: readonly CompSlotRow[];
}

const SLOT_ORDER: BuildSlot[] = [
  'weapon',
  'off_hand',
  'head',
  'armor',
  'shoes',
  'cape',
  'bag',
  'potion',
  'food',
  'mount',
];

function sortBySlotOrder(left: BuildItemSlot, right: BuildItemSlot): number {
  return SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot);
}
