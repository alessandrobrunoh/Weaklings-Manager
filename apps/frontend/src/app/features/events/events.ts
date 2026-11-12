import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AllianceContext,
  CompSummary,
  CreateEventRequest,
  DiscordRoleView,
  EventStatus,
  EventSummary,
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
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { Icon } from '../../shared/components/icon/icon';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import type { MenuItem } from '../../shared/components/menu/menu';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { roleSelectOptionsMany } from '../../shared/discord/discord-options';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import {
  ownershipListParams,
  ownershipOptionLabel,
  type OwnershipScope,
} from '../../shared/data/ownership-scope';

const PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;
const EVENT_STATUSES: readonly EventStatus[] = ['scheduled', 'live', 'stopped', 'auto_stopped', 'cancelled'];

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  title: 'title',
  date: 'event_date_utc',
  status: 'status',
};

/** Fields of the New event dialog that can carry an inline validation message. */
type CreateField =
  | 'title'
  | 'date'
  | 'mass'
  | 'start'
  | 'comp'
  | 'playerCap'
  | 'island'
  | 'tab';

interface CreateFieldMeta {
  /** DOM id of the control, used to move focus from the validation summary. */
  readonly id: string;
  readonly label: TranslationKey;
}

const CREATE_FIELDS: Readonly<Record<CreateField, CreateFieldMeta>> = {
  title: { id: 'event-title', label: 'common.name' },
  date: { id: 'event-date', label: 'common.date' },
  mass: { id: 'event-mass-time', label: 'events.create.mass' },
  start: { id: 'event-start-time', label: 'events.create.start' },
  comp: { id: 'event-comp', label: 'events.detail.comp' },
  playerCap: { id: 'event-player-cap', label: 'events.create.playerCap' },
  island: { id: 'event-island', label: 'splits.island' },
  tab: { id: 'event-tab', label: 'splits.tab' },
};

/** Visual and focus order of the validated fields. */
const CREATE_FIELD_ORDER: readonly CreateField[] = [
  'title',
  'date',
  'mass',
  'start',
  'comp',
  'playerCap',
  'island',
  'tab',
];

interface CreateFieldError {
  readonly field: CreateField;
  readonly label: TranslationKey;
  readonly message: string;
}

/**
 * Events list page.
 *
 * Pixel-perfect implementation matching the modern dark midnight specification.
 */
