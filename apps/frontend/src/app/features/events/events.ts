import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CompSummary,
  CreateEventRequest,
  DiscordRoleView,
  EventStatus,
  EventView,
  PaginatedData,
  SplitIsland,
  SplitIslandCity,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

import { TooltipDirective } from '../../shared/directives/tooltip.directive';

const PAGE_SIZE = 10;
const EVENT_STATUSES: readonly EventStatus[] = ['scheduled', 'live', 'stopped', 'auto_stopped', 'cancelled'];

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  date: 'event_date_utc',
  status: 'status',
};

/**
 * Events list page.
 *
 * Server-driven table of guild events. Create lives in a native `<dialog>`
 * (focus trap, Esc, light-dismiss) so `/events/new` is no longer a route.
 * Row actions stay compact: Open is primary, Join still lands on detail,
 * and Start/Stop/Leave stay on the detail page.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, Dialog, Icon, PageHeader, PageStack, TooltipDirective],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
    .status-tab-group {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      overflow-x: auto;
      padding: 0.25rem 0;
    }
    .status-tab {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-text-secondary);
      border: 1px solid transparent;
      background: transparent;
      transition: all var(--motion-fast);
      white-space: nowrap;
      cursor: pointer;
    }
    .status-tab:hover {
      color: var(--color-text);
      background: var(--color-surface-hover);
    }
    .status-tab--active {
      color: var(--color-text);
      background: var(--color-surface-1);
      border-color: var(--color-border);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.25rem 0.625rem;
      border-radius: 9999px;
      font-size: 0.6875rem;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .status-pill--live {
      background: rgba(34, 197, 94, 0.12);
      color: #4ade80;
      border: 1px solid rgba(34, 197, 94, 0.25);
    }
    .status-pill--scheduled {
      background: rgba(56, 189, 248, 0.12);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .status-pill--stopped {
      background: rgba(148, 163, 184, 0.12);
      color: #94a3b8;
      border: 1px solid rgba(148, 163, 184, 0.25);
    }
    .status-pill--cancelled {
      background: rgba(239, 68, 68, 0.12);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.25);
    }
  `,
  template: `
    <app-page-header [title]="t('events.title')" [subtitle]="t('events.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canCreate()) {
        <button
          type="button"
          class="btn btn--primary btn--sm"
          (click)="openCreate()"
          [appTooltip]="t('events.new')"
          tooltipPosition="bottom"
        >
          <app-icon name="plus" size="0.875rem" />
          {{ t('events.new') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <!-- KPI Row: 4 Modern Cards -->
      <section class="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Events summary">
        <!-- Card 1: Total -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('events.stat.total') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                {{ totalItems() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                All scheduled & past events
              </p>
            </div>
            <div class="icon-capsule bg-sky-500/10 text-sky-400 border border-sky-500/20">
              <app-icon name="calendar" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 2: Live Now -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('events.stat.live') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                {{ liveCount() }}
              </p>
              <p class="text-xs text-emerald-400/90 mt-1 truncate flex items-center gap-1.5">
                @if (liveCount() > 0) {
                  <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Active war rooms
                } @else {
                  No events live
                }
              </p>
            </div>
            <div class="icon-capsule bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <app-icon name="sparkles" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 3: Scheduled -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('events.stat.scheduled') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                {{ scheduledCount() }}
              </p>
              <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                Upcoming deployments
              </p>
            </div>
            <div class="icon-capsule bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
              <app-icon name="calendar" size="1.25rem" />
            </div>
          </div>
        </article>

        <!-- Card 4: Call To Arms -->
        <article class="kpi-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                {{ t('events.stat.cta') }}
              </p>
              <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                {{ ctaCount() }}
              </p>
              <p class="text-xs text-amber-400/90 mt-1 truncate flex items-center gap-1">
                Mandatory guild CTA
              </p>
            </div>
            <div class="icon-capsule bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <app-icon name="alert" size="1.25rem" />
            </div>
          </div>
        </article>
      </section>

      <!-- LIVE / CTA HIGHLIGHT BANNER -->
      @if (liveEvents().length > 0) {
        <div class="grid gap-3" aria-label="Live events">
          @for (liveEvent of liveEvents(); track liveEvent.id) {
            <div
              class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-emerald-500/40 bg-gradient-to-r from-emerald-950/25 via-[var(--color-surface)] to-[var(--color-surface)] shadow-lg hover:border-emerald-500/70 cursor-pointer transition-all"
              (click)="openEventDetail(liveEvent.id)"
            >
              <div class="flex items-center gap-3.5">
                <span class="relative flex h-3.5 w-3.5 flex-shrink-0">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
                </span>
                <div>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-bold text-base text-white">{{ liveEvent.title }}</span>
                    @if (liveEvent.call_to_arms) {
                      <span class="px-2 py-0.5 rounded-full text-[0.6875rem] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                        ★ CALL TO ARMS
                      </span>
                    }
                    <span class="status-pill status-pill--live">
                      LIVE NOW
                    </span>
                  </div>
                  <div class="text-xs text-[var(--color-text-secondary)] mt-1 flex flex-wrap items-center gap-2">
                    <span class="inline-flex items-center gap-1 text-[var(--color-text)]">
                      <app-icon name="swords" size="0.75rem" />
                      {{ liveEvent.comp_name }}
                    </span>
                    <span>&middot;</span>
                    <span>{{ formatDate(liveEvent.event_date_utc) }}</span>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="btn btn--primary btn--sm inline-flex items-center gap-1.5 font-semibold"
                  (click)="$event.stopPropagation(); openEventDetail(liveEvent.id)"
                >
                  <app-icon name="swords" size="0.75rem" />
                  Enter War Room &rarr;
                </button>
              </div>
            </div>
          }
        </div>
      }

      <!-- Status Filter Tabs -->
      <section class="flex flex-wrap items-center justify-between gap-3 pt-1">
        <nav class="status-tab-group" aria-label="Events status filter">
          <button
            type="button"
            class="status-tab"
            [class.status-tab--active]="statusFilter() === ''"
            (click)="setStatusFilter('')"
          >
            <span>{{ t('common.all') }}</span>
            <span class="rounded-full bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[0.6875rem] font-mono">
              {{ totalItems() }}
            </span>
          </button>

          <button
            type="button"
            class="status-tab"
            [class.status-tab--active]="statusFilter() === 'live'"
            (click)="setStatusFilter('live')"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>{{ t('events.stat.live') }}</span>
            @if (liveCount() > 0) {
              <span class="rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 text-[0.6875rem] font-mono">
                {{ liveCount() }}
              </span>
            }
          </button>

          <button
            type="button"
            class="status-tab"
            [class.status-tab--active]="statusFilter() === 'scheduled'"
            (click)="setStatusFilter('scheduled')"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-sky-400"></span>
            <span>{{ t('events.stat.scheduled') }}</span>
            @if (scheduledCount() > 0) {
              <span class="rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30 px-1.5 py-0.5 text-[0.6875rem] font-mono">
                {{ scheduledCount() }}
              </span>
            }
          </button>

          <button
            type="button"
            class="status-tab"
            [class.status-tab--active]="statusFilter() === 'stopped'"
            (click)="setStatusFilter('stopped')"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-neutral-400"></span>
            <span>Finished</span>
          </button>
        </nav>

        @if (statusFilter() !== '') {
          <button
            type="button"
            class="btn btn--ghost btn--sm text-xs py-1 px-2 text-[var(--color-text-secondary)] hover:text-white inline-flex items-center gap-1"
            (click)="setStatusFilter('')"
          >
            <app-icon name="close" size="0.75rem" />
            <span>{{ t('common.clear') }}</span>
          </button>
        }
      </section>

      <app-data-table
        [columns]="columns()"
        [rows]="events()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [serverMode]="true"
        [totalItems]="totalItems()"
        [pageSize]="pageSize()"
        emptyIcon="calendar"
        [rowClickable]="true"
        (rowClick)="openEventDetail($event.id)"
        (pageChange)="onPageChange($event)"
      >
        <ng-template dataTableCell="title" let-row>
          <div class="flex items-center gap-2">
            @if (row.call_to_arms) {
              <span class="cta-star text-amber-400" [title]="t('events.call_to_arms')">★</span>
            }
            <span class="font-medium text-white hover:underline cursor-pointer">
              {{ row.title }}
            </span>
            @if (row.regear) {
              <span class="inline-flex items-center text-sky-400" title="Regear active">
                <app-icon name="shield" size="0.75rem" />
              </span>
            }
          </div>
        </ng-template>

        <ng-template dataTableCell="date" let-row>
          <div class="flex flex-col gap-0.5 text-xs text-[var(--color-text-secondary)]">
            <span class="text-[var(--color-text)] font-medium">{{ formatDate(row.start_time_utc ?? row.event_date_utc) }}</span>
            <span class="text-[var(--color-text-tertiary)]">Mass: {{ formatTime(row.mass_time_utc ?? row.event_date_utc) }}</span>
          </div>
        </ng-template>

        <ng-template dataTableCell="comp" let-row>
          <span class="inline-flex items-center gap-1.5 text-xs text-[var(--color-text)]">
            <app-icon name="swords" size="0.75rem" class="text-[var(--color-text-secondary)]" />
            {{ row.comp_name }}
          </span>
        </ng-template>

        <ng-template dataTableCell="status" let-row>
          @switch (row.status) {
            @case ('live') {
              <span class="status-pill status-pill--live">
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                LIVE
              </span>
            }
            @case ('scheduled') {
              <span class="status-pill status-pill--scheduled">
                <app-icon name="calendar" size="0.75rem" />
                Scheduled
              </span>
            }
            @case ('stopped') {
              <span class="status-pill status-pill--stopped">
                Stopped
              </span>
            }
            @case ('auto_stopped') {
              <span class="status-pill status-pill--stopped">
                Ended
              </span>
            }
            @case ('cancelled') {
              <span class="status-pill status-pill--cancelled">
                <app-icon name="close" size="0.75rem" />
                Cancelled
              </span>
            }
            @default {
              <span class="status-pill status-pill--stopped">
                {{ row.status }}
              </span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="actions" let-row>
          <div class="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              class="btn btn--primary btn--sm"
              (click)="$event.stopPropagation(); openEventDetail(row.id)"
            >
              {{ t('common.open') }} &rarr;
            </button>
            @if (row.status === 'scheduled') {
              <button
                type="button"
                class="btn btn--tonal btn--sm"
                (click)="$event.stopPropagation(); join(row.id)"
              >
                {{ t('events.participate') }}
              </button>
            }
            @if (canDelete()) {
              <button
                type="button"
                class="btn btn--danger btn--sm"
                (click)="$event.stopPropagation(); requestDelete(row)"
              >
                {{ t('common.delete') }}
              </button>
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog [title]="t('events.new')" size="lg" (closed)="closeCreate()">
        <form id="create-event-form" class="grid gap-4" (submit)="onCreateSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              required
              autofocus
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

          <div class="grid gap-4 sm:grid-cols-5">
            <label>
              <span class="label">{{ t('events.detail.comp') }}</span>
              <select
                class="select"
                [value]="draftCompId()"
                [disabled]="compsLoading()"
                (change)="onCompChange($event)"
              >
                <option value="">{{ compsLoading() ? t('common.loading') : '—' }}</option>
                @for (comp of comps(); track comp.id) {
                  <option [value]="comp.id">{{ comp.name }}</option>
                }
              </select>
            </label>

            <label>
              <span class="label">{{ t('events.create.playerCap') }}</span>
              <input
                id="event-player-cap"
                name="player_cap"
                class="input"
                type="number"
                min="1"
                step="1"
                inputmode="numeric"
                [value]="draftPlayerCap()"
                aria-describedby="event-player-cap-hint"
                (input)="onPlayerCapChange($event)"
              />
              <span id="event-player-cap-hint" class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('events.create.playerCapHint') }}
              </span>
            </label>

            <label>
              <span class="label">{{ t('common.date') }}</span>
              <input class="input" type="date" required [attr.min]="minEventDate" [value]="draftEventDate()" (input)="onEventDateChange($event)" />
            </label>

            <label>
              <span class="label">Mass</span>
              <input class="input" type="time" required [value]="draftMassTime()" (input)="onMassTimeChange($event)" />
            </label>

            <label>
              <span class="label">Start</span>
              <input class="input" type="time" required [value]="draftStartTime()" (input)="onStartTimeChange($event)" />
            </label>
          </div>

          <fieldset class="grid gap-3">
            <legend class="label">{{ t('events.discordRoles.label') }}</legend>
            <p id="event-discord-roles-hint" class="text-xs" style="color: var(--color-text-secondary)">
              {{ t('events.discordRoles.hint') }}
            </p>
            @if (compsLoading()) {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.loading') }}</p>
            } @else if (roleError()) {
              <p class="text-sm" style="color: var(--color-danger)" aria-live="polite">{{ roleError() }}</p>
            } @else {
              <label>
                <span class="sr-only">{{ t('events.discordRoles.search') }}</span>
                <input
                  class="input"
                  type="search"
                  name="discord_role_search"
                  [placeholder]="t('events.discordRoles.search')"
                  [value]="roleSearch()"
                  aria-describedby="event-discord-roles-hint"
                  (input)="onRoleSearchChange($event)"
                />
              </label>
              @if (filteredDiscordRoles().length === 0) {
                <p class="text-sm" style="color: var(--color-text-secondary)">
                  {{ discordRoles().length === 0 ? t('events.discordRoles.empty') : t('events.discordRoles.noMatches') }}
                </p>
              } @else {
                <div class="grid gap-2" role="group" aria-describedby="event-discord-roles-hint">
                  @for (role of filteredDiscordRoles(); track role.id) {
                    <label class="flex min-h-12 items-center gap-2 rounded-md border border-(--color-border) px-3 py-2">
                      <input
                        class="checkbox"
                        type="checkbox"
                        name="discord_role_ids"
                        [value]="role.id"
                        [checked]="isDiscordRoleSelected(role.id)"
                        (change)="toggleDiscordRole(role.id, $event)"
                      />
                      <span>@{{ role.name }}</span>
                    </label>
                  }
                </div>
              }
              <div class="flex flex-wrap gap-2" aria-live="polite">
                @if (selectedDiscordRoles().length === 0) {
                  <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('events.discordRoles.none') }}</span>
                } @else {
                  @for (role of selectedDiscordRoles(); track role.id) {
                    <span class="badge">@{{ role.name }}</span>
                  }
                }
              </div>
            }
          </fieldset>

          <div class="grid gap-3 sm:grid-cols-2">
            <label class="flex items-center gap-2">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftCallToArms()"
                (change)="onCallToArmsChange($event)"
              />
              <span>{{ t('events.call_to_arms') }}</span>
            </label>
            <label class="flex items-center gap-2">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftRegear()"
                (change)="onRegearChange($event)"
              />
              <span>{{ t('events.regear') }}</span>
            </label>
          </div>

          <label class="flex items-start gap-2">
            <input
              class="checkbox mt-0.5"
              type="checkbox"
              [checked]="draftCreateSplit()"
              (change)="onCreateSplitChange($event)"
            />
            <span>
              {{ t('events.createSplit') }}
              <span class="mt-0.5 block text-xs" style="color: var(--color-text-secondary)">
                {{ t('events.createSplitHint') }}
              </span>
            </span>
          </label>

          @if (draftCreateSplit()) {
            <div class="grid gap-3 sm:grid-cols-2">
              <label>
                <span class="label">{{ t('splits.island') }}</span>
                <select class="select" [value]="draftIslandId()" (change)="onIslandChange($event)">
                  <option value="">{{ t('splits.pick_island') }}</option>
                  @for (island of islands(); track island.id) {
                    <option [value]="island.id">{{ cityLabel(island.city) }} · {{ island.name }}</option>
                  }
                </select>
              </label>
              <label>
                <span class="label">{{ t('splits.tab') }}</span>
                <select
                  class="select"
                  [value]="draftTabId()"
                  [disabled]="!draftIslandId()"
                  (change)="onTabChange($event)"
                >
                  <option value="">{{ t('splits.pick_tab') }}</option>
                  @for (tab of draftTabs(); track tab.id) {
                    <option [value]="tab.id">{{ tab.name }}</option>
                  }
                </select>
              </label>
            </div>
          }

          @if (compError()) {
            <p class="text-sm" style="color: var(--color-danger)">{{ compError() }}</p>
          }
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="create-event-form"
            [disabled]="saving()"
          >
            {{ t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingDelete()) {
      <app-dialog [title]="t('events.detail.delete')" size="sm" (closed)="cancelDelete()">
        <p>{{ t('events.detail.confirm_delete') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelDelete()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="deleting()"
            (click)="confirmDelete()"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Events {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly events = signal<EventView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(PAGE_SIZE);
  protected readonly totalItems = signal(0);
  protected readonly search = signal('');
  protected readonly statusFilter = signal('');
  // Keep the initial table view aligned with the API's newest-first default.
  protected readonly sortColumn = signal<string | null>('date');
  protected readonly sortOrder = signal<'asc' | 'desc' | null>('desc');

  protected readonly liveEvents = computed(
    () => this.events().filter((e) => e.status === 'live'),
  );
  protected readonly liveCount = computed(
    () => this.liveEvents().length,
  );
  protected readonly scheduledCount = computed(
    () => this.events().filter((e) => e.status === 'scheduled').length,
  );
  protected readonly ctaCount = computed(
    () => this.events().filter((e) => e.call_to_arms).length,
  );

  protected async refreshNow(): Promise<void> {
    await this.load();
  }

  protected readonly createOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly compsLoading = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftPlayerCap = signal('');
  protected readonly draftEventDate = signal(defaultEventDate());
  protected readonly draftMassTime = signal(defaultMassTime());
  protected readonly draftStartTime = signal(defaultStartTime());
  protected readonly minEventDate = defaultEventDate();
  protected readonly draftCallToArms = signal(false);
  protected readonly draftRegear = signal(false);
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly draftDiscordRoleIds = signal<string[]>([]);
  protected readonly roleSearch = signal('');
  protected readonly roleError = signal<string | null>(null);
  protected readonly filteredDiscordRoles = computed(() => {
    const query = this.roleSearch().trim().toLocaleLowerCase();
    if (!query) return this.discordRoles();
    return this.discordRoles().filter((role) => role.name.toLocaleLowerCase().includes(query));
  });
  protected readonly selectedDiscordRoles = computed(() =>
    this.draftDiscordRoleIds()
      .map((id) => this.discordRoles().find((role) => role.id === id))
      .filter((role): role is DiscordRoleView => role !== undefined),
  );
  protected readonly draftCreateSplit = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  protected readonly draftTabs = computed(() => {
    const id = Number(this.draftIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });
  protected readonly compError = signal<string | null>(null);

  protected readonly pendingDelete = signal<EventView | null>(null);
  protected readonly deleting = signal(false);

  protected readonly trackById = (event: EventView): number => event.id;

  protected readonly columns = computed<readonly DataTableColumn<EventView>[]>(() => [
    {
      key: 'title',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (event) => event.title,
    },
    {
      key: 'date',
      label: 'common.date',
      sortable: true,
      accessor: (event) => event.event_date_utc,
    },
    {
      key: 'comp',
      label: 'events.detail.comp',
      searchable: true,
      accessor: (event) => event.comp_name,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (event) => event.status,
      filterOptions: EVENT_STATUSES.map((status) => ({
        value: status,
        label: this.t(statusLabel(status)),
      })),
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** True when the current user can create a new event. */
  protected canCreate(): boolean {
    return this.auth.hasPermission('events.create');
  }

  /** True when the current user can delete an event. */
  protected canDelete(): boolean {
    return this.auth.hasPermission('events.delete');
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected openCreate(): void {
    this.resetCreateDraft();
    this.createOpen.set(true);
    void this.loadCreateOptions();
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
  }

  /** Opens the analytics view for a single event. */
  protected openEventDetail(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  /** Formats ISO date strings using the browser locale. */
  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  /** Join still lands on detail, where picking a build is what actually joins. */
  protected join(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  protected requestDelete(event: EventView): void {
    this.pendingDelete.set(event);
  }

  protected cancelDelete(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const doomed = this.pendingDelete();
    if (!doomed) {
      return;
    }
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/events/${doomed.id}`));
      this.pendingDelete.set(null);
      this.toasts.success(this.t('common.delete'));
      // If that was the last row on the current page, step back a page instead
      // of reloading into a now-empty one.
      if (this.events().length === 1 && this.page() > 1) {
        this.page.set(this.page() - 1);
      }
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.deleting.set(false);
    }
  }

  protected setStatusFilter(status: string): void {
    this.statusFilter.set(status);
    this.page.set(1);
    void this.load();
  }

  protected onPageChange(change: DataTablePageChange): void {
    this.page.set(change.page);
    this.pageSize.set(change.pageSize);
    this.search.set(change.search);
    this.statusFilter.set(change.columnFilters['status'] ?? '');
    this.sortColumn.set(change.sort?.columnKey ?? null);
    this.sortOrder.set(change.sort?.direction ?? null);
    void this.load();
  }

  protected onTitleChange(event: Event): void {
    this.draftTitle.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onEventDateChange(event: Event): void {
    this.draftEventDate.set((event.target as HTMLInputElement).value);
  }

  protected onMassTimeChange(event: Event): void {
    this.draftMassTime.set((event.target as HTMLInputElement).value);
  }

  protected onStartTimeChange(event: Event): void {
    this.draftStartTime.set((event.target as HTMLInputElement).value);
  }

  protected formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  protected onCompChange(event: Event): void {
    this.draftCompId.set((event.target as HTMLSelectElement).value);
    this.compError.set(null);
  }

  protected onPlayerCapChange(event: Event): void {
    this.draftPlayerCap.set((event.target as HTMLInputElement).value);
    this.compError.set(null);
  }

  protected onCreateSplitChange(event: Event): void {
    this.draftCreateSplit.set((event.target as HTMLInputElement).checked);
  }

  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
  }

  protected onRegearChange(event: Event): void {
    this.draftRegear.set((event.target as HTMLInputElement).checked);
  }

  protected onRoleSearchChange(event: Event): void {
    this.roleSearch.set((event.target as HTMLInputElement).value);
  }

  protected isDiscordRoleSelected(roleId: string): boolean {
    return this.draftDiscordRoleIds().includes(roleId);
  }

  protected toggleDiscordRole(roleId: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draftDiscordRoleIds.update((current) =>
      checked ? (current.includes(roleId) ? current : [...current, roleId]) : current.filter((id) => id !== roleId),
    );
  }

  protected onIslandChange(event: Event): void {
    this.draftIslandId.set((event.target as HTMLSelectElement).value);
    this.draftTabId.set('');
  }

  protected onTabChange(event: Event): void {
    this.draftTabId.set((event.target as HTMLSelectElement).value);
  }

  protected async onCreateSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();

    const title = this.draftTitle().trim();
    const compId = Number(this.draftCompId());
    const playerCapText = this.draftPlayerCap().trim();
    const playerCap = playerCapText ? Number(playerCapText) : undefined;

    if (!title) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (compId <= 0) {
      this.compError.set(this.t('events.create.comp_required'));
      return;
    }
    if (
      playerCap !== undefined &&
      (!Number.isSafeInteger(playerCap) || playerCap <= 0)
    ) {
      this.compError.set(this.t('events.create.playerCapInvalid'));
      return;
    }
    if (this.draftCreateSplit() && !this.draftTabId()) {
      this.toasts.error(this.t('validation.required'));
      return;
    }

    const massAt = combineLocalDateTime(this.draftEventDate(), this.draftMassTime());
    const startAt = combineLocalDateTime(this.draftEventDate(), this.draftStartTime());
    if (!massAt || !startAt) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    if (massAt > startAt) {
      this.toasts.error('Mass deve essere uguale o precedente all\'orario di Start.');
      return;
    }

    const request: CreateEventRequest = {
      title,
      comp_id: compId,
      player_cap: playerCap,
      event_date_utc: startAt.toISOString(),
      mass_time_utc: massAt.toISOString(),
      start_time_utc: startAt.toISOString(),
      call_to_arms: this.draftCallToArms(),
      regear: this.draftRegear(),
      discord_role_ids: this.draftDiscordRoleIds(),
      create_split: this.draftCreateSplit(),
      island_tab_id: this.draftCreateSplit() ? Number(this.draftTabId()) : undefined,
    };
    const description = this.draftDescription().trim();
    if (description) {
      request.description = description;
    }

    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.post<EventView>('api/events', request));
      this.toasts.success(this.t('common.create'));
      this.closeCreate();
      await this.load();
      void this.router.navigate(['/events', created.id]);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const sort = this.sortColumn() ? (SORT_COLUMNS[this.sortColumn()!] ?? this.sortColumn()) : undefined;
      const data = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', {
          page: this.page(),
          limit: this.pageSize(),
          search: this.search().trim() || undefined,
          status: this.statusFilter() || undefined,
          sort,
          order: sort ? (this.sortOrder() ?? 'asc') : undefined,
        }),
      );
      this.events.set(data.items);
      this.totalItems.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private resetCreateDraft(): void {
    this.draftTitle.set('');
    this.draftDescription.set('');
    this.draftCompId.set('');
    this.draftPlayerCap.set('');
    this.draftEventDate.set(defaultEventDate());
    this.draftMassTime.set(defaultMassTime());
    this.draftStartTime.set(defaultStartTime());
    this.draftCallToArms.set(false);
    this.draftRegear.set(false);
    this.draftDiscordRoleIds.set([]);
    this.roleSearch.set('');
    this.roleError.set(null);
    this.draftCreateSplit.set(false);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.compError.set(null);
  }

  private async loadCreateOptions(): Promise<void> {
    this.compsLoading.set(true);
    try {
      const [comps, islands] = await Promise.all([
        firstValueFrom(this.api.get<PaginatedData<CompSummary>>('api/comps', { page: 1, limit: 100 })),
        firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands')),
      ]);
      this.comps.set(comps.items);
      this.islands.set(islands);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }

    try {
      const discordRoles = await firstValueFrom(this.api.get<DiscordRoleView[]>('api/events/discord-roles'));
      this.discordRoles.set(discordRoles);
      this.roleError.set(null);
    } catch (error) {
      this.roleError.set(error instanceof Error ? error.message : this.t('common.error'));
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compsLoading.set(false);
    }
  }
}

function statusLabel(status: EventStatus): TranslationKey {
  switch (status) {
    case 'scheduled':
      return 'events.status.scheduled';
    case 'live':
      return 'events.status.live';
    case 'stopped':
      return 'events.status.stopped';
    case 'auto_stopped':
      return 'events.status.auto_stopped';
    case 'cancelled':
      return 'events.status.cancelled';
  }
}

/** Formats a date as `YYYY-MM-DD` in the user's local timezone. */
function formatDateInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function defaultEventDate(): string {
  return formatDateInput(new Date(Date.now() + 60 * 60 * 1000));
}

function defaultMassTime(): string {
  return '19:30';
}

function defaultStartTime(): string {
  return '20:00';
}

function combineLocalDateTime(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? null : value;
}
