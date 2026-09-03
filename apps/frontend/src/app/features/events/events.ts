import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
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
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { roleSelectOptionsMany } from '../../shared/discord/discord-options';
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
 * Pixel-perfect implementation matching the modern dark midnight specification.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, Icon, RouterLink, SearchableSelect, TooltipDirective],
  styles: `
    :host {
      display: block;
      width: 100%;
    }
    .events-page {
      max-width: 1400px;
      margin: 0 auto;
    }
    .kpi-card {
      background-color: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: 0.75rem;
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), background-color var(--motion-fast);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
  `,
  template: `
    <div class="events-page flex flex-col gap-6 max-w-7xl mx-auto pb-12">
      <!-- Header -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-1">
        <div>
          <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--color-text)] m-0">Events</h1>
          <p class="text-sm text-[var(--color-text-tertiary)] mt-1 mb-0">Schedule and manage all guild activities.</p>
        </div>

        @if (canCreate()) {
          <button
            type="button"
            class="btn btn--primary btn--sm inline-flex items-center gap-1.5 self-start sm:self-auto"
            (click)="openCreate()"
          >
            <app-icon name="plus" size="0.875rem" />
            <span>{{ t('events.new') }}</span>
          </button>
        }
      </div>

      <!-- 4 KPI Cards -->
      <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5" aria-label="Events summary">
        <!-- Card 1: TOTAL EVENTS -->
        <article class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-info-container)] text-[var(--color-info)] border border-[var(--color-info)]">
              <app-icon name="calendar" size="1.125rem" />
            </div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)]">TOTAL EVENTS</span>
          </div>
          <div class="text-3xl font-bold tracking-tight text-[var(--color-text)] mt-3.5">
            {{ totalEventsCount() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1.5 truncate">
            All scheduled & past events
          </div>
        </article>

        <!-- Card 2: LIVE EVENTS -->
        <article class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
              <app-icon name="zap" size="1.125rem" />
            </div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)]">LIVE EVENTS</span>
          </div>
          <div class="text-3xl font-bold tracking-tight text-[var(--color-text)] mt-3.5">
            {{ liveEventsCount() }}
          </div>
          <div class="text-xs text-success mt-1.5 truncate flex items-center gap-1.5 font-medium">
            @if (liveEventsCount() > 0) {
              <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
              <span>Active war rooms</span>
            } @else {
              <span>No events live</span>
            }
          </div>
        </article>

        <!-- Card 3: SCHEDULED -->
        <article class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-primary-container)] text-[var(--color-primary)] border border-[var(--color-primary)]">
              <app-icon name="calendar" size="1.125rem" />
            </div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)]">SCHEDULED</span>
          </div>
          <div class="text-3xl font-bold tracking-tight text-[var(--color-text)] mt-3.5">
            {{ scheduledEventsCount() }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-1.5 truncate">
            Upcoming deployments
          </div>
        </article>

        <!-- Card 4: CALL TO ARMS -->
        <article class="kpi-card">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-[var(--color-warning-container)] text-warning border border-[var(--color-warning)]">
              <app-icon name="alert" size="1.125rem" />
            </div>
            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)]">CALL TO ARMS</span>
          </div>
          <div class="text-3xl font-bold tracking-tight text-[var(--color-text)] mt-3.5">
            {{ ctaEventsCount() }}
          </div>
          <div class="text-xs text-warning mt-1.5 truncate font-medium">
            Mandatory guild CTA
          </div>
        </article>
      </section>

      <!-- Filters Row: Search Input + Status Dropdown -->
      <section class="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div class="flex flex-wrap items-center gap-3 w-full sm:w-auto flex-1 max-w-xl">
          <!-- Search Input -->
          <div class="relative flex-1 min-w-[240px]">
            <app-icon name="search" size="0.875rem" class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-disabled)]" />
            <input
              type="text"
              placeholder="Search events..."
              class="w-full bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-lg pl-9 pr-3 py-2 text-xs text-[var(--color-text)] placeholder-[var(--color-text-disabled)] focus:border-[var(--color-primary)] outline-none transition-all"
              [value]="search()"
              (input)="onSearchInput($event)"
            />
          </div>

          <!-- Status Dropdown -->
          <div class="relative">
            <select
              class="bg-[var(--color-surface)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-lg px-3 py-2 text-xs text-[var(--color-text-secondary)] cursor-pointer outline-none transition-all"
              [value]="statusFilter()"
              (change)="onStatusDropdownChange($event)"
            >
              <option value="" class="bg-[var(--color-surface)] text-[var(--color-text)]">Status: All</option>
              <option value="live" class="bg-[var(--color-surface)] text-[var(--color-text)]">Status: Live</option>
              <option value="scheduled" class="bg-[var(--color-surface)] text-[var(--color-text)]">Status: Scheduled</option>
              <option value="stopped" class="bg-[var(--color-surface)] text-[var(--color-text)]">Status: Stopped</option>
              <option value="cancelled" class="bg-[var(--color-surface)] text-[var(--color-text)]">Status: Cancelled</option>
            </select>
          </div>
        </div>
      </section>

      <!-- Status Tabs with Pill Count Badges & Underline -->
      <nav class="flex items-center gap-6 border-b border-[var(--color-border)] overflow-x-auto scrollbar-thin" aria-label="Status filter">
        <!-- All -->
        <button
          type="button"
          class="flex items-center gap-2 pb-3 text-xs font-semibold transition-all border-b-2 cursor-pointer shrink-0"
          [class.border-[var(--color-primary)]]="statusFilter() === ''"
          [class.text-[var(--color-text)]]="statusFilter() === ''"
          [class.border-transparent]="statusFilter() !== ''"
          [class.text-[var(--color-text-tertiary)]]="statusFilter() !== ''"
          [class.hover:text-[var(--color-text)]]="statusFilter() !== ''"
          (click)="setStatusFilter('')"
        >
          <span>All</span>
          <span
            class="rounded-full px-2 py-0.5 text-[11px] font-mono border"
            [class.bg-white/10]="statusFilter() === ''"
            [class.border-[var(--color-border-strong)]]="statusFilter() === ''"
            [class.text-[var(--color-text)]]="statusFilter() === ''"
            [class.bg-[var(--color-surface-2)]]="statusFilter() !== ''"
            [class.border-[var(--color-border)]]="statusFilter() !== ''"
            [class.text-[var(--color-text-tertiary)]]="statusFilter() !== ''"
          >
            {{ totalEventsCount() }}
          </span>
        </button>

        <!-- Live -->
        <button
          type="button"
          class="flex items-center gap-2 pb-3 text-xs font-semibold transition-all border-b-2 cursor-pointer shrink-0"
          [class.border-[var(--color-primary)]]="statusFilter() === 'live'"
          [class.text-[var(--color-text)]]="statusFilter() === 'live'"
          [class.border-transparent]="statusFilter() !== 'live'"
          [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'live'"
          [class.hover:text-[var(--color-text)]]="statusFilter() !== 'live'"
          (click)="setStatusFilter('live')"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"></span>
          <span>Live</span>
          <span
            class="rounded-full px-2 py-0.5 text-[11px] font-mono border"
            [class.bg-white/10]="statusFilter() === 'live'"
            [class.border-[var(--color-border-strong)]]="statusFilter() === 'live'"
            [class.text-[var(--color-text)]]="statusFilter() === 'live'"
            [class.bg-[var(--color-surface-2)]]="statusFilter() !== 'live'"
            [class.border-[var(--color-border)]]="statusFilter() !== 'live'"
            [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'live'"
          >
            {{ liveEventsCount() }}
          </span>
        </button>

        <!-- Scheduled -->
        <button
          type="button"
          class="flex items-center gap-2 pb-3 text-xs font-semibold transition-all border-b-2 cursor-pointer shrink-0"
          [class.border-[var(--color-primary)]]="statusFilter() === 'scheduled'"
          [class.text-[var(--color-text)]]="statusFilter() === 'scheduled'"
          [class.border-transparent]="statusFilter() !== 'scheduled'"
          [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'scheduled'"
          [class.hover:text-[var(--color-text)]]="statusFilter() !== 'scheduled'"
          (click)="setStatusFilter('scheduled')"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-info)]"></span>
          <span>Scheduled</span>
          <span
            class="rounded-full px-2 py-0.5 text-[11px] font-mono border"
            [class.bg-white/10]="statusFilter() === 'scheduled'"
            [class.border-[var(--color-border-strong)]]="statusFilter() === 'scheduled'"
            [class.text-[var(--color-text)]]="statusFilter() === 'scheduled'"
            [class.bg-[var(--color-surface-2)]]="statusFilter() !== 'scheduled'"
            [class.border-[var(--color-border)]]="statusFilter() !== 'scheduled'"
            [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'scheduled'"
          >
            {{ scheduledEventsCount() }}
          </span>
        </button>

        <!-- Finished -->
        <button
          type="button"
          class="flex items-center gap-2 pb-3 text-xs font-semibold transition-all border-b-2 cursor-pointer shrink-0"
          [class.border-[var(--color-primary)]]="statusFilter() === 'stopped'"
          [class.text-[var(--color-text)]]="statusFilter() === 'stopped'"
          [class.border-transparent]="statusFilter() !== 'stopped'"
          [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'stopped'"
          [class.hover:text-[var(--color-text)]]="statusFilter() !== 'stopped'"
          (click)="setStatusFilter('stopped')"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-neutral-400"></span>
          <span>Finished</span>
          <span
            class="rounded-full px-2 py-0.5 text-[11px] font-mono border"
            [class.bg-white/10]="statusFilter() === 'stopped'"
            [class.border-[var(--color-border-strong)]]="statusFilter() === 'stopped'"
            [class.text-[var(--color-text)]]="statusFilter() === 'stopped'"
            [class.bg-[var(--color-surface-2)]]="statusFilter() !== 'stopped'"
            [class.border-[var(--color-border)]]="statusFilter() !== 'stopped'"
            [class.text-[var(--color-text-tertiary)]]="statusFilter() !== 'stopped'"
          >
            {{ finishedEventsCount() }}
          </span>
        </button>
      </nav>

      <!-- TABLE -->
      <div class="overflow-x-auto w-full">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-tertiary)]">
              <th class="py-3 px-4 font-bold">EVENT</th>
              <th class="py-3 px-4 font-bold cursor-pointer select-none" (click)="toggleDateSort()">
                <div class="inline-flex items-center gap-1 hover:text-[var(--color-text)] transition-colors">
                  <span>DATE</span>
                  <span class="text-xs text-[var(--color-text-disabled)]">⇅</span>
                </div>
              </th>
              <th class="py-3 px-4 font-bold">COMPOSITION</th>
              <th class="py-3 px-4 font-bold">STATUS</th>
              <th class="py-3 px-4 font-bold text-right">ACTIONS</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)]">
            @if (loading() && events().length === 0) {
              <tr>
                <td colspan="5" class="py-12 text-center text-xs text-[var(--color-text-tertiary)]">
                  <app-icon name="loader" size="1.5rem" class="animate-spin inline-block mb-2" />
                  <p class="m-0">Loading events...</p>
                </td>
              </tr>
            } @else if (events().length === 0) {
              <tr>
                <td colspan="5" class="py-12 text-center text-xs text-[var(--color-text-tertiary)]">
                  <p class="m-0 font-medium text-sm text-[var(--color-text)]">No events found</p>
                  <p class="m-0 text-xs text-[var(--color-text-tertiary)] mt-1">There are no events matching the selected filters.</p>
                </td>
              </tr>
            } @else {
              @for (event of events(); track event.id) {
                <tr class="hover:bg-white/[0.02] transition-colors group">
                  <!-- EVENT Column -->
                  <td class="py-3.5 px-4 min-w-[220px]">
                    <div class="flex items-center gap-1.5">
                      @if (event.call_to_arms) {
                        <span class="text-warning font-bold text-sm select-none" title="Call To Arms">★</span>
                      }
                      <a
                        [routerLink]="['/events', event.id]"
                        class="text-sm font-semibold text-[var(--color-text)] hover:text-error transition-colors no-underline truncate max-w-xs"
                      >
                        {{ event.title }}
                      </a>
                    </div>
                    <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                      Mass: {{ formatMassTime(event) }}
                    </div>
                  </td>

                  <!-- DATE Column -->
                  <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="text-xs font-medium text-[var(--color-text)]">
                      {{ formatDateDay(event.start_time_utc ?? event.event_date_utc) }}
                    </div>
                    <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
                      {{ formatDateTime(event.start_time_utc ?? event.event_date_utc) }}
                    </div>
                  </td>

                  <!-- COMPOSITION Column -->
                  <td class="py-3.5 px-4 whitespace-nowrap">
                    <div class="inline-flex items-center gap-1.5 text-xs text-[var(--color-text)]">
                      <app-icon name="swords" size="0.875rem" class="text-[var(--color-text-tertiary)] shrink-0" />
                      <span>{{ event.comp_name || 'Fill' }}</span>
                    </div>
                  </td>

                  <!-- STATUS Column -->
                  <td class="py-3.5 px-4 whitespace-nowrap">
                    @switch (event.status) {
                      @case ('live') {
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-success-container)] text-success border border-[var(--color-success)]">
                          <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                          <span>Live</span>
                        </span>
                      }
                      @case ('scheduled') {
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-info-container)] text-[var(--color-info)] border border-[var(--color-info)]">
                          <app-icon name="calendar" size="0.75rem" />
                          <span>Scheduled</span>
                        </span>
                      }
                      @case ('cancelled') {
                        <span class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-error-container)] text-error border border-[var(--color-error)]">
                          <app-icon name="close" size="0.75rem" />
                          <span>Cancelled</span>
                        </span>
                      }
                      @default {
                        <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] border border-[var(--color-border)]">
                          <span>Stopped</span>
                        </span>
                      }
                    }
                  </td>

                  <!-- ACTIONS Column -->
                  <td class="py-3.5 px-4 whitespace-nowrap text-right">
                    <div class="inline-flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        class="px-3 py-1 text-xs font-medium text-[var(--color-text-secondary)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] border border-[var(--color-border)] rounded-md transition-all cursor-pointer"
                        (click)="openEventDetail(event.id)"
                      >
                        Open
                      </button>

                      @if (event.status === 'scheduled') {
                        <button
                          type="button"
                          class="px-3 py-1 text-xs font-semibold text-[var(--color-text)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] rounded-md transition-all cursor-pointer"
                          (click)="join(event.id)"
                        >
                          Join
                        </button>
                      }

                      @if (canDelete() || event.status === 'stopped' || event.status === 'cancelled') {
                        <button
                          type="button"
                          class="px-3 py-1 text-xs font-medium text-error bg-[var(--color-error-container)] hover:bg-[var(--color-error-container)] border border-[var(--color-error)] rounded-md transition-all cursor-pointer"
                          (click)="requestDelete(event)"
                        >
                          Delete
                        </button>
                      }

                      <button
                        type="button"
                        class="w-7 h-7 flex items-center justify-center text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] hover:bg-white/[0.05] rounded-md transition-colors cursor-pointer"
                        (click)="openEventDetail(event.id)"
                        [appTooltip]="'Details & Roster'"
                        tooltipPosition="left"
                      >
                        <app-icon name="more-vertical" size="0.875rem" />
                      </button>
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-[var(--color-border)] text-xs text-[var(--color-text-tertiary)]">
        <div>
          Showing {{ paginationFrom() }} to {{ paginationTo() }} of {{ totalItems() }} events
        </div>

        <div class="flex items-center gap-1.5 self-center sm:self-auto">
          <button
            type="button"
            class="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer"
            [disabled]="page() <= 1"
            (click)="goToPage(page() - 1)"
            aria-label="Previous page"
          >
            <app-icon name="chevron-left" size="0.75rem" />
          </button>

          @for (p of displayedPages(); track p) {
            <button
              type="button"
              class="w-7 h-7 flex items-center justify-center rounded-md text-xs font-medium transition-all cursor-pointer"
              [class.bg-[var(--color-primary)]]="p === page()"
              [class.text-[var(--color-text)]]="p === page()"
              [class.font-bold]="p === page()"
              [class.text-[var(--color-text-tertiary)]]="p !== page()"
              [class.hover:text-[var(--color-text)]]="p !== page()"
              [class.hover:bg-[var(--color-surface-2)]]="p !== page()"
              (click)="goToPage(p)"
            >
              {{ p }}
            </button>
          }

          <button
            type="button"
            class="w-7 h-7 flex items-center justify-center rounded-md bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer"
            [disabled]="page() >= totalPages()"
            (click)="goToPage(page() + 1)"
            aria-label="Next page"
          >
            <app-icon name="chevron-right" size="0.75rem" />
          </button>
        </div>

        <div class="flex items-center gap-2 self-end sm:self-auto">
          <select
            class="bg-[var(--color-surface-2)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-md px-2.5 py-1 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] cursor-pointer outline-none transition-all"
            [value]="pageSize()"
            (change)="onPageSizeChange($event)"
          >
            <option value="10" class="bg-[var(--color-surface)] text-[var(--color-text)]">10 per page</option>
            <option value="20" class="bg-[var(--color-surface)] text-[var(--color-text)]">20 per page</option>
            <option value="50" class="bg-[var(--color-surface)] text-[var(--color-text)]">50 per page</option>
          </select>
        </div>
      </div>
    </div>

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
            @if (roleError()) {
              <p class="text-sm" style="color: var(--color-danger)" aria-live="polite">{{ roleError() }}</p>
            } @else {
              <app-searchable-select
                [options]="eventRoleOptions()"
                [values]="draftDiscordRoleIds()"
                [multiple]="true"
                [allowEmpty]="false"
                [emptyLabel]="t('events.discordRoles.none')"
                [searchPlaceholder]="t('events.discordRoles.search')"
                [noMatchesLabel]="t('events.discordRoles.noMatches')"
                [emptyOptionsLabel]="t('events.discordRoles.empty')"
                [ariaLabel]="t('events.discordRoles.label')"
                (valuesChange)="draftDiscordRoleIds.set($event)"
              />
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

  protected readonly totalEventsCount = signal(0);
  protected readonly liveEventsCount = signal(0);
  protected readonly scheduledEventsCount = signal(0);
  protected readonly ctaEventsCount = signal(0);
  protected readonly finishedEventsCount = signal(0);

  protected readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalItems() / this.pageSize())));
  protected readonly paginationFrom = computed(() => (this.totalItems() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1));
  protected readonly paginationTo = computed(() => Math.min(this.totalItems(), this.page() * this.pageSize()));
  protected readonly displayedPages = computed<number[]>(() => {
    const total = this.totalPages();
    const current = this.page();
    const pages: number[] = [];
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= current - 1 && i <= current + 1)) {
        pages.push(i);
      }
    }
    return pages;
  });

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.load(), this.loadStats()]);
  }

  constructor() {
    void this.load();
    void this.loadStats();
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
  protected readonly roleError = signal<string | null>(null);
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
  protected t = (key: TranslationKey) => this.translate.t(key);

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
      void this.loadStats();
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

  private searchTimeout: ReturnType<typeof setTimeout> | null = null;
  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.search.set(value);
    if (this.searchTimeout) {
      clearTimeout(this.searchTimeout);
    }
    this.searchTimeout = setTimeout(() => {
      this.page.set(1);
      void this.load();
    }, 300);
  }

  protected onStatusDropdownChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.statusFilter.set(value);
    this.page.set(1);
    void this.load();
  }

  protected toggleDateSort(): void {
    if (this.sortColumn() === 'date') {
      this.sortOrder.set(this.sortOrder() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortColumn.set('date');
      this.sortOrder.set('desc');
    }
    this.page.set(1);
    void this.load();
  }

  protected goToPage(p: number): void {
    if (p < 1 || p > this.totalPages() || p === this.page()) return;
    this.page.set(p);
    void this.load();
  }

  protected onPageSizeChange(event: Event): void {
    const size = Number((event.target as HTMLSelectElement).value);
    this.pageSize.set(size);
    this.page.set(1);
    void this.load();
  }

  protected formatMassTime(event: EventView): string {
    const dateStr = event.mass_time_utc ?? event.event_date_utc;
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected formatDateDay(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  protected formatDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected async loadStats(): Promise<void> {
    try {
      const allData = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 100 }),
      );
      const items = allData.items;
      this.totalEventsCount.set(allData.total_items);
      this.liveEventsCount.set(items.filter((e) => e.status === 'live').length);
      this.scheduledEventsCount.set(items.filter((e) => e.status === 'scheduled').length);
      this.ctaEventsCount.set(items.filter((e) => e.call_to_arms).length);
      this.finishedEventsCount.set(
        items.filter((e) => e.status === 'stopped' || e.status === 'auto_stopped' || e.status === 'cancelled').length,
      );
    } catch {
      // Fallback
    }
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

  protected eventRoleOptions() {
    return roleSelectOptionsMany(this.discordRoles(), this.draftDiscordRoleIds());
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
      void this.loadStats();
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