@Component({
  selector: 'app-events',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    Checkbox,
    FilterBar,
    Icon,
    NgTemplateOutlet,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    SummaryBand,
    OwnershipScopeToggle,
  ],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    :host ::ng-deep .rounded-xl,
    :host ::ng-deep .rounded-2xl,
    :host ::ng-deep .rounded-lg,
    :host ::ng-deep .rounded-md,
    :host ::ng-deep .shadow-lg,
    :host ::ng-deep .shadow-xl {
      border-radius: var(--radius-cards);
      box-shadow: none;
    }

    /* New event dialog */
    .ev-form {
      display: grid;
      gap: 1.25rem;
      min-width: 0;
    }
    .ev-legend {
      margin: 0;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .ev-section {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
      padding-top: 1rem;
      border-top: 1px solid var(--color-border);
    }
    .ev-legend + .ev-section {
      padding-top: 0;
      border-top: 0;
    }
    .ev-section__head {
      display: grid;
      gap: 0.125rem;
    }
    .ev-section__title {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 700;
      line-height: 1.3;
      color: var(--color-text-heading);
    }
    .ev-section__title--toggle {
      font-size: inherit;
    }
    .ev-section__hint {
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.4;
      color: var(--color-text-secondary);
    }
    .ev-grid {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: minmax(0, 1fr);
    }
    /* Phone: the date takes a row, mass and start share the next one. */
    .ev-grid--3 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .ev-grid--3 > :first-child {
      grid-column: 1 / -1;
    }
    @media (min-width: 40rem) {
      .ev-grid--2 {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .ev-grid--3 {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      .ev-grid--3 > :first-child {
        grid-column: auto;
      }
    }
    .ev-nested {
      padding-inline-start: 1.75rem;
    }
    .ev-field {
      display: grid;
      gap: 0.25rem;
      align-content: start;
      min-width: 0;
    }
    .ev-field--narrow .input {
      max-width: 10rem;
    }
    .ev-field__head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      justify-content: space-between;
      gap: 0.25rem 0.75rem;
    }
    .ev-label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.25rem;
      color: var(--color-text);
    }
    .ev-required {
      color: var(--color-error);
    }
    .ev-optional {
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .ev-hint {
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.4;
      color: var(--color-text-secondary);
    }
    .ev-note {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.4;
      color: var(--color-text-secondary);
    }
    .ev-note__icon,
    .ev-error__icon {
      flex-shrink: 0;
      margin-top: 0.1875rem;
    }
    .ev-error {
      display: flex;
      align-items: flex-start;
      gap: 0.375rem;
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.4;
      color: var(--color-error);
    }
    .ev-fieldset {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    .ev-checks {
      display: grid;
      gap: 0.125rem;
    }
    .ev-checks ::ng-deep label {
      min-height: 2rem;
    }
    .ev-panel {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .ev-disclosure {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
      width: 100%;
      min-height: 2rem;
      padding: 0.125rem 0.25rem;
      margin-inline: -0.25rem;
      border: 0;
      border-radius: var(--radius-inputs);
      background: transparent;
      color: var(--color-text-heading);
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 700;
      text-align: start;
      cursor: pointer;
    }
    .ev-disclosure:hover {
      background: var(--color-surface-hover);
    }
    .ev-disclosure:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .ev-disclosure__summary {
      min-width: 0;
      font-size: 0.8125rem;
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .ev-summary {
      display: grid;
      gap: 0.375rem;
      padding: 0.75rem 1rem;
      border: 1px solid color-mix(in oklab, var(--color-error) 45%, transparent);
      border-radius: var(--radius-inputs);
      background: var(--color-error-container);
      color: var(--color-text);
    }
    .ev-summary:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .ev-summary__title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      font-size: 0.875rem;
      font-weight: 700;
    }
    .ev-summary__list {
      display: grid;
      gap: 0.125rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .ev-summary__link {
      padding: 0.125rem 0;
      border: 0;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      font-size: 0.8125rem;
      text-align: start;
      text-decoration: underline;
      cursor: pointer;
    }
    .ev-summary__link:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .input[aria-invalid='true'],
    .select[aria-invalid='true'] {
      border-color: var(--color-error);
    }
  `,
  template: `
    <app-page-header
      [title]="t('events.title')"
      [subtitle]="t('events.subtitle')"
      [menuItems]="headerMenu()"
      (menuSelect)="onHeaderMenu($event)"
    >
      @if (canCreate()) {
        <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
          <app-icon name="plus" size="0.875rem" />
          {{ t('events.new') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <app-summary-band [ariaLabel]="t('events.summaryLabel')" [items]="summaryItems()" />

      <app-filter-bar
        [searchLabel]="t('events.searchLabel')"
        [searchPlaceholder]="t('events.searchPlaceholder')"
        [query]="search()"
        [activeCount]="activeFilterCount()"
        (queryChange)="onSearchChange($event)"
        (clear)="clearFilters()"
      >
        <label class="filter-field">
          <span class="filter-field__label">{{ t('common.status') }}</span>
          <select class="select select--sm" (change)="onStatusChange($event)">
            @for (option of statusOptions(); track option.value) {
              <option [value]="option.value" [selected]="option.value === statusFilter()">
                {{ option.label }}
              </option>
            }
          </select>
        </label>
        <label class="filter-check">
          <input type="checkbox" [checked]="showArchived()" (change)="onShowArchivedChange($event)" />
          {{ t('events.showArchived') }}
        </label>
      </app-filter-bar>

      <app-data-table
        [columns]="columns()"
        [rows]="events()"
        [loading]="loading()"
        [error]="loadFailed()"
        [trackBy]="trackById"
        [serverMode]="true"
        [hideSearch]="true"
        mobileLayout="stack"
        [totalItems]="totalItems()"
        [pageSize]="pageSize()"
        [pageSizeOptions]="[10, 20, 50]"
        itemLabel="events"
        emptyIcon="calendar"
        [emptyTitle]="t('events.emptyTitle')"
        [emptySubtitle]="t('events.emptyHint')"
        [rowClickable]="true"
        (rowClick)="openEventDetail($event.id)"
        (pageChange)="onTablePageChange($event)"
        (retry)="refreshNow()"
      >
        <ng-template dataTableCell="title" let-event>
          <div class="flex items-center gap-1.5 min-w-[220px]">
            @if (event.call_to_arms) {
              <span class="text-warning font-bold text-sm select-none" [title]="t('events.call_to_arms')">★</span>
            }
            @if (event.event_kind === 'flash') {
              <span class="chip chip--info text-xs">{{ t('events.flashMass') }}</span>
            }
            <a
              [routerLink]="['/events', event.id]"
              class="text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-primary)] transition-colors no-underline truncate max-w-xs"
            >
              {{ event.title }}
            </a>
            @if (event.archived_at) {
              <span class="chip chip--neutral text-xs">{{ t('events.archived') }}</span>
            }
            @if (event.is_link) {
              <span class="chip chip--neutral text-xs">{{ event.source_tenant_name ? t('events.linkFrom', { name: event.source_tenant_name }) : t('events.linkShared') }}</span>
            }
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            {{ t('events.flashMass.mass') }}: {{ formatMassTime(event) }}
          </div>
        </ng-template>

        <ng-template dataTableCell="date" let-event>
          <div class="text-xs font-medium text-[var(--color-text)]">
            {{ formatDateDay(event.start_time_utc ?? event.event_date_utc) }}
          </div>
          <div class="text-xs text-[var(--color-text-tertiary)] mt-0.5">
            {{ formatDateTime(event.start_time_utc ?? event.event_date_utc) }}
          </div>
        </ng-template>

        <ng-template dataTableCell="comp_name" let-event>
          <div class="inline-flex items-center gap-1.5 text-xs text-[var(--color-text)]">
            @if (event.event_kind === 'flash') {
              <span>{{ t('events.flashMass') }}</span>
            } @else {
              <app-icon name="swords" size="0.875rem" class="text-[var(--color-text-tertiary)] shrink-0" />
              <span>{{ event.comp_name || t('events.detail.fill_option') }}</span>
            }
          </div>
        </ng-template>

        <ng-template dataTableCell="status" let-event>
          @switch (event.status) {
            @case ('live') {
              <span class="chip chip--success text-xs">
                <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                {{ t('events.status.live') }}
              </span>
            }
            @case ('scheduled') {
              <span class="chip chip--info text-xs">
                <app-icon name="calendar" size="0.75rem" />
                {{ t('events.status.scheduled') }}
              </span>
            }
            @case ('cancelled') {
              <span class="chip chip--error text-xs">
                <app-icon name="close" size="0.75rem" />
                {{ t('events.status.cancelled') }}
              </span>
            }
            @case ('auto_stopped') {
              <span class="chip chip--neutral text-xs">{{ t('events.status.auto_stopped') }}</span>
            }
            @default {
              <span class="chip chip--neutral text-xs">{{ t('events.status.stopped') }}</span>
            }
          }
        </ng-template>

        <ng-template dataTableCell="actions" let-event>
          <div class="inline-flex items-center justify-end gap-1.5" (click)="$event.stopPropagation()">
            <button type="button" class="btn btn--ghost btn--sm" (click)="openEventDetail(event.id)">
              {{ t('common.open') }}
            </button>
            @if (event.status === 'scheduled' && !event.archived_at) {
              <button type="button" class="btn btn--primary btn--sm" (click)="join(event.id)">
                {{ t('events.participate') }}
              </button>
            }
            @if (canEdit(event) && event.status === 'cancelled' && !event.archived_at) {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="reopening()"
                (click)="requestUncancel(event)"
              >
                {{ t('events.uncancel') }}
              </button>
            }
            @if (canDelete(event)) {
              @if (event.archived_at) {
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  [disabled]="archiving()"
                  (click)="unarchiveEvent(event)"
                >
                  {{ t('events.unarchive') }}
                </button>
              } @else {
                <button type="button" class="btn btn--ghost btn--sm" (click)="requestArchive(event)">
                  {{ t('events.archive') }}
                </button>
              }
            }
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog
        [title]="t('events.new')"
        [subtitle]="t('events.create.subtitle')"
        size="lg"
        (closed)="closeCreate()"
      >
        <ng-template #fieldError let-field="field">
          @if (errorFor(field); as message) {
            <p [id]="errorId(field)" class="ev-error">
              <app-icon name="alert" size="0.875rem" class="ev-error__icon" />
              <span>{{ message }}</span>
            </p>
          }
        </ng-template>

        <form id="create-event-form" class="ev-form" novalidate (submit)="onCreateSubmit($event)">
          @if (submitAttempted() && errorList().length > 0) {
            <section
              id="event-error-summary"
              class="ev-summary"
              tabindex="-1"
              aria-labelledby="event-error-summary-title"
            >
              <p id="event-error-summary-title" class="ev-summary__title">
                <app-icon name="alert" size="1rem" class="ev-error__icon" />
                {{ t('events.create.errorSummary') }}
              </p>
              <ul class="ev-summary__list">
                @for (item of errorList(); track item.field) {
                  <li>
                    <button type="button" class="ev-summary__link" (click)="focusField(item.field)">
                      {{ t(item.label) }}: {{ item.message }}
                    </button>
                  </li>
                }
              </ul>
            </section>
          }

          <p class="ev-legend">{{ t('validation.requiredLegend') }}</p>

          <section class="ev-section" aria-labelledby="event-section-details">
            <h3 id="event-section-details" class="ev-section__title">
              {{ t('events.create.section.details') }}
            </h3>
            <div class="ev-field">
              <label class="ev-label" for="event-title">
                {{ t('common.name') }} <span class="ev-required" aria-hidden="true">*</span>
              </label>
              <input
                id="event-title"
                class="input"
                type="text"
                required
                autofocus
                autocomplete="off"
                [value]="draftTitle()"
                [attr.aria-invalid]="errorFor('title') ? 'true' : null"
                [attr.aria-describedby]="describedBy('title')"
                (input)="onTitleChange($event)"
                (blur)="markTouched('title')"
              />
              <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'title' }" />
            </div>
            <div class="ev-field">
              <label class="ev-label" for="event-description">
                {{ t('common.description') }}
                <span class="ev-optional">({{ t('common.optional') }})</span>
              </label>
              <textarea
                id="event-description"
                class="textarea"
                rows="2"
                [value]="draftDescription()"
                (input)="onDescriptionChange($event)"
              ></textarea>
            </div>
          </section>

          <section class="ev-section" aria-labelledby="event-section-schedule">
            <div class="ev-section__head">
              <h3 id="event-section-schedule" class="ev-section__title">
                {{ t('events.create.section.schedule') }}
              </h3>
              <p class="ev-section__hint">{{ t('events.create.section.scheduleHint') }}</p>
            </div>
            <div class="ev-grid ev-grid--3">
              <div class="ev-field">
                <label class="ev-label" for="event-date">
                  {{ t('common.date') }} <span class="ev-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="event-date"
                  class="input"
                  type="date"
                  required
                  [attr.min]="minEventDate"
                  [value]="draftEventDate()"
                  [attr.aria-invalid]="errorFor('date') ? 'true' : null"
                  [attr.aria-describedby]="describedBy('date')"
                  (input)="onEventDateChange($event)"
                  (blur)="markTouched('date')"
                />
                <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'date' }" />
              </div>
              <div class="ev-field">
                <label class="ev-label" for="event-mass-time">
                  {{ t('events.create.mass') }} <span class="ev-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="event-mass-time"
                  class="input"
                  type="time"
                  required
                  [value]="draftMassTime()"
                  [attr.aria-invalid]="errorFor('mass') ? 'true' : null"
                  [attr.aria-describedby]="describedBy('mass', 'event-schedule-note')"
                  (input)="onMassTimeChange($event)"
                  (blur)="markTouched('mass')"
                />
                <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'mass' }" />
              </div>
              <div class="ev-field">
                <label class="ev-label" for="event-start-time">
                  {{ t('events.create.start') }} <span class="ev-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="event-start-time"
                  class="input"
                  type="time"
                  required
                  [value]="draftStartTime()"
                  [attr.aria-invalid]="errorFor('start') ? 'true' : null"
                  [attr.aria-describedby]="describedBy('start', 'event-schedule-note')"
                  (input)="onStartTimeChange($event)"
                  (blur)="markTouched('start')"
                />
                <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'start' }" />
              </div>
            </div>
            <p id="event-schedule-note" class="ev-note">
              <app-icon name="info" size="0.875rem" class="ev-note__icon" />
              <span>{{ scheduleNote() }}</span>
            </p>
          </section>

          <section class="ev-section" aria-labelledby="event-section-roster">
            <div class="ev-section__head">
              <h3 id="event-section-roster" class="ev-section__title">
                {{ t('events.create.section.roster') }}
              </h3>
              <p class="ev-section__hint">{{ t('events.create.section.rosterHint') }}</p>
            </div>
            <div class="ev-field">
              <div class="ev-field__head">
                <label class="ev-label" for="event-comp">
                  {{ t('events.detail.comp') }} <span class="ev-required" aria-hidden="true">*</span>
                </label>
                <app-ownership-scope-toggle [scope]="compScope()" (scopeChange)="setCompScope($event)" />
              </div>
              <select
                id="event-comp"
                class="select"
                required
                [value]="draftCompId()"
                [disabled]="compsLoading()"
                [attr.aria-invalid]="errorFor('comp') ? 'true' : null"
                [attr.aria-describedby]="describedBy('comp', showCompNone() ? 'event-comp-hint' : null)"
                (change)="onCompChange($event)"
                (blur)="markTouched('comp')"
              >
                <option value="">{{ compsLoading() ? t('common.loading') : '—' }}</option>
                @for (comp of comps(); track comp.id) {
                  <option [value]="comp.id">{{ ownershipLabel(comp.name, comp.created_by_username) }}</option>
                }
              </select>
              @if (showCompNone()) {
                <p id="event-comp-hint" class="ev-hint">{{ t('events.create.compNone') }}</p>
              }
              <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'comp' }" />
            </div>
            <div class="ev-field ev-field--narrow">
              <label class="ev-label" for="event-player-cap">
                {{ t('events.create.playerCap') }}
                <span class="ev-optional">({{ t('common.optional') }})</span>
              </label>
              <input
                id="event-player-cap"
                name="player_cap"
                class="input"
                type="number"
                min="1"
                step="1"
                inputmode="numeric"
                [value]="draftPlayerCap()"
                [attr.aria-invalid]="errorFor('playerCap') ? 'true' : null"
                [attr.aria-describedby]="describedBy('playerCap', 'event-player-cap-hint')"
                (input)="onPlayerCapChange($event)"
                (blur)="markTouched('playerCap')"
              />
              <p id="event-player-cap-hint" class="ev-hint">{{ t('events.create.playerCapHint') }}</p>
              <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'playerCap' }" />
            </div>
          </section>

          <section class="ev-section" aria-labelledby="event-section-discord">
            <h3 class="ev-section__title ev-section__title--toggle">
              <button
                type="button"
                id="event-section-discord"
                class="ev-disclosure"
                aria-controls="event-discord-panel"
                [attr.aria-expanded]="discordOpen()"
                (click)="toggleDiscord()"
              >
                <app-icon [name]="discordOpen() ? 'chevron-down' : 'chevron-right'" size="1rem" />
                <span>{{ t('events.create.section.discord') }}</span>
                <span class="ev-disclosure__summary">{{ discordSummary() }}</span>
              </button>
            </h3>
            <div id="event-discord-panel" class="ev-panel">
              @if (discordOpen()) {
                <p class="ev-section__hint">{{ t('events.create.section.discordHint') }}</p>
                <fieldset class="ev-fieldset" aria-describedby="event-discord-roles-hint">
                  <legend class="ev-label">{{ t('events.discordRoles.label') }}</legend>
                  <p id="event-discord-roles-hint" class="ev-hint">{{ t('events.discordRoles.hint') }}</p>
                  @if (roleError()) {
                    <p class="ev-error" aria-live="polite">
                      <app-icon name="alert" size="0.875rem" class="ev-error__icon" />
                      <span>{{ roleError() }}</span>
                    </p>
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
                <div class="ev-checks">
                  @if (canPingAlliance()) {
                    <app-checkbox
                      inputId="event-ping-alliance"
                      [label]="t('events.pingAlliance')"
                      [hint]="t('events.pingAllianceHint')"
                      [checked]="draftPingAlliance()"
                      (checkedChange)="draftPingAlliance.set($event)"
                    />
                  }
                  <app-checkbox
                    inputId="event-vod-forum-post"
                    [label]="t('events.vodForumPost')"
                    [hint]="t('events.vodForumPostHint')"
                    [checked]="draftVodForumPost()"
                    (checkedChange)="draftVodForumPost.set($event)"
                  />
                </div>
              }
            </div>
          </section>

          <section class="ev-section" aria-labelledby="event-section-options">
            <div class="ev-section__head">
              <h3 id="event-section-options" class="ev-section__title">
                {{ t('events.create.section.options') }}
              </h3>
              <p class="ev-section__hint">{{ t('events.create.section.optionsHint') }}</p>
            </div>
            <div class="ev-checks">
              <app-checkbox
                inputId="event-call-to-arms"
                [label]="t('events.call_to_arms')"
                [hint]="t('events.callToArmsHint')"
                [checked]="draftCallToArms()"
                (checkedChange)="draftCallToArms.set($event)"
              />
              <app-checkbox
                inputId="event-regear"
                [label]="t('events.regear')"
                [hint]="t('events.regearHint')"
                [checked]="draftRegear()"
                (checkedChange)="draftRegear.set($event)"
              />
              <app-checkbox
                inputId="event-create-split"
                [label]="t('events.createSplit')"
                [hint]="t('events.createSplitHint')"
                [checked]="draftCreateSplit()"
                (checkedChange)="draftCreateSplit.set($event)"
              />
            </div>
            @if (draftCreateSplit()) {
              <div class="ev-grid ev-grid--2 ev-nested">
                <div class="ev-field">
                  <label class="ev-label" for="event-island">
                    {{ t('splits.island') }} <span class="ev-required" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="event-island"
                    class="select"
                    required
                    [value]="draftIslandId()"
                    [attr.aria-invalid]="errorFor('island') ? 'true' : null"
                    [attr.aria-describedby]="describedBy('island')"
                    (change)="onIslandChange($event)"
                    (blur)="markTouched('island')"
                  >
                    <option value="">{{ t('splits.pick_island') }}</option>
                    @for (island of islands(); track islandKey(island)) {
                      <option [value]="islandKey(island)">{{ cityLabel(island.city) }} · {{ island.name }}@if (island.source_guild_name) { ({{ island.source_guild_name }}) }</option>
                    }
                  </select>
                  <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'island' }" />
                </div>
                <div class="ev-field">
                  <label class="ev-label" for="event-tab">
                    {{ t('splits.tab') }} <span class="ev-required" aria-hidden="true">*</span>
                  </label>
                  <select
                    id="event-tab"
                    class="select"
                    required
                    [value]="draftTabId()"
                    [disabled]="!draftIslandId()"
                    [attr.aria-invalid]="errorFor('tab') ? 'true' : null"
                    [attr.aria-describedby]="describedBy('tab')"
                    (change)="onTabChange($event)"
                    (blur)="markTouched('tab')"
                  >
                    <option value="">{{ t('splits.pick_tab') }}</option>
                    @for (tab of draftTabs(); track tab.id) {
                      <option [value]="tab.id">{{ tab.name }}</option>
                    }
                  </select>
                  <ng-container [ngTemplateOutlet]="fieldError" [ngTemplateOutletContext]="{ field: 'tab' }" />
                </div>
              </div>
            }
          </section>
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
            [attr.aria-busy]="saving() ? 'true' : null"
          >
            {{ saving() ? t('events.create.creating') : t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingArchive()) {
      <app-dialog [title]="t('events.archive')" size="sm" (closed)="cancelArchive()">
        <p>{{ t('events.detail.confirm_delete') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelArchive()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--tonal"
            [disabled]="archiving()"
            (click)="confirmArchive()"
          >
            {{ t('events.archive') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingUncancel()) {
      <app-dialog [title]="t('events.uncancel')" size="sm" (closed)="cancelUncancel()">
        <p>{{ t('events.detail.confirm_uncancel') }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="cancelUncancel()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary"
            [disabled]="reopening()"
            (click)="confirmUncancel()"
          >
            {{ t('events.uncancel') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Events {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** Pending debounce for the search box; the filter reload waits for typing to settle. */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  protected readonly initialQuery = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: PAGE_SIZE,
    filterKeys: ['status'],
  });

  protected readonly events = signal<EventView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly page = signal(this.initialQuery.page);
  protected readonly pageSize = signal(this.initialQuery.pageSize);
  protected readonly totalItems = signal(0);
  protected readonly search = signal(this.initialQuery.search);
  protected readonly statusFilter = signal(this.initialQuery.columnFilters['status'] ?? '');
  // No sort until the user picks one, which matches the table's own state. The API's newest-first
  // default then applies, so the first view is the same as before.
  protected readonly sortColumn = signal<string | null>(this.initialQuery.sort?.columnKey ?? null);
  protected readonly sortOrder = signal<'asc' | 'desc' | null>(
    this.initialQuery.sort?.direction ?? null,
  );

  protected readonly totalEventsCount = signal(0);
  protected readonly liveEventsCount = signal(0);
  protected readonly scheduledEventsCount = signal(0);
  protected readonly ctaEventsCount = signal(0);

  protected readonly summaryItems = computed<readonly SummaryItem[]>(() => {
    this.translate.dict();
    return [
      { label: this.t('events.stat.total'), value: this.totalEventsCount() },
      { label: this.t('events.stat.live'), value: this.liveEventsCount(), tone: 'success' },
      { label: this.t('events.stat.scheduled'), value: this.scheduledEventsCount() },
      { label: this.t('events.stat.cta'), value: this.ctaEventsCount(), tone: 'warning' },
    ];
  });

  protected readonly statusOptions = computed(() => {
    this.translate.dict();
    return EVENT_STATUSES.map((status) => ({
      value: status,
      label: this.t(`events.status.${status}` as TranslationKey),
    }));
  });

  /** Facets in force, for the filter bar's badge and clear button. The search box has its own clear. */
  protected readonly activeFilterCount = computed(
    () => (this.statusFilter() ? 1 : 0) + (this.showArchived() ? 1 : 0),
  );

  protected readonly headerMenu = computed<readonly MenuItem[]>(() => {
    this.translate.dict();
    return [
      {
        id: 'refresh',
        label: this.t('common.refreshNow'),
        icon: 'refresh',
        disabled: this.loading(),
      },
    ];
  });

  protected readonly columns = computed<readonly DataTableColumn<EventView>[]>(() => {
    this.translate.dict();
    return [
      {
        key: 'title',
        label: 'events.table.event',
        sortable: true,
        searchable: true,
        accessor: (event) => event.title,
      },
      {
        key: 'date',
        label: 'events.table.date',
        sortable: true,
        accessor: (event) => event.start_time_utc ?? event.event_date_utc,
      },
      {
        key: 'comp_name',
        label: 'events.table.composition',
        searchable: true,
        accessor: (event) => event.comp_name,
      },
      {
        key: 'status',
        label: 'events.table.status',
        sortable: true,
        accessor: (event) => event.status,
      },
      { key: 'actions', label: 'events.table.actions', align: 'right' },
    ];
  });

  protected async refreshNow(): Promise<void> {
    await Promise.all([this.load(), this.loadStats()]);
  }

  protected onHeaderMenu(id: string): void {
    if (id === 'refresh') {
      void this.refreshNow();
    }
  }

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelSearchTimer());
    void this.load();
    void this.loadStats();
  }

  protected readonly createOpen = signal(false);
  protected readonly saving = signal(false);
  protected readonly compsLoading = signal(false);
  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly compScope = signal<OwnershipScope>('mine');
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
  protected readonly draftPingAlliance = signal(false);
  protected readonly draftVodForumPost = signal(false);
  protected readonly allianceId = signal<string | null>(null);
  protected readonly allianceMembershipStatus = signal<string | null>(null);
  protected readonly canPingAlliance = computed(
    () =>
      this.auth.profile()?.tenant_kind === 'guild' &&
      Boolean(this.allianceId()) &&
      this.allianceMembershipStatus() === 'active',
  );
  protected readonly discordRoles = signal<DiscordRoleView[]>([]);
  protected readonly draftDiscordRoleIds = signal<string[]>([]);
  protected readonly roleError = signal<string | null>(null);
  protected readonly draftCreateSplit = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly draftIslandId = signal('');
  protected readonly draftTabId = signal('');
  /** The Discord section is collapsed until asked for; its summary stays visible. */
  protected readonly discordOpen = signal(false);
  /** Set by the first submit attempt; from then on every field error is shown live. */
  protected readonly submitAttempted = signal(false);
  private readonly touched = signal<ReadonlySet<CreateField>>(new Set());
  /** Element that opened the dialog, so focus returns to it on close. */
  private createTrigger: HTMLElement | null = null;
  protected readonly draftIsland = computed(() =>
    this.islands().find((island) => this.islandKey(island) === this.draftIslandId()),
  );
  protected readonly draftTabs = computed(() => this.draftIsland()?.tabs ?? []);

  /**
   * Island ids are only unique inside one guild's catalog, and an alliance lists every member
   * guild's islands together, so the guild is part of the key there.
   */
  protected islandKey(island: SplitIsland): string {
    return island.source_guild_tenant_id
      ? `${island.source_guild_tenant_id}|${island.id}`
      : String(island.id);
  }

  /** Validation message per invalid field; empty when the draft can be submitted. */
  protected readonly fieldErrors = computed<Partial<Record<CreateField, string>>>(() => {
    const errors: Partial<Record<CreateField, string>> = {};
    const required = this.t('validation.required');
    if (!this.draftTitle().trim()) {
      errors.title = required;
    }
    const date = this.draftEventDate();
    if (!date) {
      errors.date = required;
    } else if (date < this.minEventDate) {
      errors.date = this.t('events.create.dateInPast');
    }
    const massAt = combineLocalDateTime(date, this.draftMassTime());
    const startAt = combineLocalDateTime(date, this.draftStartTime());
    if (!this.draftMassTime()) {
      errors.mass = required;
    } else if (massAt && startAt && massAt > startAt) {
      errors.mass = this.t('events.create.massAfterStart');
    }
    if (!this.draftStartTime()) {
      errors.start = required;
    }
    if (Number(this.draftCompId()) <= 0) {
      errors.comp = this.t('events.create.comp_required');
    }
    const playerCapText = this.draftPlayerCap().trim();
    if (playerCapText) {
      const playerCap = Number(playerCapText);
      if (!Number.isSafeInteger(playerCap) || playerCap <= 0) {
        errors.playerCap = this.t('events.create.playerCapInvalid');
      }
    }
    if (this.draftCreateSplit()) {
      if (!this.draftIslandId()) {
        errors.island = required;
      } else if (!this.draftTabId()) {
        errors.tab = required;
      }
    }
    return errors;
  });

  /** The same errors as an ordered list for the validation summary. */
  protected readonly errorList = computed<readonly CreateFieldError[]>(() => {
    const errors = this.fieldErrors();
    return CREATE_FIELD_ORDER.flatMap((field) => {
      const message = errors[field];
      return message ? [{ field, label: CREATE_FIELDS[field].label, message }] : [];
    });
  });

  /** Local timezone and the UTC equivalent of the chosen mass and start times. */
  protected readonly scheduleNote = computed(() => {
    const date = this.draftEventDate();
    const massAt = combineLocalDateTime(date, this.draftMassTime());
    const startAt = combineLocalDateTime(date, this.draftStartTime());
    const note = this.t('events.create.timezoneNote', {
      zone: localTimezone(),
      offset: utcOffsetLabel(startAt ?? new Date()),
    });
    if (!massAt || !startAt) {
      return note;
    }
    const utc = this.t('events.create.utcPreview', {
      mass: formatUtcTime(massAt),
      start: formatUtcTime(startAt),
    });
    return `${note} ${utc}`;
  });

  /** One-line digest of the collapsed Discord section. */
  protected readonly discordSummary = computed(() => {
    const parts: string[] = [];
    const roles = this.draftDiscordRoleIds().length;
    if (roles > 0) {
      parts.push(this.t('events.create.summary.roles', { count: roles }));
    }
    if (this.canPingAlliance() && this.draftPingAlliance()) {
      parts.push(this.t('events.create.summary.alliance'));
    }
    if (this.draftVodForumPost()) {
      parts.push(this.t('events.create.summary.vod'));
    }
    return parts.length > 0 ? parts.join(' · ') : this.t('events.create.summary.none');
  });

  protected readonly showCompNone = computed(
    () => !this.compsLoading() && this.comps().length === 0,
  );

  protected readonly pendingArchive = signal<EventView | null>(null);
  protected readonly pendingUncancel = signal<EventView | null>(null);
  protected readonly archiving = signal(false);
  protected readonly reopening = signal(false);
  protected readonly showArchived = signal(this.route.snapshot.queryParamMap.get('archived') === 'true');

  protected readonly trackById = (event: EventView): number => event.id;
  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /** True when the current user can create a new event. */
  protected canCreate(): boolean {
    return this.auth.hasPermission('events.create');
  }

  /** True when the current user can archive or restore the given event. */
  protected canDelete(event: EventView): boolean {
    // A link's creator id belongs to the owning tenant; the owner checks authority on the request.
    if (event.is_link) return this.auth.hasPermission('events.manage');
    return (
      this.auth.hasPermission('events.manage') ||
      event.created_by === this.auth.profile()?.user_id
    );
  }

  /** True when the current user can edit the given event. */
  protected canEdit(event: EventView): boolean {
    if (event.is_link) return this.auth.hasPermission('events.manage');
    return (
      this.auth.hasPermission('events.manage') ||
      event.created_by === this.auth.profile()?.user_id
    );
  }

  /** Search text: the reload waits until typing pauses. */
  protected onSearchChange(query: string): void {
    this.search.set(query);
    this.cancelSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.applyFilterChange();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onStatusChange(event: Event): void {
    this.cancelSearchTimer();
    this.statusFilter.set((event.target as HTMLSelectElement).value);
    this.applyFilterChange();
  }

  protected onShowArchivedChange(event: Event): void {
    this.cancelSearchTimer();
    this.showArchived.set((event.target as HTMLInputElement).checked);
    this.applyFilterChange();
  }

  /** Drops every filter, the search box included. */
  protected clearFilters(): void {
    this.cancelSearchTimer();
    this.search.set('');
    this.statusFilter.set('');
    this.showArchived.set(false);
    this.applyFilterChange();
  }

  /**
   * Reloads from page 1 with the current filters. The filters go into the URL, and the data table
   * is moved back to page 1 through it, so its own paging state follows.
   */
  private applyFilterChange(): void {
    this.page.set(1);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        search: this.search().trim() || null,
        status: this.statusFilter() || null,
        archived: this.showArchived() ? 'true' : null,
        page: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.load();
  }

  private cancelSearchTimer(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected openCreate(): void {
    this.createTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.resetCreateDraft();
    this.compScope.set('mine');
    this.createOpen.set(true);
    // The native dialog would focus its close button first; the name is what people type next.
    afterNextRender(() => document.getElementById(CREATE_FIELDS.title.id)?.focus(), {
      injector: this.injector,
    });
    void this.loadCreateOptions();
  }

  protected setCompScope(scope: OwnershipScope): void {
    if (this.compScope() === scope) {
      return;
    }
    this.compScope.set(scope);
    void this.loadCreateComps();
  }

  protected ownershipLabel(name: string, createdBy: string): string {
    return ownershipOptionLabel(name, createdBy, this.compScope());
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
    const trigger = this.createTrigger;
    this.createTrigger = null;
    if (trigger?.isConnected) {
      trigger.focus();
    }
  }

  protected toggleDiscord(): void {
    this.discordOpen.update((open) => !open);
  }

  protected markTouched(field: CreateField): void {
    if (!this.touched().has(field)) {
      this.touched.update((fields) => new Set(fields).add(field));
    }
  }

  /** The inline message for a field, once it was left or a submit was attempted. */
  protected errorFor(field: CreateField): string | null {
    const message = this.fieldErrors()[field];
    if (!message) {
      return null;
    }
    const touched = this.touched();
    const seen =
      this.submitAttempted() ||
      touched.has(field) ||
      (field === 'mass' && touched.has('start'));
    return seen ? message : null;
  }

  protected errorId(field: CreateField): string {
    return `${CREATE_FIELDS[field].id}-error`;
  }

  /** `aria-describedby` for a control: its hint or note, then its error when one is shown. */
  protected describedBy(field: CreateField, ...ids: (string | null)[]): string | null {
    const described = ids.filter((id): id is string => Boolean(id));
    if (this.errorFor(field)) {
      described.push(this.errorId(field));
    }
    return described.length > 0 ? described.join(' ') : null;
  }

  protected focusField(field: CreateField): void {
    const element = document.getElementById(CREATE_FIELDS[field].id);
    element?.focus();
  }

  /** Opens the analytics view for a single event. */
  protected openEventDetail(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  /** Formats ISO date strings using the browser locale. */
  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString(this.translate.locale());
  }

  /** Join still lands on detail, where picking a build is what actually joins. */
  protected join(id: number): void {
    void this.router.navigate(['/events', id]);
  }

  protected requestArchive(event: EventView): void {
    this.pendingArchive.set(event);
  }

  protected cancelArchive(): void {
    this.pendingArchive.set(null);
  }

  protected async confirmArchive(): Promise<void> {
    const target = this.pendingArchive();
    if (!target) {
      return;
    }
    this.archiving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${target.id}/archive`, {}));
      this.pendingArchive.set(null);
      this.toasts.success(this.t('events.archiveSuccess'));
      if (this.events().length === 1 && this.page() > 1) {
        this.page.set(this.page() - 1);
      }
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.archiving.set(false);
    }
  }

  protected requestUncancel(event: EventView): void {
    this.pendingUncancel.set(event);
  }

  protected cancelUncancel(): void {
    this.pendingUncancel.set(null);
  }

  protected async confirmUncancel(): Promise<void> {
    const target = this.pendingUncancel();
    if (!target) {
      return;
    }
    this.reopening.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${target.id}/uncancel`, {}));
      this.pendingUncancel.set(null);
      this.toasts.success(this.t('events.uncancelSuccess'));
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.reopening.set(false);
    }
  }

  protected async unarchiveEvent(event: EventView): Promise<void> {
    this.archiving.set(true);
    try {
      await firstValueFrom(this.api.post(`api/events/${event.id}/unarchive`, {}));
      this.toasts.success(this.t('events.unarchiveSuccess'));
      if (this.events().length === 1 && this.page() > 1) {
        this.page.set(this.page() - 1);
      }
      await this.load();
      void this.loadStats();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.archiving.set(false);
    }
  }

  /**
   * Paging and sorting come from the table. Search and status belong to the filter bar, so the
   * table's echo of a filter change (its page reset) is ignored when nothing else moved.
   */
  protected onTablePageChange(change: DataTablePageChange): void {
    const sortColumn = change.sort?.columnKey ?? null;
    const sortOrder = change.sort?.direction ?? null;
    if (
      change.page === this.page() &&
      change.pageSize === this.pageSize() &&
      change.search.trim() === this.search().trim() &&
      sortColumn === this.sortColumn() &&
      sortOrder === this.sortOrder()
    ) {
      return;
    }
    this.page.set(change.page);
    this.pageSize.set(change.pageSize);
    this.sortColumn.set(sortColumn);
    this.sortOrder.set(sortOrder);
    void this.load();
  }

  protected formatMassTime(event: EventView): string {
    const dateStr = event.mass_time_utc ?? event.event_date_utc;
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected formatDateDay(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleDateString(this.translate.locale(), { month: 'short', day: 'numeric', year: 'numeric' });
  }

  protected formatDateTime(dateStr: string | null | undefined): string {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    return d.toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  protected async loadStats(): Promise<void> {
    try {
      // Counted by the backend, so the tiles stay exact beyond one page of events.
      const summary = await firstValueFrom(this.api.get<EventSummary>('api/events/summary'));
      this.totalEventsCount.set(summary.total);
      this.liveEventsCount.set(summary.live);
      this.scheduledEventsCount.set(summary.scheduled);
      this.ctaEventsCount.set(summary.call_to_arms);
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
  }

  protected onPlayerCapChange(event: Event): void {
    this.draftPlayerCap.set((event.target as HTMLInputElement).value);
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

    this.submitAttempted.set(true);
    if (this.errorList().length > 0) {
      this.focusErrorSummary();
      return;
    }

    const title = this.draftTitle().trim();
    const compId = Number(this.draftCompId());
    const playerCapText = this.draftPlayerCap().trim();
    const playerCap = playerCapText ? Number(playerCapText) : undefined;
    const massAt = combineLocalDateTime(this.draftEventDate(), this.draftMassTime());
    const startAt = combineLocalDateTime(this.draftEventDate(), this.draftStartTime());
    if (!massAt || !startAt) {
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
      ping_alliance: this.canPingAlliance() && this.draftPingAlliance(),
      vod_forum_post_enabled: this.draftVodForumPost(),
      discord_role_ids: this.draftDiscordRoleIds(),
      create_split: this.draftCreateSplit(),
      island_tab_id: this.draftCreateSplit() ? Number(this.draftTabId()) : undefined,
    };
    const originGuildId = this.draftCreateSplit()
      ? this.draftIsland()?.source_guild_tenant_id
      : undefined;
    if (originGuildId) {
      request.origin_guild_id = originGuildId;
    }
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
          archived: this.showArchived() ? 'true' : undefined,
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
    this.draftPingAlliance.set(false);
    this.draftVodForumPost.set(false);
    this.draftDiscordRoleIds.set([]);
    this.roleError.set(null);
    this.draftCreateSplit.set(false);
    this.draftIslandId.set('');
    this.draftTabId.set('');
    this.discordOpen.set(false);
    this.submitAttempted.set(false);
    this.touched.set(new Set());
  }

  /** Moves focus to the validation summary once it is rendered (or now, when it already is). */
  private focusErrorSummary(): void {
    const focus = (): void => document.getElementById('event-error-summary')?.focus();
    if (document.getElementById('event-error-summary')) {
      focus();
    } else {
      afterNextRender(focus, { injector: this.injector });
    }
  }

  private async loadCreateComps(): Promise<void> {
    this.compsLoading.set(true);
    try {
      const comps = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 100,
          sort: 'name',
          order: 'asc',
          ...ownershipListParams(this.compScope()),
        }),
      );
      this.comps.set(comps.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compsLoading.set(false);
    }
  }

  private async loadCreateOptions(): Promise<void> {
    this.compsLoading.set(true);
    this.allianceId.set(null);
    this.allianceMembershipStatus.set(null);
    try {
      const [comps, islands, alliance] = await Promise.all([
        firstValueFrom(this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: 100,
          sort: 'name',
          order: 'asc',
          ...ownershipListParams(this.compScope()),
        })),
        firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands')),
        firstValueFrom(this.api.get<AllianceContext>('api/alliances/me')).catch(() => null),
      ]);
      this.comps.set(comps.items);
      this.islands.set(islands);
      this.allianceId.set(alliance?.alliance_id ?? null);
      this.allianceMembershipStatus.set(alliance?.membership_status ?? null);
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

/** IANA name of the browser timezone, e.g. `Europe/Rome`. */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Offset of the browser timezone on the given day, e.g. `UTC+2` or `UTC-3:30`. */
function utcOffsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `UTC${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/** `HH:mm` of an instant in UTC. */
function formatUtcTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}
