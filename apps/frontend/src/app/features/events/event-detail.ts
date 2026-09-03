import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import type {
  BattleDetail,
  BattleLossEstimate,
  BattleSummary,
  BuildDetail,
  BuildItemSlot,
  BuildLoadout,
  BuildRole,
  BuildSlot,
  BuildSummary,
  CompBuildEntry,
  CompDetail,
  CompSummary,
  EventBattleSummary,
  EventDetailView,
  EventFight,
  EventParticipant,
  EventRosterRole,
  EventRosterSeat,
  EventRosterView,
  OpenAlbionItemAbilities,
  OpponentPerformanceView,
  PaginatedData,
  ParticipateEventRequest,
  SplitSummary,
  UpdateEventBattlesRequest,
  UpdateEventRequest,
  UserProfile,
  OpenAlbionItem,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeRosterService } from '../../core/services/realtime-roster.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { AlbionAbilitiesService } from '../../shared/services/albion-abilities.service';
import {
  abilityKeyForItem,
  abilitySlotsFor,
  albionAbilityIconUrl,
  type AbilitySlotView,
} from '../../shared/data/albion-abilities';
import {
  albionSpecializationKey,
  deduplicateAlbionCombatCatalog,
  normalizeAlbionEquipmentName,
} from '../../shared/data/albion-equipment-catalog';
import type { TranslationKey } from '../../i18n/en';
import { AbilityBar } from '../../shared/components/ability-bar/ability-bar';
import { Avatar } from '../../shared/components/avatar/avatar';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

/**
 * Sentinel `<select>` value for the virtual Fill role — a participation with no build. The wire
 * format is a `null` `primary_build_id`; an empty option value already means "nothing picked".
 * Mirrors `FILL_SIGNUP_VALUE` in the Discord bot's signup menu.
 */
const FILL_BUILD_VALUE = 'fill';

type EventDetailTab = 'roster' | 'overview' | 'battles' | 'splits';

type PendingConfirm =
  | { kind: 'delete' }
  | { kind: 'stop'; eventId: number }
  | { kind: 'cancel'; eventId: number }
  | { kind: 'unlink-split'; splitId: number }
  | { kind: 'clear-all' }
  | { kind: 'remove-participant'; userId: number; username: string; slotKey?: string };

function isEventDetailTab(value: string): value is EventDetailTab {
  return value === 'roster' || value === 'overview' || value === 'battles' || value === 'splits';
}

function formatDateInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTimeInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function combineLocalDateTime(date: string, time: string): Date | null {
  if (!date || !time) return null;
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export interface CompPartyGroup {
  readonly partyNumber: number;
  readonly partyName: string;
  readonly slots: readonly CompSlotRow[];
  readonly filledCount: number;
  readonly totalCount: number;
}

interface EventRosterParty {
  readonly partyNumber: number;
  readonly seats: readonly EventRosterSeat[];
}

const ROSTER_ROLE_ORDER: readonly string[] = [
  'tank',
  'support',
  'dps',
  'brawler',
  'healer',
  'battle_mount',
];

interface AddEventMemberRequest {
  user_id: number;
  primary_build_id: number | null;
  secondary_build_id?: number;
}

@Component({
  selector: 'app-event-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AbilityBar,
    Avatar,
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    EquipmentGrid,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    SearchDialog,
    StatCard,
    StatusChip,
    TooltipDirective,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (event(); as detail) {
      <!-- ================= PAGE HEADER: title, officer actions, tabs ================= -->
      <app-page-header [title]="detail.title">
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          (click)="backToEvents()"
          [appTooltip]="'Torna all\\'elenco degli eventi'"
          tooltipPosition="bottom"
        >
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('events.detail.back') }}
        </button>
        @if (canEdit() && detail.status === 'scheduled') {
          <button
            type="button"
            class="btn btn--primary btn--sm"
            (click)="start(detail.id)"
            [appTooltip]="'Avvia ufficialmente l\\'evento'"
            tooltipPosition="bottom"
          >
            <app-icon name="sparkles" size="0.875rem" />
            {{ t('events.start') }}
          </button>
        }
        @if (canEdit() && detail.status === 'scheduled') {
          <button
            type="button"
            class="btn btn--danger btn--sm"
            (click)="requestCancel(detail.id)"
            [appTooltip]="t('events.cancel')"
            tooltipPosition="bottom"
          >
            <app-icon name="close" size="0.875rem" />
            {{ t('events.cancel') }}
          </button>
        }
        @if (canEdit() && detail.status === 'live') {
          <button
            type="button"
            class="btn btn--danger btn--sm"
            (click)="stop(detail.id)"
            [appTooltip]="'Concludi l\\'evento in corso'"
            tooltipPosition="bottom"
          >
            <app-icon name="close" size="0.875rem" />
            {{ t('events.stop') }}
          </button>
        }
        @if (canEdit()) {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            (click)="toggleEditForm()"
            [appTooltip]="'Modifica dettagli evento'"
            tooltipPosition="bottom"
          >
            <app-icon name="settings" size="0.875rem" />
            {{ t('common.edit') }}
          </button>
        }
        @if (canDelete()) {
          <button
            type="button"
            class="btn btn--ghost btn--sm text-[var(--color-danger)] hover:bg-[var(--color-error-container)]"
            (click)="requestDelete()"
            [appTooltip]="'Elimina definitivamente l\\'evento'"
            tooltipPosition="bottom"
          >
            <app-icon name="close" size="0.875rem" />
            {{ t('common.delete') }}
          </button>
        }
        <app-view-toggle
          pageTabs
          [options]="tabOptions()"
          [active]="tab()"
          (activeChange)="onTabChange($event)"
        />
      </app-page-header>

      <!-- ================= EVENT SUMMARY: status, meta, description, your registration ================= -->
      <section class="card mb-3.5 p-3 sm:p-3.5">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <!-- Left Info Block -->
          <div class="space-y-1.5 min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <app-status-chip [value]="detail.status" />

              @if (detail.call_to_arms) {
                <span
                  class="chip chip--warning font-bold text-xs inline-flex items-center gap-1"
                  [appTooltip]="t('events.detail.cta_active')"
                >
                  <span class="cta-star">★</span> CTA
                </span>
              }

              @if (detail.regear) {
                <span
                  class="chip chip--tonal text-xs inline-flex items-center gap-1"
                  [appTooltip]="'Regear attivo: le perdite ammissibili saranno rimborsate'"
                >
                  <app-icon name="shield" size="0.75rem" />
                  {{ t('events.regear') }}
                </span>
              }

              <!-- Countdown Badge -->
              @if (detail.status === 'live') {
                <span
                  class="chip chip--success font-mono text-xs font-semibold inline-flex items-center gap-1.5 animate-pulse"
                >
                  <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"></span>
                  {{ t('events.detail.countdown_live') }}
                </span>
              } @else if (detail.status === 'scheduled') {
                <span class="chip chip--info font-mono text-xs inline-flex items-center gap-1">
                  <app-icon name="calendar" size="0.75rem" />
                  {{ countdownText() }}
                </span>
              } @else {
                <span class="chip font-mono text-xs text-[var(--color-text-secondary)]">
                  {{ t('events.detail.countdown_ended') }}
                </span>
              }
            </div>

            <div
              class="flex flex-wrap items-center gap-2.5 text-xs text-[var(--color-text-secondary)]"
            >
              <span class="inline-flex items-center gap-1 font-medium text-white">
                <app-icon name="calendar" size="0.75rem" />
                {{ formatDate(detail.start_time_utc ?? detail.event_date_utc) }}
              </span>
              <span>Mass: {{ formatTime(detail.mass_time_utc ?? detail.event_date_utc) }}</span>
              <span>Start: {{ formatTime(detail.start_time_utc ?? detail.event_date_utc) }}</span>

              <span class="text-[var(--color-text-tertiary)]">&bull;</span>

              <span class="inline-flex items-center gap-1">
                <app-icon name="package" size="0.75rem" />
                <strong class="text-white font-semibold">{{
                  detail.active_comp_name || detail.comp_name || t('events.detail.no_comp_linked')
                }}</strong>
              </span>

              <span class="text-[var(--color-text-tertiary)]">&bull;</span>

              <!-- Capacity Progress Pill -->
              <div
                class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[11px]"
              >
                <span>Capacità:</span>
                <span class="font-mono font-bold text-white">
                  {{ rosterFilledSeats() }}/{{ rosterSeatCount() }}
                </span>
                <div class="h-1 w-10 bg-[var(--color-border)] rounded-full overflow-hidden">
                  <div
                    class="h-full bg-[var(--color-success)] rounded-full transition-all"
                    [style.width.%]="
                      rosterSeatCount() > 0 ? (rosterFilledSeats() / rosterSeatCount()) * 100 : 0
                    "
                  ></div>
                </div>
              </div>
            </div>

            @if (detail.description) {
              <p class="text-[11px] text-[var(--color-text-secondary)] max-w-4xl line-clamp-2">
                {{ detail.description }}
              </p>
            }
          </div>

          <!-- Right Participation Card -->
          <div class="flex-shrink-0">
            @if (currentParticipant(); as participation) {
              <div
                class="rounded-xl px-3 py-2 border border-[var(--color-success)] bg-[var(--color-success-container)] min-w-[240px] space-y-1.5"
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5">
                    <span class="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                    <span class="text-[10px] font-bold uppercase tracking-wider text-success">
                      {{ t('events.detail.registered_as') }}
                    </span>
                  </div>
                  <span class="chip chip--success text-[9px] font-bold uppercase px-1.5 py-0.2">
                    {{
                      ownRosterSeat()
                        ? 'Titolare'
                        : isCurrentUserOnRosterBench()
                          ? 'Bench'
                          : 'Iscritto'
                    }}
                  </span>
                </div>

                <div class="text-xs">
                  <p class="font-semibold text-xs text-white truncate max-w-[14rem]">
                    @if (participation.primary_build_id === null) {
                      {{ t('events.detail.fill_option') }}
                    } @else {
                      {{
                        participation.primary_build_name ||
                          'Build #' + participation.primary_build_id
                      }}
                    }
                  </p>
                </div>

                <div class="flex items-center gap-1 pt-1.5 border-t border-[var(--color-success)]">
                  <button
                    type="button"
                    class="btn btn--outline btn--sm text-[10px] py-0.5 px-2 flex-1"
                    (click)="toggleJoinForm()"
                  >
                    {{ t('events.detail.change_build') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm text-[10px] py-0.5 px-2 text-error hover:bg-[var(--color-error-container)]"
                    (click)="leave(detail.id)"
                  >
                    {{ t('events.leave') }}
                  </button>
                </div>
              </div>
            } @else {
              <div
                class="rounded-xl px-3 py-2 border border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center gap-3"
              >
                <div>
                  <div class="flex items-center gap-1.5">
                    <app-icon name="users" size="0.75rem" />
                    <span class="text-xs font-semibold text-white"> Non sei iscritto </span>
                  </div>
                  <p class="text-[10px] text-[var(--color-text-secondary)]">
                    Prenota il tuo posto nella comp.
                  </p>
                </div>
                <button
                  type="button"
                  class="btn btn--primary btn--sm text-xs py-1 px-3 whitespace-nowrap"
                  (click)="toggleJoinForm()"
                >
                  <app-icon name="plus" size="0.75rem" />
                  {{ t('events.participate') }}
                </button>
              </div>
            }
          </div>
        </div>
      </section>

      <app-page-stack>
        @switch (tab()) {
          <!-- ================= TAB 1: ROSTER & COMPOSITION BUILDER ================= -->
          @case ('roster') {
            @if (rosterSnapshotState() === 'ready' && rosterSnapshot(); as roster) {
              <div class="space-y-4">
                <p class="event-detail__roster-live sr-only" aria-live="polite" aria-atomic="true">
                  {{ rosterAnnouncement() }}
                </p>

                <!-- 3-COLUMN COMPACT LAYOUT: SIDEBAR PANCHINA | CONTENT PARTY | SIDEBAR CON EQUIP -->
                <div
                  class="grid grid-cols-1 lg:grid-cols-[250px_1fr_310px] xl:grid-cols-[270px_1fr_340px] gap-4 items-start"
                >
                  <!-- 1. LEFT SIDEBAR: PANCHINA & CONTROLLI -->
                  <aside
                    class="space-y-3 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto scrollbar-thin"
                  >
                    <!-- Panchina Card -->
                    <div
                      class="card p-0 overflow-hidden transition-all shadow-sm"
                      [class.border-[var(--color-border)]]="!isDropTargetBench()"
                      [class.border-[var(--color-warning)]]="isDropTargetBench()"
                      [class.border-dashed]="isDropTargetBench()"
                      [class.ring-2]="isDropTargetBench()"
                      [class.ring-amber-500/50]="isDropTargetBench()"
                      [class.bg-[var(--color-warning-container)]]="isDropTargetBench()"
                      (dragover)="onBenchDragOver($event)"
                      (dragleave)="onBenchDragLeave($event)"
                      (drop)="onBenchDrop($event)"
                    >
                      <!-- Bench Header -->
                      <div
                        class="bg-[var(--color-surface-1)] p-3 border-b border-[var(--color-border)] space-y-2"
                      >
                        <div class="flex items-center justify-between">
                          <div class="flex items-center gap-1.5">
                            <app-icon name="users" size="0.875rem" />
                            <h3 class="font-bold text-xs uppercase tracking-wider text-white">
                              {{ t('events.detail.unassigned_signups') }}
                            </h3>
                          </div>
                          <span class="chip chip--warning font-mono text-[10px] font-bold">
                            {{ roster.bench.length }}
                          </span>
                        </div>

                        <!-- Search in Bench -->
                        @if (roster.bench.length > 0) {
                          <input
                            class="input input--sm text-xs py-1"
                            type="search"
                            placeholder="Cerca panchina..."
                            [value]="benchSearch()"
                            (input)="onBenchSearchInput($event)"
                          />
                        }
                      </div>

                      @if (isDropTargetBench()) {
                        <div
                          class="m-2 p-2.5 rounded-lg border-2 border-dashed border-[var(--color-warning)] bg-[var(--color-warning-container)] text-warning text-xs font-bold text-center animate-pulse flex items-center justify-center gap-2"
                        >
                          <app-icon name="users" size="0.875rem" />
                          Rilascia per spostare in panchina
                        </div>
                      }

                      <!-- Bench Members List -->
                      <div class="p-2 space-y-1.5 max-h-[300px] overflow-y-auto scrollbar-thin">
                        @for (member of filteredRosterBench(); track member.user_id) {
                          <div
                            class="surface p-2 hover:border-[var(--color-primary)] transition-all space-y-1 select-none rounded-lg"
                            [class.border-[var(--color-warning)]]="rosterAssignTarget() !== null"
                            [class.bg-[var(--color-warning-container)]]="rosterAssignTarget() !== null"
                            [class.opacity-40]="draggedBenchMember()?.user_id === member.user_id"
                            [attr.draggable]="canManageParticipants() && !rosterCommandSaving()"
                            (dragstart)="onBenchMemberDragStart($event, member)"
                            (dragend)="onDragEnd()"
                          >
                            <div class="flex items-center justify-between gap-1.5">
                              <div class="flex items-center gap-1.5 min-w-0">
                                @if (canManageParticipants()) {
                                  <span
                                    class="text-[var(--color-text-tertiary)] hover:text-white cursor-grab active:cursor-grabbing flex-shrink-0"
                                    [appTooltip]="'Trascina su un posto'"
                                    tooltipPosition="top"
                                  >
                                    <app-icon name="grip" size="0.75rem" />
                                  </span>
                                }
                                <app-avatar [username]="member.username" size="xs" />
                                <span class="text-xs font-semibold text-white truncate">
                                  {{ member.username }}
                                </span>
                              </div>

                              @if (canManageParticipants() && rosterAssignTarget(); as target) {
                                <button
                                  type="button"
                                  class="btn btn--primary btn--sm text-[10px] py-0.5 px-2 whitespace-nowrap"
                                  [disabled]="rosterCommandSaving()"
                                  (click)="assignBenchMemberToServerSeat(member.user_id)"
                                >
                                  P{{ target.party_number }} #{{ target.position }}
                                </button>
                              }
                            </div>

                            <div class="text-[10px] text-[var(--color-text-secondary)] space-y-0.5">
                              <div class="flex items-center justify-between gap-1">
                                <span class="text-[var(--color-text-tertiary)]">1ª:</span>
                                <span class="font-medium text-white truncate max-w-[10rem]">
                                  {{ member.primary_build_name || 'Generico' }}
                                </span>
                              </div>
                              @if (member.secondary_build_name) {
                                <div class="flex items-center justify-between gap-1">
                                  <span class="text-[var(--color-text-tertiary)]">2ª:</span>
                                  <span
                                    class="text-[var(--color-text-secondary)] truncate max-w-[10rem]"
                                  >
                                    {{ member.secondary_build_name }}
                                  </span>
                                </div>
                              }
                            </div>
                          </div>
                        } @empty {
                          <div class="py-6 text-center text-xs text-[var(--color-text-secondary)]">
                            Panchina vuota
                          </div>
                        }
                      </div>
                    </div>

                    <!-- Roster Controls & Actions Card -->
                    <div class="card p-3 space-y-3">
                      <div class="flex items-center justify-between">
                        <span
                          class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
                        >
                          Capacità Roster
                        </span>
                        <span class="font-mono text-xs font-bold text-white">
                          {{ rosterFilledSeats() }} / {{ rosterSeatCount() }}
                        </span>
                      </div>
                      <div
                        class="h-1.5 w-full bg-[var(--color-surface-2)] rounded-full overflow-hidden"
                      >
                        <div
                          class="h-full bg-[var(--color-success)] rounded-full transition-all"
                          [style.width.%]="
                            rosterSeatCount() > 0
                              ? (rosterFilledSeats() / rosterSeatCount()) * 100
                              : 0
                          "
                        ></div>
                      </div>

                      <!-- Weapon Spec Filter -->
                      <div class="space-y-1">
                        <span
                          class="text-[10px] text-[var(--color-text-secondary)] font-medium block"
                          >Filtro Spec:</span
                        >
                        <select
                          class="select select--sm text-xs py-1 px-2 h-7 w-full"
                          aria-label="Filtro spec arma"
                          [value]="selectedSpecializationKey()"
                          (change)="selectSpecialization($event)"
                        >
                          <option value="">Tutte le spec</option>
                          @for (item of specializationCatalog(); track item.id + ':' + item.type) {
                            <option [value]="specializationKey(item)">{{ item.name }}</option>
                          }
                        </select>
                      </div>

                      <!-- Management actions -->
                      <div class="grid gap-1.5 pt-2 border-t border-[var(--color-border)]">
                        @if (canEdit()) {
                          <button
                            type="button"
                            class="btn btn--outline btn--sm text-xs w-full justify-center"
                            (click)="openRosterRoleManager()"
                          >
                            <app-icon name="plus" size="0.75rem" />
                            Ruolo extra
                          </button>
                        }

                        @if (canManageParticipants()) {
                          <button
                            type="button"
                            class="btn btn--outline btn--sm text-xs w-full justify-center"
                            [disabled]="memberSaving() || rosterCommandSaving()"
                            (click)="openMemberPicker()"
                          >
                            <app-icon name="plus" size="0.75rem" />
                            Add a Member
                          </button>
                          <button
                            type="button"
                            class="btn btn--tonal btn--sm text-xs w-full justify-center"
                            [disabled]="rosterCommandSaving() || roster.bench.length === 0"
                            (click)="autoFillServerRoster()"
                            [appTooltip]="'Compila automaticamente posti liberi usando preferenze bench'"
                          >
                            <app-icon name="sparkles" size="0.75rem" />
                            Auto-fill
                          </button>
                        }

                        <button
                          type="button"
                          class="btn btn--ghost btn--sm text-xs w-full justify-center"
                          (click)="copyRosterForDiscord()"
                        >
                          <app-icon name="discord" size="0.875rem" />
                          {{ t('events.detail.copy_discord') }}
                        </button>
                      </div>
                    </div>
                  </aside>

                  <!-- 2. CENTER COLUMN: CONTENT PARTY -->
                  <div class="space-y-4 min-w-0">
                    <!-- Active swap / assign notice banner -->
                    @if (rosterSwapSource(); as source) {
                      <div
                        class="card p-3 border border-[var(--color-primary)] bg-[var(--color-surface-2)] flex items-center justify-between gap-3 shadow-md animate-pulse"
                      >
                        <div class="flex items-center gap-2 text-xs font-semibold text-white">
                          <app-icon
                            name="refresh"
                            size="1rem"
                            class="text-[var(--color-primary)]"
                          />
                          <span
                            >Seleziona il posto di destinazione per
                            <strong>{{ source.participant?.username }}</strong> ({{
                              source.build_name
                            }})</span
                          >
                        </div>
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-xs"
                          (click)="cancelRosterCommandMode()"
                        >
                          {{ t('events.detail.cancel_swap') }}
                        </button>
                      </div>
                    } @else if (rosterAssignTarget(); as target) {
                      <div
                        class="card p-3 border border-[var(--color-primary)] bg-[var(--color-surface-2)] flex items-center justify-between gap-3 shadow-md animate-pulse"
                      >
                        <div class="flex items-center gap-2 text-xs font-semibold text-white">
                          <app-icon name="plus" size="1rem" class="text-[var(--color-primary)]" />
                          <span
                            >Seleziona un membro dalla panchina per Party {{ target.party_number }},
                            pos. #{{ target.position }} ({{ target.build_name }})</span
                          >
                        </div>
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-xs"
                          (click)="cancelRosterCommandMode()"
                        >
                          {{ t('events.detail.cancel_swap') }}
                        </button>
                      </div>
                    }

                    <!-- Party tabs appear only when the comp spans more than one 20-player party. -->
                    @if (rosterParties().length > 1) {
                      <div
                        class="flex gap-1 overflow-x-auto border-b border-[var(--color-border)]"
                        role="tablist"
                        aria-label="Parties"
                      >
                        @for (party of rosterParties(); track party.partyNumber) {
                          <button
                            type="button"
                            role="tab"
                            class="shrink-0 border-b-2 border-transparent px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] focus-visible:outline-offset-[-2px]"
                            [class.event-detail__party-tab--active]="activeRosterParty()?.partyNumber === party.partyNumber"
                            [attr.aria-selected]="
                              activeRosterParty()?.partyNumber === party.partyNumber
                            "
                            [attr.tabindex]="
                              activeRosterParty()?.partyNumber === party.partyNumber ? 0 : -1
                            "
                            [attr.aria-controls]="'event-party-panel-' + party.partyNumber"
                            (click)="selectRosterParty(party.partyNumber)"
                            (keydown)="onRosterPartyKeydown($event, party.partyNumber)"
                          >
                            {{ rosterPartyName(party) }}
                            <span
                              class="ml-1 font-mono text-[10px] text-[var(--color-text-tertiary)]"
                            >
                              {{ rosterPartyFilledSeats(party) }}/{{ party.seats.length }}
                            </span>
                          </button>
                        }
                      </div>
                    }

                    @if (activeRosterParty(); as party) {
                      <section
                        class="card overflow-hidden border border-[var(--color-border)] p-0 shadow-sm"
                        role="tabpanel"
                        [id]="'event-party-panel-' + party.partyNumber"
                        [attr.aria-label]="rosterPartyName(party)"
                      >
                        <!-- Party Header -->
                        <header
                          class="flex items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3.5 py-2.5"
                        >
                          <div class="flex items-center gap-2">
                            <h3 class="text-xs font-bold uppercase tracking-wider text-white">
                              {{ rosterPartyName(party) }}
                            </h3>
                            <span class="text-[11px] font-mono text-[var(--color-text-secondary)]">
                              ({{ party.seats.length }} posti)
                            </span>
                          </div>

                          <div class="flex items-center gap-2">
                            <div
                              class="h-1.5 w-14 bg-[var(--color-surface-2)] rounded-full overflow-hidden"
                            >
                              <div
                                class="h-full bg-[var(--color-success)] rounded-full transition-all"
                                [style.width.%]="
                                  (rosterPartyFilledSeats(party) / party.seats.length) * 100
                                "
                              ></div>
                            </div>
                            <span class="font-mono text-xs font-bold text-white">
                              {{ rosterPartyFilledSeats(party) }}/{{ party.seats.length }}
                            </span>
                          </div>
                        </header>

                        <!-- Seats List -->
                        <ol
                          class="divide-y divide-[var(--color-border)]"
                          [attr.aria-label]="rosterPartyName(party)"
                        >
                          @for (
                            seat of party.seats;
                            track seat.party_number + ':' + seat.position
                          ) {
                            <li
                              class="px-3 py-2 transition-all flex items-center justify-between gap-2.5 hover:bg-[var(--color-surface-hover)] select-none"
                              [class]="roleBorderClass(seat.role)"
                              [class.bg-[var(--color-surface-2)]]="
                                rosterSwapSource()?.key === rosterSeatKey(seat) ||
                                activeInspectSeat()?.key === seat.key
                              "
                              [class.ring-1]="activeInspectSeat()?.key === seat.key"
                              [class.ring-[var(--color-primary)]]="
                                activeInspectSeat()?.key === seat.key
                              "
                              [class.ring-2]="
                                rosterSwapSource()?.key === rosterSeatKey(seat) ||
                                dropTargetSeatKey() === rosterSeatKey(seat)
                              "
                              [class.opacity-40]="draggedSeat()?.key === rosterSeatKey(seat)"
                              [attr.draggable]="
                                canManageParticipants() &&
                                seat.participant !== null &&
                                !rosterCommandSaving()
                              "
                              (dragstart)="onSeatDragStart($event, seat)"
                              (dragend)="onDragEnd()"
                              (dragover)="onSeatDragOver($event, seat)"
                              (dragleave)="onSeatDragLeave($event, seat)"
                              (drop)="onSeatDrop($event, seat)"
                            >
                              <!-- Left: Grip, Weapon Icon, Role & Build -->
                              <div class="flex items-center gap-2.5 min-w-0 flex-1">
                                @if (canManageParticipants() && seat.participant) {
                                  <span
                                    class="text-[var(--color-text-tertiary)] hover:text-white cursor-grab active:cursor-grabbing flex-shrink-0"
                                    [appTooltip]="'Trascina per scambiare posto o sposta in panchina'"
                                    tooltipPosition="top"
                                  >
                                    <app-icon name="grip" size="0.75rem" />
                                  </span>
                                }

                                <!-- Weapon Icon: Hover shows spell tooltip, Click opens details dialog & selects seat in sidebar -->
                                <button
                                  type="button"
                                  class="relative flex-shrink-0 h-9 w-9 rounded-lg p-0.5 flex items-center justify-center border border-[var(--color-border)] bg-[var(--color-surface-1)] cursor-pointer group hover:border-[var(--color-primary)] hover:scale-105 transition-all focus:outline-none"
                                  (click)="onSeatWeaponClick(seat)"
                                  (mouseenter)="onSeatWeaponMouseEnter(seat, $event)"
                                  (mouseleave)="onSeatWeaponMouseLeave()"
                                  [attr.aria-label]="'Ispeziona build ' + seat.build_name"
                                >
                                  @if (seatWeaponIconUrl(seat); as icon) {
                                    <img
                                      [src]="icon"
                                      [alt]="seat.build_name"
                                      class="h-full w-full object-contain pointer-events-none"
                                      loading="lazy"
                                    />
                                  } @else {
                                    <span
                                      class="text-[10px] font-mono font-bold text-[var(--color-text-secondary)]"
                                    >
                                      {{ roleGlyph(seat.role) }}
                                    </span>
                                  }
                                </button>

                                <!-- Build, Role & Occupant -->
                                <div class="min-w-0 flex-1">
                                  <div class="flex items-center gap-1.5 flex-wrap">
                                    <span
                                      class="text-[9px] uppercase font-bold px-1.5 py-0.2 rounded"
                                      [class]="roleChip(seat.role)"
                                    >
                                      {{ rosterSeatRoleLabel(seat) }}
                                    </span>
                                    <span
                                      class="text-xs font-bold text-white truncate max-w-[11rem]"
                                    >
                                      {{ seat.build_name }}
                                    </span>
                                    <span
                                      class="text-[10px] font-mono text-[var(--color-text-secondary)]"
                                    >
                                      #{{ seat.position }}
                                    </span>
                                  </div>

                                  <!-- Occupant details -->
                                  <div class="mt-0.5 flex items-center gap-2 min-w-0">
                                    @if (seat.participant; as participant) {
                                      <div class="flex items-center gap-1.5 min-w-0">
                                        <app-avatar [username]="participant.username" size="xs" />
                                        <span
                                          class="text-xs font-medium truncate"
                                          [class.text-[var(--color-primary)]]="
                                            participant.user_id === currentParticipant()?.user_id
                                          "
                                          [class.font-bold]="
                                            participant.user_id === currentParticipant()?.user_id
                                          "
                                          [class.text-white]="
                                            participant.user_id !== currentParticipant()?.user_id
                                          "
                                        >
                                          {{ participant.username }}
                                        </span>

                                        @if (selectedSpecializationKey()) {
                                          <span
                                            class="font-mono text-[9px] font-bold px-1 py-0.2 rounded"
                                            [class.bg-[var(--color-success)]/10]="
                                              participantSpecLevel(participant) >= 100
                                            "
                                            [class.text-success]="
                                              participantSpecLevel(participant) >= 100
                                            "
                                            [class.bg-[var(--color-warning-container)]]="
                                              participantSpecLevel(participant) > 0 &&
                                              participantSpecLevel(participant) < 100
                                            "
                                            [class.text-warning]="
                                              participantSpecLevel(participant) > 0 &&
                                              participantSpecLevel(participant) < 100
                                            "
                                            [class.text-[var(--color-text-disabled)]]="
                                              participantSpecLevel(participant) === 0
                                            "
                                          >
                                            {{ participantSpecLevel(participant) }}/120
                                          </span>
                                        }
                                      </div>
                                    } @else {
                                      <span
                                        class="text-[11px] italic text-[var(--color-text-disabled)]"
                                      >
                                        Posto libero
                                      </span>
                                    }
                                  </div>
                                </div>
                              </div>

                              <!-- Right: Quick actions -->
                              <div class="flex items-center gap-1 flex-shrink-0">
                                @if (canManageParticipants()) {
                                  @if (rosterSwapSource(); as source) {
                                    @if (source.key !== rosterSeatKey(seat)) {
                                      <button
                                        type="button"
                                        class="btn btn--primary btn--sm text-[10px] py-0.5 px-2"
                                        [disabled]="rosterCommandSaving()"
                                        (click)="swapServerRosterSeats(seat)"
                                      >
                                        Scambia qui
                                      </button>
                                    }
                                  } @else if (rosterAssignTarget(); as target) {
                                    <!-- Waiting for bench pick -->
                                  } @else if (seat.participant) {
                                    <button
                                      type="button"
                                      class="btn btn--ghost btn--sm p-1 text-[var(--color-text-secondary)] hover:text-white"
                                      [disabled]="rosterCommandSaving()"
                                      (click)="beginRosterSwap(seat)"
                                      [appTooltip]="'Scambia posto'"
                                      tooltipPosition="top"
                                    >
                                      <app-icon name="refresh" size="0.75rem" />
                                    </button>
                                    <button
                                      type="button"
                                      class="btn btn--ghost btn--sm p-1 text-error hover:bg-[var(--color-error-container)]"
                                      [disabled]="rosterCommandSaving()"
                                      (click)="clearServerRosterSeat(seat)"
                                      [appTooltip]="'Sposta in panchina'"
                                      tooltipPosition="top"
                                    >
                                      <app-icon name="close" size="0.75rem" />
                                    </button>
                                  } @else {
                                    <button
                                      type="button"
                                      class="btn btn--outline btn--sm text-[10px] py-0.5 px-1.5"
                                      [disabled]="rosterCommandSaving()"
                                      (click)="selectRosterAssignTarget(seat)"
                                    >
                                      + Assegna
                                    </button>
                                  }
                                }
                              </div>
                            </li>
                          }
                        </ol>
                      </section>
                    } @else {
                      <p class="py-8 text-center text-xs text-[var(--color-text-secondary)]">
                        Nessun party configurato.
                      </p>
                    }
                  </div>

                  <!-- 3. RIGHT SIDEBAR: SIDEBAR CON EQUIP -->
                  <aside
                    class="card p-3.5 space-y-3.5 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto scrollbar-thin"
                  >
                    @if (activeInspectSeat(); as seat) {
                      <!-- Header -->
                      <div class="space-y-2 border-b border-[var(--color-border)] pb-3">
                        <div class="flex items-center justify-between gap-2">
                          <span
                            class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            @if (ownRosterSeat()?.key === seat.key) {
                              Il tuo ruolo
                            } @else {
                              Ruolo selezionato
                            }
                          </span>
                          @if (
                            selectedInspectSeat() &&
                            ownRosterSeat() &&
                            selectedInspectSeat()?.key !== ownRosterSeat()?.key
                          ) {
                            <button
                              type="button"
                              class="text-[10px] text-[var(--color-primary)] hover:underline font-semibold"
                              (click)="selectedInspectSeat.set(null)"
                            >
                              Il mio ruolo
                            </button>
                          }
                        </div>

                        <div class="flex items-center justify-between gap-2">
                          <div class="min-w-0">
                            <h3 class="text-sm font-bold text-white truncate">
                              {{ seat.build_name }}
                            </h3>
                            <p class="text-[11px] text-[var(--color-text-secondary)] font-mono">
                              Party {{ seat.party_number }} · Pos. #{{ seat.position }}
                            </p>
                          </div>
                          <span
                            class="chip font-semibold text-[10px]"
                            [class]="roleChip(seat.role)"
                          >
                            {{ rosterSeatRoleLabel(seat) }}
                          </span>
                        </div>

                        <!-- Occupant pill -->
                        @if (seat.participant; as p) {
                          <div
                            class="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] bg-[var(--color-surface-2)] px-2 py-1 rounded-lg border border-[var(--color-border)]"
                          >
                            <app-avatar [username]="p.username" size="xs" />
                            <span class="truncate font-medium text-white">{{ p.username }}</span>
                          </div>
                        } @else {
                          <div
                            class="text-xs text-[var(--color-text-tertiary)] italic bg-[var(--color-surface-2)] px-2 py-1 rounded-lg border border-[var(--color-border)]"
                          >
                            Posto non occupato
                          </div>
                        }

                        <!-- Main / Swap Tabs -->
                        @if (rosterSeatBuildItems(seat).some((i) => i.loadout === 'swap')) {
                          <div
                            class="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)]"
                          >
                            <button
                              type="button"
                              class="flex-1 py-1 text-xs rounded font-medium transition-all text-center"
                              [class.bg-white/10]="inspectLoadout() === 'main'"
                              [class.text-white]="inspectLoadout() === 'main'"
                              [class.text-[var(--color-text-secondary)]]="
                                inspectLoadout() !== 'main'
                              "
                              (click)="inspectLoadout.set('main')"
                            >
                              Main Set
                            </button>
                            <button
                              type="button"
                              class="flex-1 py-1 text-xs rounded font-medium transition-all text-center"
                              [class.bg-white/10]="inspectLoadout() === 'swap'"
                              [class.text-white]="inspectLoadout() === 'swap'"
                              [class.text-[var(--color-text-secondary)]]="
                                inspectLoadout() !== 'swap'
                              "
                              (click)="inspectLoadout.set('swap')"
                            >
                              Swap Set
                            </button>
                          </div>
                        }
                      </div>

                      <!-- Paper doll / Equipment Grid -->
                      <div>
                        <p
                          class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2"
                        >
                          Equipaggiamento ({{ activeInspectItems().length }}/10)
                        </p>
                        <app-equipment-grid [items]="activeInspectItems()" />
                      </div>

                      <!-- Abilità e passive dell'equipaggiamento -->
                      <div class="space-y-2 pt-2 border-t border-[var(--color-border)]">
                        <div class="flex items-center justify-between">
                          <p
                            class="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            Abilità scelte
                          </p>
                          <span class="text-[10px] text-[var(--color-text-tertiary)]"
                            >Spell configurate</span
                          >
                        </div>

                        @let rows = activeInspectAbilityRows();
                        @if (rows.length > 0) {
                          <div class="space-y-2">
                            @for (row of rows; track row.slot) {
                              <div
                                class="p-2.5 bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-border)] space-y-1.5"
                              >
                                <span class="text-[11px] font-bold text-white block truncate">
                                  {{ row.itemName }}
                                </span>
                                <div class="grid gap-1">
                                  @for (slot of row.slots; track slot.label + slot.index) {
                                    @let chosen = selectedChoiceInSlot(slot);
                                    @if (chosen) {
                                      <div
                                        class="flex items-center gap-2 rounded bg-[var(--color-surface)] px-2 py-1 border border-white/5"
                                      >
                                        <span
                                          class="font-mono text-[10px] font-bold px-1 py-0.2 rounded bg-white/10 text-white min-w-5 text-center"
                                        >
                                          {{ slot.label }}
                                        </span>
                                        <img
                                          [src]="iconUrlForSpell(chosen.id)"
                                          [alt]="chosen.name"
                                          class="h-5 w-5 rounded object-contain border border-white/10 bg-black/40"
                                          loading="lazy"
                                        />
                                        <span class="text-xs text-white font-medium truncate">{{
                                          chosen.name
                                        }}</span>
                                      </div>
                                    }
                                  }
                                </div>
                              </div>
                            }
                          </div>
                        } @else {
                          <p class="text-xs text-[var(--color-text-secondary)] italic">
                            Nessuna abilità configurata per questa build.
                          </p>
                        }
                      </div>
                    } @else {
                      <div class="py-12 text-center text-xs text-[var(--color-text-secondary)]">
                        Nessun ruolo selezionato.
                      </div>
                    }
                  </aside>
                </div>
              </div>
            } @else if (rosterSnapshotState() === 'loading') {
              <section class="card p-6 text-center">
                <app-loading [label]="'Caricamento del roster in corso...'" />
              </section>
            } @else if (rosterSnapshotState() === 'error') {
              <section class="card p-6 border-[var(--color-error)] text-center space-y-2">
                <app-icon name="alert" size="2rem" color="var(--color-danger)" />
                <h2 class="text-sm font-bold text-[var(--color-text)]">Roster non disponibile</h2>
                <p class="text-xs text-[var(--color-text-secondary)]">
                  {{ rosterSnapshotError() }}
                </p>
                <button type="button" class="btn btn--outline btn--sm mt-2" (click)="load()">
                  Riprova
                </button>
              </section>
            }
          }

          <!-- ================= TAB 2: OVERVIEW & INTEL ================= -->
          @case ('overview') {
            <!-- Performance & Financial KPI Cards -->
            <section
              class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 mb-5"
              aria-label="Event Overview KPIs"
            >
              <!-- Card 1: Win Rate -->
              <article class="surface p-4">
                <p class="event-detail__label">{{ t('events.detail.win_rate') }}</p>
                <p class="event-detail__value mt-1">{{ formatPercent(detail.stats.win_rate) }}</p>
                <p class="event-detail__sub mb-2">
                  {{ detail.stats.wins }} {{ t('events.detail.wins') }} &middot;
                  {{ detail.stats.losses }} {{ t('events.detail.losses') }}
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

              <!-- Card 2: K/D Ratio & Kill Fame -->
              <article class="surface p-4">
                <p class="event-detail__label">
                  {{ t('events.detail.kd') }} &middot; {{ t('events.detail.kill_fame') }}
                </p>
                <p class="event-detail__value mt-1">
                  {{ formatRatio(detail.stats.kill_death_ratio) }}
                </p>
                <p class="event-detail__sub mb-2">
                  {{ detail.stats.total_kills }} {{ t('events.detail.kills') }} &middot;
                  {{ detail.stats.total_deaths }} {{ t('events.detail.deaths') }}
                </p>
                <p class="text-xs font-mono text-[var(--color-text-secondary)]">
                  Fame:
                  <strong class="text-[var(--color-text)]">{{
                    formatCompact(detail.stats.total_kill_fame)
                  }}</strong>
                </p>
              </article>

              <!-- Card 3: Estimated Combat Losses / Regear Expenses -->
              <article class="surface p-4">
                <p class="event-detail__label">{{ t('events.detail.our_guild_loss') }}</p>
                <p class="event-detail__value mt-1 text-[var(--color-danger)] font-mono">
                  -{{ formatAmount(eventLossEstimate().total_estimated_loss) }}
                </p>
                <p class="event-detail__sub">
                  {{ eventLossEstimate().priced_items }}/{{ eventLossEstimate().total_items }}
                  {{ t('events.detail.our_guild_loss_hint') }}
                </p>
              </article>

              <!-- Card 4: Net Financial Outcome (Loot vs Expenses) -->
              <article
                class="surface p-4"
                [class.border-[var(--color-success)]]="eventBalance().isProfitable"
                [class.border-[var(--color-danger)]]="!eventBalance().isProfitable"
              >
                <p class="event-detail__label">Net Event Balance</p>
                <p
                  class="event-detail__value mt-1 font-mono"
                  [class.text-[var(--color-success)]]="eventBalance().isProfitable"
                  [class.text-[var(--color-danger)]]="!eventBalance().isProfitable"
                >
                  {{ eventBalance().netBalance >= 0 ? '+' : ''
                  }}{{ formatAmount(eventBalance().netBalance) }}
                </p>
                <p class="event-detail__sub">
                  Loot: {{ formatCompact(eventBalance().totalLoot) }} &minus; Losses:
                  {{ formatCompact(eventBalance().totalLoss) }}
                </p>
              </article>
            </section>

            <!-- 2-Column Analytical Breakdown -->
            <div class="grid gap-5 lg:grid-cols-2">
              <!-- Left Column: Guild Member Equipment Losses -->
              <section class="card p-0 overflow-hidden shadow-sm">
                <header class="event-detail__section-header">
                  <div class="flex items-center gap-2">
                    <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
                      {{ t('events.detail.our_guild_losses_by_player') }}
                    </h2>
                    <span class="chip chip--tonal font-mono text-xs">{{
                      eventLossEstimate().players.length
                    }}</span>
                  </div>
                </header>
                @if (eventLossEstimate().players.length > 0) {
                  <div class="p-3 space-y-2 max-h-96 overflow-y-auto">
                    @for (player of eventLossEstimate().players; track player.player_name) {
                      <div class="surface flex items-center justify-between gap-3 p-3">
                        <div class="flex items-center gap-2.5 min-w-0">
                          <app-avatar [username]="player.player_name" size="sm" />
                          <div class="min-w-0">
                            <p class="text-xs font-bold text-[var(--color-text)] truncate">
                              {{ player.player_name }}
                            </p>
                            <p class="text-[11px] text-[var(--color-text-secondary)]">
                              {{ player.deaths }}
                              {{ player.deaths === 1 ? 'morte' : 'morti' }} &middot;
                              {{ player.priced_items }}/{{ player.total_items }} item
                            </p>
                          </div>
                        </div>

                        <div class="text-right flex-shrink-0">
                          <span class="font-mono text-xs font-bold text-[var(--color-danger)]">
                            -{{ formatAmount(player.estimated_loss) }}
                          </span>
                          <span
                            class="block text-[10px] font-mono text-[var(--color-text-secondary)]"
                          >
                            silver
                          </span>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="event-detail__empty text-center py-8">
                    {{ t('events.detail.no_opponents') }}
                  </p>
                }
              </section>

              <!-- Right Column: Top Opponents -->
              <section class="card p-0 overflow-hidden shadow-sm">
                <header class="event-detail__section-header">
                  <div class="flex items-center gap-2">
                    <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
                      {{ t('events.detail.opponents') }}
                    </h2>
                    <span class="chip chip--tonal font-mono text-xs">{{
                      detail.stats.top_opponents.length
                    }}</span>
                  </div>
                </header>
                @if (detail.stats.top_opponents.length > 0) {
                  <div class="p-3 space-y-2 max-h-96 overflow-y-auto">
                    @for (
                      opponent of detail.stats.top_opponents;
                      track opponent.guild_id || opponent.guild_name
                    ) {
                      <div class="surface p-3 space-y-2">
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-xs font-bold text-[var(--color-text)] truncate">
                            {{ opponent.guild_name || 'Gilda sconosciuta' }}
                          </span>
                          <span
                            class="text-xs font-mono font-medium text-[var(--color-text-secondary)]"
                          >
                            {{ opponent.wins }}W / {{ opponent.losses }}L ({{ opponent.battles }}
                            btl)
                          </span>
                        </div>

                        <div class="space-y-1">
                          <div
                            class="flex items-center justify-between text-[11px] font-mono text-[var(--color-text-secondary)]"
                          >
                            <span>Gilda: {{ formatCompact(opponent.guild_kill_fame) }}</span>
                            <span>Nemici: {{ formatCompact(opponent.opponent_kill_fame) }}</span>
                          </div>
                          @if (opponent.guild_kill_fame + opponent.opponent_kill_fame > 0) {
                            <div
                              class="event-detail__fill-bar"
                              style="background: var(--color-danger)"
                            >
                              <span
                                [style.width.%]="
                                  (opponent.guild_kill_fame /
                                    (opponent.guild_kill_fame + opponent.opponent_kill_fame)) *
                                  100
                                "
                                style="background: var(--color-success)"
                              ></span>
                            </div>
                          }
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="event-detail__empty text-center py-8">
                    {{ t('events.detail.no_opponents') }}
                  </p>
                }
              </section>
            </div>
          }

          <!-- ================= TAB 3: BATTLES & COMBAT LOGS ================= -->
          @case ('battles') {
            <div class="space-y-5">
              <!-- Battles Management Bar -->
              <section class="card p-4">
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="flex items-center gap-3">
                    <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
                      Fight {{ detail.fights.length }} &middot; {{ t('events.detail.battles') }} ({{
                        detail.battles.length
                      }})
                    </h2>
                    <span
                      class="font-mono text-xs font-semibold text-[var(--color-text-secondary)]"
                    >
                      {{ detail.stats.wins }}W / {{ detail.stats.losses }}L
                    </span>
                    <span class="font-mono text-xs font-semibold text-[var(--color-danger)]">
                      Perdite: -{{ formatAmount(eventLossEstimate().total_estimated_loss) }}
                    </span>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    @if (detail.battles.length > 0) {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm text-xs"
                        (click)="openBattleGroup(detail)"
                      >
                        <app-icon name="chart" size="0.75rem" />
                        {{ t('battles.group_selected') }}
                      </button>
                    }
                    @if (canEdit()) {
                      <button
                        type="button"
                        class="btn btn--primary btn--sm text-xs"
                        (click)="toggleBattleLinkForm()"
                      >
                        <app-icon name="link" size="0.75rem" />
                        {{ t('events.detail.manage_battles') }}
                      </button>
                    }
                  </div>
                </div>
              </section>

              @if (detail.fights.length > 0) {
                <section class="space-y-3" aria-label="Canonical fights">
                  @for (fight of detail.fights; track fight.id) {
                    @let metrics = fightMetrics(fight, detail.battles);
                    <article class="card p-5 shadow-sm space-y-4">
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div class="space-y-1">
                          <div class="flex items-center gap-2">
                            <span
                              class="chip font-mono text-xs font-bold"
                              [class.chip--success]="metrics.outcome === 'victory'"
                              [class.chip--error]="metrics.outcome === 'defeat'"
                            >
                              {{ fightOutcomeLabel(metrics.outcome) }}
                            </span>
                            <h3 class="font-bold text-base text-[var(--color-text)]">
                              Fight #{{ fight.id }}
                            </h3>
                          </div>
                          <p class="text-xs text-[var(--color-text-secondary)]">
                            {{ formatDate(fight.started_at) }} &middot; {{ fight.grouping_method }}
                            @if (fight.needs_review) {
                              &middot;
                              <span class="text-warning font-semibold">necessita revisione</span>
                            }
                          </p>
                        </div>

                        <button
                          type="button"
                          class="btn btn--outline btn--sm"
                          (click)="openFight(fight)"
                        >
                          Apri Fight &rarr;
                        </button>
                      </div>

                      <div
                        class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6 pt-3 border-t border-[var(--color-border)]"
                      >
                        <div class="surface p-3">
                          <p class="event-detail__label">{{ t('battles.outcome') }}</p>
                          <p class="text-xs font-bold mt-1 uppercase">{{ metrics.outcome }}</p>
                        </div>
                        <div class="surface p-3">
                          <p class="event-detail__label">{{ t('battles.segments') }}</p>
                          <p class="event-detail__value-sm mt-1">{{ metrics.segments }}</p>
                        </div>
                        <div class="surface p-3">
                          <p class="event-detail__label">Confidence</p>
                          <p class="event-detail__value-sm mt-1">
                            {{ formatPercent(fight.grouping_confidence) }}
                          </p>
                        </div>
                        @if (metrics.players !== null) {
                          <div class="surface p-3">
                            <p class="event-detail__label">{{ t('battles.players') }}</p>
                            <p class="event-detail__value-sm mt-1">
                              {{ formatNumber(metrics.players) }}
                            </p>
                          </div>
                        }
                        @if (metrics.kills !== null) {
                          <div class="surface p-3">
                            <p class="event-detail__label">{{ t('battles.kills') }}</p>
                            <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                              {{ formatNumber(metrics.kills) }}
                            </p>
                          </div>
                        }
                        @if (metrics.fame !== null) {
                          <div class="surface p-3">
                            <p class="event-detail__label">{{ t('battles.kill_fame') }}</p>
                            <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                              {{ formatCompact(metrics.fame) }}
                            </p>
                          </div>
                        }
                      </div>
                    </article>
                  }
                </section>
              }

              <!-- Raw Battle segment drill-down -->
              @if (detail.battles.length > 0) {
                <div class="space-y-3">
                  @for (battle of detail.battles; track battle.id) {
                    <article class="card p-5 shadow-sm space-y-3">
                      <div
                        class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]"
                      >
                        <div class="flex items-center gap-2.5 flex-wrap">
                          <span
                            class="chip font-mono text-xs font-bold"
                            [class.chip--success]="battle.is_win"
                            [class.chip--error]="!battle.is_win"
                          >
                            {{ battle.is_win ? 'VITTORIA' : 'SCONFITTA' }}
                          </span>
                          <a
                            class="font-mono text-xs text-[var(--color-primary)] font-bold hover:underline"
                            [routerLink]="['/battles', battle.albionbb_battle_id]"
                          >
                            Battle #{{ battle.albionbb_battle_id }}
                          </a>
                          <span class="text-xs text-[var(--color-text-secondary)]">
                            &middot; {{ formatDate(battle.battle_started_at) }}
                          </span>
                          @if (battle.opponent_guild_name) {
                            <span class="chip chip--tonal text-xs font-semibold">
                              vs {{ battle.opponent_guild_name }}
                            </span>
                          }
                        </div>

                        <div class="flex items-center gap-2">
                          <a
                            class="btn btn--ghost btn--sm text-xs"
                            [href]="
                              'https://albionbattles.com/battles/' + battle.albionbb_battle_id
                            "
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            AlbionBB &rarr;
                          </a>
                          <button
                            type="button"
                            class="btn btn--primary btn--sm text-xs"
                            (click)="openBattle(battle.albionbb_battle_id)"
                          >
                            {{ t('events.detail.open_battle') }}
                          </button>
                        </div>
                      </div>

                      <!-- 4-Column Combat Metrics -->
                      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div class="surface p-3">
                          <span class="event-detail__label">Forze in campo</span>
                          <p class="font-mono text-sm font-bold text-[var(--color-text)] mt-0.5">
                            {{ battle.guild_players_count }}
                            <span class="text-xs text-[var(--color-text-secondary)]">vs</span>
                            {{ battle.opponent_players_count ?? '—' }}
                          </p>
                        </div>

                        <div class="surface p-3">
                          <span class="event-detail__label">Kill / Morti</span>
                          <p class="font-mono text-sm font-bold text-[var(--color-text)] mt-0.5">
                            <span class="text-[var(--color-success)]">{{
                              battle.guild_kills
                            }}</span>
                            /
                            <span class="text-[var(--color-danger)]">{{
                              battle.guild_deaths
                            }}</span>
                          </p>
                        </div>

                        <div class="surface p-3">
                          <span class="event-detail__label">Fama Kill Gilda</span>
                          <p class="font-mono text-sm font-bold text-[var(--color-success)] mt-0.5">
                            +{{ formatCompact(battle.guild_kill_fame) }}
                          </p>
                        </div>

                        <div class="surface p-3">
                          <span class="event-detail__label">Morti Registrate</span>
                          <p class="font-mono text-sm font-bold text-[var(--color-danger)] mt-0.5">
                            {{ battle.guild_deaths }} morti
                          </p>
                        </div>
                      </div>
                    </article>
                  }
                </div>
              } @else {
                <div class="card p-10 text-center">
                  <app-empty-state [message]="t('events.detail.no_battles')" icon="swords" />
                </div>
              }
            </div>
          }

          <!-- ================= TAB 4: LOOT & SPLITS ================= -->
          @case ('splits') {
            <div class="space-y-5">
              <!-- Summary Strip -->
              <section class="card p-5 shadow-sm">
                <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
                  <div>
                    <h2 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]">
                      {{ t('events.detail.splits') }} ({{ detail.splits.length }})
                    </h2>
                    <p class="text-xs text-[var(--color-text-secondary)] mt-0.5">
                      Ripartizione del bottino e compensi generati dall'evento.
                    </p>
                  </div>

                  <div class="flex items-center gap-3">
                    <div class="text-right">
                      <span class="text-xs text-[var(--color-text-secondary)] block"
                        >Totale Netto:</span
                      >
                      <strong class="text-sm font-mono font-bold text-[var(--color-success)]">
                        {{ formatAmount(detail.split_stats.completed_net_value) }} silver
                      </strong>
                    </div>
                    @if (canEdit()) {
                      <button
                        type="button"
                        class="btn btn--primary btn--sm text-xs"
                        (click)="showSplitSearch.set(true)"
                      >
                        <app-icon name="plus" size="0.75rem" />
                        {{ t('events.detail.link_split') }}
                      </button>
                    }
                  </div>
                </div>

                @if (detail.split_stats.total_splits > 0) {
                  <div
                    class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-4 border-t border-[var(--color-border)]"
                  >
                    <div class="surface p-3">
                      <p class="event-detail__label">{{ t('events.detail.split_total') }}</p>
                      <p class="event-detail__value-sm mt-1 font-bold">
                        {{ detail.split_stats.total_splits }}
                      </p>
                    </div>
                    <div class="surface p-3">
                      <p class="event-detail__label">{{ t('events.detail.split_completed') }}</p>
                      <p class="event-detail__value-sm mt-1 text-[var(--color-success)] font-bold">
                        {{ detail.split_stats.completed_splits }}
                      </p>
                    </div>
                    <div class="surface p-3">
                      <p class="event-detail__label">{{ t('events.detail.split_pending') }}</p>
                      <p class="event-detail__value-sm mt-1 text-[var(--color-warning)] font-bold">
                        {{ detail.split_stats.pending_splits }}
                      </p>
                    </div>
                    <div class="surface p-3">
                      <p class="event-detail__label">{{ t('events.detail.split_net') }}</p>
                      <p
                        class="event-detail__value-sm mt-1 text-[var(--color-success)] font-mono font-bold"
                      >
                        {{ formatAmount(detail.split_stats.completed_net_value) }}
                      </p>
                    </div>
                  </div>
                }
              </section>

              <!-- Splits List -->
              @if (detail.splits.length > 0) {
                <div class="space-y-3">
                  @for (split of detail.splits; track split.id) {
                    <article class="card p-5 shadow-sm space-y-3">
                      <div
                        class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]"
                      >
                        <div class="flex items-center gap-2.5 flex-wrap">
                          <app-status-chip [value]="split.status" />
                          <a
                            class="text-sm font-bold text-[var(--color-text)] hover:underline"
                            [routerLink]="['/splits', split.id]"
                          >
                            {{ split.note || t('events.detail.split_number') + split.id }}
                          </a>
                          @if (split.island_name) {
                            <span class="chip chip--tonal text-xs font-mono">
                              {{ cityLabel(split.island_city) }} &middot;
                              {{ split.island_name }} &middot; {{ split.island_tab_name }}
                            </span>
                          }
                          <span class="text-xs text-[var(--color-text-secondary)]">
                            &middot; {{ formatDate(split.created_at) }}
                          </span>
                        </div>

                        <div class="flex items-center gap-2">
                          <a
                            class="btn btn--outline btn--sm text-xs"
                            [routerLink]="['/splits', split.id]"
                          >
                            {{ t('common.open') }} &rarr;
                          </a>
                          @if (canEdit()) {
                            <button
                              type="button"
                              class="btn btn--ghost btn--sm text-[var(--color-danger)]"
                              (click)="unlinkSplit(split.id)"
                              [attr.aria-label]="t('events.detail.unlink_split')"
                            >
                              <app-icon name="close" size="0.875rem" />
                            </button>
                          }
                        </div>
                      </div>

                      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div class="surface p-3">
                          <span class="event-detail__label">{{ t('splits.estimated') }}</span>
                          <p class="font-mono text-xs font-bold text-[var(--color-text)] mt-0.5">
                            {{ formatAmount(split.estimated_market_value) }}
                          </p>
                        </div>
                        <div class="surface p-3">
                          <span class="event-detail__label">{{ t('splits.repair_cost') }}</span>
                          <p class="font-mono text-xs font-bold text-[var(--color-danger)] mt-0.5">
                            -{{ formatAmount(split.repair_value) }}
                          </p>
                        </div>
                        <div class="surface p-3">
                          <span class="event-detail__label">{{ t('splits.bags_value') }}</span>
                          <p class="font-mono text-xs font-bold text-[var(--color-text)] mt-0.5">
                            +{{ formatAmount(split.bags_value) }}
                          </p>
                        </div>
                        <div class="surface p-3">
                          <span class="event-detail__label">{{ t('splits.net_value') }}</span>
                          <p class="font-mono text-xs font-bold text-[var(--color-success)] mt-0.5">
                            {{ formatAmount(netOfSplit(split)) }} ({{ split.participant_count }} p)
                          </p>
                        </div>
                      </div>
                    </article>
                  }
                </div>
              } @else {
                <div class="card p-10 text-center">
                  <app-empty-state [message]="t('events.detail.no_splits')" icon="package" />
                </div>
              }
            </div>
          }
        }
      </app-page-stack>
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    } @else {
      <app-empty-state [message]="t('common.empty')" icon="calendar" />
    }

    <!-- ================= MODAL DIALOGS ================= -->

    <!-- 1. EDIT EVENT DIALOG -->
    @if (showEditForm()) {
      <app-dialog [title]="t('common.edit')" size="lg" (closed)="toggleEditForm()">
        <form class="grid gap-4" (submit)="onUpdateSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }} *</span>
            <input
              class="input"
              type="text"
              required
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

          <div class="grid gap-4 sm:grid-cols-4">
            <div>
              <span class="label">{{ t('events.detail.comp') }}</span>
              <div class="flex items-center gap-2">
                <div
                  class="flex-1 input flex items-center bg-[var(--color-surface-2)] text-xs truncate"
                >
                  <span class="truncate">{{
                    draftCompTitle() || t('events.detail.no_comp_linked')
                  }}</span>
                </div>
                <button
                  type="button"
                  class="btn btn--outline btn--sm whitespace-nowrap"
                  (click)="showCompSearch.set(true)"
                >
                  {{ t('events.detail.link_comp') }}
                </button>
                @if (draftCompId()) {
                  <button
                    type="button"
                    class="btn btn--danger btn--sm"
                    (click)="unlinkComp()"
                    [attr.aria-label]="t('events.detail.unlink_comp')"
                  >
                    <app-icon name="close" size="0.875rem" />
                  </button>
                }
              </div>
            </div>

            <label>
              <span class="label">{{ t('common.date') }} *</span>
              <input
                class="input"
                type="date"
                required
                [value]="draftEventDate()"
                (input)="onEventDateChange($event)"
              />
            </label>

            <label>
              <span class="label">Mass *</span>
              <input
                class="input"
                type="time"
                required
                [value]="draftMassTime()"
                (input)="onMassTimeChange($event)"
              />
            </label>

            <label>
              <span class="label">Start *</span>
              <input
                class="input"
                type="time"
                required
                [value]="draftStartTime()"
                (input)="onStartTimeChange($event)"
              />
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-6 pt-2">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftCallToArms()"
                (change)="onCallToArmsChange($event)"
              />
              <span class="text-xs font-semibold">{{ t('events.call_to_arms') }}</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                class="checkbox"
                type="checkbox"
                [checked]="draftRegear()"
                (change)="onRegearChange($event)"
              />
              <span class="text-xs font-semibold">{{ t('events.regear') }}</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
            <button type="button" class="btn btn--ghost btn--sm" (click)="toggleEditForm()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      </app-dialog>
    }

    <!-- 2. PARTICIPATE / CHANGE BUILD DIALOG -->
    @if (showJoinForm()) {
      <app-dialog
        [title]="currentParticipant() ? t('events.detail.change_build') : t('events.participate')"
        size="md"
        (closed)="toggleJoinForm()"
      >
        <form class="grid gap-4" (submit)="onJoinSubmit($event)">
          @if (compLoading()) {
            <app-loading [label]="t('common.loading')" />
          } @else {
            @if (availableBuilds().length === 0) {
              <p class="text-xs text-[var(--color-text-secondary)]">
                {{ t('events.detail.no_builds') }}
              </p>
            }
            <label>
              <span class="label">{{ t('events.detail.primary_build') }} *</span>
              <select class="select" required (change)="onPrimaryBuildChange($event)">
                <option value="" [selected]="!draftPrimaryBuildId()">
                  — Seleziona Build Primaria —
                </option>
                <option [value]="fillValue" [selected]="isFillSelected()">
                  {{ t('events.detail.fill_option') }}
                </option>
                @for (entry of availableBuilds(); track entry.build_id) {
                  <option
                    [value]="entry.build_id"
                    [selected]="isSelectedBuild(draftPrimaryBuildId(), entry.build_id)"
                  >
                    {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
                    @if (entry.build.category_name) {
                      ({{ entry.build.category_name }})
                    }
                  </option>
                }
              </select>
            </label>

            @if (!isFillSelected()) {
              <div
                class="surface flex items-center gap-3 p-3 border border-[var(--color-border)]"
                aria-live="polite"
              >
                <app-icon name="swords" size="1rem" />
                <div class="min-w-0">
                  <p class="label mb-0.5">Arma principale</p>
                  <p class="text-sm font-semibold text-[var(--color-text)] truncate">
                    {{ selectedJoinWeapon()?.openalbion_item_name || 'Arma non disponibile' }}
                  </p>
                </div>
              </div>

              <label>
                <span class="label">{{ t('events.detail.secondary_build') }}</span>
                <select class="select" (change)="onSecondaryBuildChange($event)">
                  <option value="" [selected]="!draftSecondaryBuildId()">
                    — Nessuna (Opzionale) —
                  </option>
                  @for (entry of availableBuilds(); track entry.build_id) {
                    <option
                      [value]="entry.build_id"
                      [selected]="isSelectedBuild(draftSecondaryBuildId(), entry.build_id)"
                    >
                      {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
                    </option>
                  }
                </select>
              </label>
            }

            @if (joinError()) {
              <p class="text-xs text-[var(--color-danger)] font-semibold">{{ joinError() }}</p>
            }

            <div class="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
              <button type="button" class="btn btn--ghost btn--sm" (click)="toggleJoinForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="joinSubmitting()">
                {{ currentParticipant() ? t('common.save') : t('events.participate') }}
              </button>
            </div>
          }
        </form>
      </app-dialog>
    }

    <!-- 3. JOIN CONFIRMATION DIALOG -->
    @if (showJoinConfirm()) {
      <app-dialog
        [title]="t('events.participate')"
        [subtitle]="'Controlla la build prima di confermare la partecipazione.'"
        size="sm"
        (closed)="cancelJoinConfirm()"
      >
        <div class="space-y-3">
          @if (isFillSelected()) {
            <div class="surface p-3">
              <p class="label">Ruolo</p>
              <p class="text-sm font-semibold text-[var(--color-text)]">
                {{ t('events.detail.fill_option') }}
              </p>
              <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
                Nessuna build o arma principale selezionata.
              </p>
            </div>
          } @else {
            <div class="surface p-3 space-y-2">
              <div>
                <p class="label">Build / slot</p>
                <p class="text-sm font-semibold text-[var(--color-text)]">
                  {{ selectedJoinBuild()?.build?.name || 'Build selezionata' }}
                  @if (selectedJoinBuild()?.build?.role; as role) {
                    <span class="text-xs text-[var(--color-text-secondary)]">
                      &middot; {{ roleLabelName(role) }}
                    </span>
                  }
                </p>
              </div>
              <div class="pt-2 border-t border-[var(--color-border)]">
                <p class="label">Weapon principale</p>
                <p class="text-sm font-semibold text-[var(--color-text)]">
                  {{ selectedJoinWeapon()?.openalbion_item_name || 'Arma non disponibile' }}
                </p>
              </div>
            </div>
          }

          @if (draftSecondaryBuildId() && !isFillSelected()) {
            <p class="text-xs text-[var(--color-text-secondary)]">
              Build secondaria inclusa:
              {{ selectedJoinSecondaryBuild()?.build?.name || 'Selezionata' }}
            </p>
          }
        </div>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost btn--sm" (click)="cancelJoinConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="joinSubmitting()"
            (click)="confirmJoin()"
          >
            {{ t('common.confirm') }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- 4. MANAGE BATTLES DIALOG -->
    @if (showBattleLinkForm()) {
      <app-dialog
        [title]="t('events.detail.manage_battles')"
        size="md"
        (closed)="toggleBattleLinkForm()"
      >
        <form class="grid gap-4" (submit)="onBattleLinksSubmit($event)">
          <div>
            <div class="flex justify-between items-center mb-2">
              <span class="label font-medium text-xs">{{ t('events.detail.battle_ids') }}</span>
              <button
                type="button"
                class="btn btn--outline btn--sm text-xs"
                (click)="showBattleSearch.set(true)"
              >
                <app-icon name="plus" size="0.75rem" />
                {{ t('events.detail.add_battle') }}
              </button>
            </div>

            <div class="flex flex-col gap-2 max-h-60 overflow-y-auto pr-1">
              @for (link of draftBattleLinks(); track link.id) {
                <div class="flex items-center gap-2">
                  <div
                    class="flex-1 input flex items-center bg-[var(--color-surface-2)] text-xs truncate"
                  >
                    <span class="truncate">{{ link.title }}</span>
                  </div>
                  <button
                    type="button"
                    class="btn btn--danger btn--sm"
                    (click)="removeDraftBattle(link.id)"
                    [attr.aria-label]="t('events.detail.remove_battle')"
                  >
                    <app-icon name="close" size="0.875rem" />
                  </button>
                </div>
              } @empty {
                <p class="text-xs text-[var(--color-text-secondary)] py-4 text-center">
                  {{ t('events.detail.no_battles_linked') }}
                </p>
              }
            </div>
          </div>

          <div class="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
            <button type="button" class="btn btn--ghost btn--sm" (click)="toggleBattleLinkForm()">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="battleLinksSaving()">
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      </app-dialog>
    }

    <!-- 4. EXTRA ROSTER ROLES DIALOG -->
    @if (rosterRoleManagerOpen()) {
      <app-dialog title="Ruoli extra del roster" size="md" (closed)="closeRosterRoleManager()">
        <div class="grid gap-4">
          <section
            aria-labelledby="fill-role-heading"
            class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3.5"
          >
            <h2
              id="fill-role-heading"
              class="text-xs font-bold uppercase tracking-wider text-[var(--color-text)]"
            >
              Fill Automatico
            </h2>
            <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
              Ruolo con posti illimitati per chi non ha una posizione fissa.
            </p>
          </section>

          <form class="grid gap-2" (submit)="addRosterRole($event)">
            <label for="extra-roster-build" class="label">Aggiungi nuova build al roster</label>
            <div class="flex gap-2">
              <select
                id="extra-roster-build"
                name="build_id"
                class="select flex-1"
                required
                [value]="draftRosterRoleBuildId()"
                (change)="onDraftRosterRoleBuildChange($event)"
              >
                <option value="">Seleziona una build</option>
                @for (build of availableExtraRoleBuilds(); track build.id) {
                  <option [value]="build.id">
                    {{ build.name }} &middot; {{ roleLabelName(build.role) }}
                  </option>
                }
              </select>
              <button
                type="submit"
                class="btn btn--primary btn--sm"
                [disabled]="rosterRoleSaving()"
              >
                Aggiungi
              </button>
            </div>
            @if (rosterRoleError()) {
              <p class="text-xs text-[var(--color-danger)] font-medium" aria-live="polite">
                {{ rosterRoleError() }}
              </p>
            }
          </form>

          <section aria-labelledby="extra-roles-heading">
            <h2 id="extra-roles-heading" class="label">Ruoli extra attivi</h2>
            <div class="mt-2 grid gap-2">
              @for (role of extraRosterRoles(); track role.id) {
                <div class="surface flex min-h-11 items-center justify-between gap-3 px-3.5 py-2">
                  <span class="text-xs font-semibold text-[var(--color-text)]">{{
                    role.name
                  }}</span>
                  <button
                    type="button"
                    class="btn btn--danger btn--sm text-xs py-0.5 px-2"
                    (click)="removeRosterRole(role)"
                    [disabled]="rosterRoleSaving()"
                  >
                    Rimuovi
                  </button>
                </div>
              } @empty {
                <p class="text-xs text-[var(--color-text-secondary)] py-2">
                  Nessun ruolo extra configurato.
                </p>
              }
            </div>
          </section>
        </div>
      </app-dialog>
    }

    <!-- 5. ADD MEMBER DIALOGS -->
    @if (draftMember(); as member) {
      <app-dialog title="Add a Member" size="md" (closed)="closeMemberForm()">
        <form class="grid gap-4" (submit)="onMemberSubmit($event)">
          <div class="surface flex items-center gap-3 p-3">
            <app-avatar [username]="member.title" size="sm" />
            <div class="min-w-0">
              <p class="label">Membro</p>
              <p class="text-sm font-semibold text-[var(--color-text)] truncate">
                {{ member.title }}
              </p>
            </div>
          </div>

          @if (compLoading()) {
            <app-loading [label]="t('common.loading')" />
          } @else {
            <label>
              <span class="label">Build / slot primaria *</span>
              <select
                class="select"
                required
                [value]="draftMemberPrimaryBuildId()"
                (change)="onMemberPrimaryBuildChange($event)"
              >
                <option value="">Seleziona build / slot</option>
                <option [value]="fillValue">{{ t('events.detail.fill_option') }}</option>
                @for (entry of availableBuilds(); track entry.build_id) {
                  <option [value]="entry.build_id">
                    {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
                    @if (entry.build.category_name) {
                      ({{ entry.build.category_name }})
                    }
                  </option>
                }
              </select>
            </label>

            @if (draftMemberPrimaryBuildId() && draftMemberPrimaryBuildId() !== fillValue) {
              <label>
                <span class="label">Build / slot secondaria</span>
                <select
                  class="select"
                  [value]="draftMemberSecondaryBuildId()"
                  (change)="onMemberSecondaryBuildChange($event)"
                >
                  <option value="">Nessuna (opzionale)</option>
                  @for (entry of availableBuilds(); track entry.build_id) {
                    <option [value]="entry.build_id">
                      {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
                    </option>
                  }
                </select>
              </label>
            }

            @if (memberError()) {
              <p class="text-xs font-semibold text-[var(--color-danger)]" aria-live="polite">
                {{ memberError() }}
              </p>
            }

            <div class="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
              <button type="button" class="btn btn--ghost btn--sm" (click)="closeMemberForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="memberSaving()">
                {{ t('common.confirm') }}
              </button>
            </div>
          }
        </form>
      </app-dialog>
    }

    <!-- 6. SEARCH DIALOGS -->
    @if (showMemberSearch()) {
      <app-search-dialog
        title="Add a Member"
        [options]="memberSearchOptions()"
        [loading]="memberSearchLoading()"
        [showDateFilters]="false"
        (filterChange)="onMemberSearchFilter($event)"
        (select)="onMemberSelected($event)"
        (close)="closeMemberSearch()"
      />
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

    <!-- 7. CONFIRMATION DIALOG -->
    @if (visiblePendingConfirm(); as confirm) {
      <app-dialog [title]="confirmTitle(confirm)" size="sm" (closed)="cancelConfirm()">
        <p class="text-sm text-[var(--color-text)]">{{ confirmMessage(confirm) }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost btn--sm" (click)="cancelConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger btn--sm" (click)="runConfirm()">
            {{ confirmActionLabel(confirm) }}
          </button>
        </div>
      </app-dialog>
    }

    <!-- 8. SEAT DETAILS & ABILITIES DIALOG (on item click) -->
    @if (inspectDialogSeat(); as seat) {
      <app-dialog
        [title]="seat.build_name"
        [subtitle]="
          'Party ' +
          seat.party_number +
          ' · Pos. #' +
          seat.position +
          ' · ' +
          rosterSeatRoleLabel(seat) +
          (seat.participant ? ' (' + seat.participant.username + ')' : ' (Libero)')
        "
        size="lg"
        (closed)="inspectDialogSeat.set(null)"
      >
        <div class="space-y-4">
          <!-- Role & Player info banner -->
          <div
            class="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]"
          >
            <div class="flex items-center gap-3">
              <span class="font-mono text-2xl font-black" [class]="roleGlyphColor(seat.role)">
                {{ roleGlyph(seat.role) }}
              </span>
              <div>
                <div class="flex items-center gap-2">
                  <span class="chip font-bold text-xs" [class]="roleChip(seat.role)">
                    {{ rosterSeatRoleLabel(seat) }}
                  </span>
                  <span class="text-sm font-bold text-white">{{ seat.build_name }}</span>
                  <span class="text-xs font-mono text-[var(--color-text-secondary)]"
                    >#{{ seat.position }}</span
                  >
                </div>
                @if (seat.participant; as p) {
                  <div
                    class="flex items-center gap-1.5 mt-1 text-xs text-[var(--color-text-secondary)]"
                  >
                    <app-avatar [username]="p.username" size="xs" />
                    <span
                      >Assegnato a: <strong class="text-white">{{ p.username }}</strong></span
                    >
                  </div>
                } @else {
                  <span class="text-xs text-[var(--color-text-tertiary)] italic">Posto libero</span>
                }
              </div>
            </div>

            @if (rosterSeatBuildItems(seat).some((i) => i.loadout === 'swap')) {
              <div
                class="flex items-center gap-1 p-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-md font-medium transition-all"
                  [class.bg-white/10]="dialogLoadout() === 'main'"
                  [class.text-white]="dialogLoadout() === 'main'"
                  [class.text-[var(--color-text-secondary)]]="dialogLoadout() !== 'main'"
                  (click)="dialogLoadout.set('main')"
                >
                  Main Set
                </button>
                <button
                  type="button"
                  class="px-2.5 py-1 text-xs rounded-md font-medium transition-all"
                  [class.bg-white/10]="dialogLoadout() === 'swap'"
                  [class.text-white]="dialogLoadout() === 'swap'"
                  [class.text-[var(--color-text-secondary)]]="dialogLoadout() !== 'swap'"
                  (click)="dialogLoadout.set('swap')"
                >
                  Swap Set
                </button>
              </div>
            }
          </div>

          <!-- Equipment Paper Doll & Abilità Grid -->
          <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
            <div class="md:col-span-6">
              <div
                class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
              >
                <p
                  class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3"
                >
                  Equipaggiamento {{ dialogLoadout() === 'main' ? 'Principale' : 'di Swap' }}
                </p>
                <app-equipment-grid [items]="dialogItems(seat)" />
              </div>
            </div>

            <div class="md:col-span-6 space-y-3">
              <p
                class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]"
              >
                Abilità & Passive Selezionate
              </p>

              @let rows = dialogAbilityRows(seat);
              @if (rows.length > 0) {
                <div class="space-y-2 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">
                  @for (row of rows; track row.slot) {
                    <div
                      class="p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)] space-y-2"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-xs font-bold text-white">{{ row.itemName }}</span>
                        <span class="chip chip--neutral font-mono text-[10px] uppercase">{{
                          row.slot
                        }}</span>
                      </div>

                      <div class="grid gap-1.5">
                        @for (slot of row.slots; track slot.label + slot.index) {
                          @let chosen = selectedChoiceInSlot(slot);
                          @if (chosen) {
                            <div
                              class="flex items-center gap-2.5 rounded-lg bg-[var(--color-surface)] px-2.5 py-1.5 border border-white/5"
                            >
                              <span
                                class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-white/10 text-white min-w-6 text-center"
                              >
                                {{ slot.label }}
                              </span>
                              <img
                                [src]="iconUrlForSpell(chosen.id)"
                                [alt]="chosen.name"
                                class="h-6 w-6 rounded object-contain border border-white/10 bg-black/40"
                                loading="lazy"
                              />
                              <div class="min-w-0 flex-1">
                                <p class="text-xs font-semibold text-white truncate">
                                  {{ chosen.name }}
                                </p>
                              </div>
                            </div>
                          }
                        }
                      </div>
                    </div>
                  }
                </div>
              } @else {
                <p
                  class="text-xs text-[var(--color-text-secondary)] p-4 rounded-lg bg-[var(--color-surface-2)] text-center"
                >
                  Nessuna abilità configurata per questa selezione.
                </p>
              }
            </div>
          </div>
        </div>

        <div dialogFooter>
          <button
            type="button"
            class="btn btn--outline btn--sm"
            (click)="inspectDialogSeat.set(null)"
          >
            Chiudi
          </button>
        </div>
      </app-dialog>
    }

    <!-- 9. FLOATING WEAPON SPELLS TOOLTIP (on hover) -->
    @if (activeWeaponTooltip(); as tip) {
      <div
        class="fixed z-50 pointer-events-none rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-3 shadow-2xl backdrop-blur-md max-w-xs transition-opacity duration-150"
        [style.left.px]="tip.x"
        [style.top.px]="tip.y"
      >
        <div class="flex items-center gap-2.5 pb-2 mb-2 border-b border-white/10">
          @if (tip.icon) {
            <img
              [src]="tip.icon"
              [alt]="tip.name"
              class="h-8 w-8 object-contain rounded-md border border-white/10 bg-white/5 p-0.5"
            />
          }
          <div class="min-w-0 flex-1">
            <p class="text-xs font-bold text-white truncate">{{ tip.name }}</p>
            @if (tip.tier) {
              <span class="text-[10px] font-mono text-[var(--color-primary)] font-semibold">{{
                tip.tier
              }}</span>
            }
          </div>
        </div>

        @if (tip.spells.length > 0) {
          <div class="space-y-1.5">
            <p
              class="text-[9px] uppercase font-bold tracking-wider text-[var(--color-text-tertiary)]"
            >
              Abilità selezionate
            </p>
            @for (spell of tip.spells; track spell.key + spell.name) {
              <div
                class="flex items-center gap-2 rounded-md bg-white/5 px-2 py-1 border border-white/5"
              >
                <span
                  class="font-mono text-[10px] font-bold px-1.5 py-0.2 rounded bg-white/10 text-white min-w-5 text-center"
                >
                  {{ spell.key }}
                </span>
                @if (spell.iconUrl) {
                  <img
                    [src]="spell.iconUrl"
                    [alt]="spell.name"
                    class="h-5 w-5 rounded object-contain"
                  />
                }
                <span class="text-xs text-white font-medium truncate">{{ spell.name }}</span>
              </div>
            }
          </div>
        } @else {
          <p class="text-xs text-[var(--color-text-secondary)] italic">
            Nessuna abilità per questa selezione
          </p>
        }
      </div>
    }
  `,
  styles: `
    @layer components {
      .event-detail__label {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        font-size: 0.6875rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .event-detail__value {
        color: var(--color-text);
        font-family: var(--font-geistmono, monospace);
        font-size: clamp(1.25rem, 2vw, 1.5rem);
        font-weight: 600;
        letter-spacing: -0.02em;
      }
      .event-detail__value-sm {
        color: var(--color-text);
        font-family: var(--font-geistmono, monospace);
        font-size: 1rem;
        font-weight: 600;
      }
      .event-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .event-detail__section-header {
        align-items: center;
        border-bottom: 1px solid var(--color-border);
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: space-between;
        padding: 0.875rem 1.25rem;
      }
      .event-detail__empty {
        color: var(--color-text-secondary);
        font-size: 0.8125rem;
        padding: 1.5rem;
      }
      .event-detail__fill-bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.375rem;
        overflow: hidden;
      }
      .event-detail__fill-bar span {
        background: var(--color-warning);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
        transition: width 0.2s ease;
      }
      .event-detail__party-tab--active {
        border-bottom-color: var(--color-primary);
        color: var(--color-text);
      }
      .event-detail__roster-live {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin: 0;
        min-height: 1.125rem;
      }
      .event-detail__assignment-summary {
        align-items: flex-end;
        color: var(--color-text-secondary);
        display: flex;
        flex-direction: column;
        font-size: 0.8125rem;
        gap: 0.125rem;
        text-align: end;
      }
      .event-detail__assignment-summary strong {
        color: var(--color-text);
        font-size: 0.9375rem;
        font-weight: 600;
      }
      .event-detail__roster-seat {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 0.75rem 1rem;
      }
      @media (prefers-reduced-motion: reduce) {
        .event-detail__fill-bar span {
          transition: none;
        }
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
  private readonly realtimeRoster = inject(RealtimeRosterService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly albionAbilities = inject(AlbionAbilitiesService);
  private readonly destroyRef = inject(DestroyRef);
  private eventId = 0;
  /**
   * Bumped on every `load()` call (route navigation or explicit refresh) so a
   * response from a superseded load can detect it's stale and discard itself
   * instead of overwriting newer state or rebinding the roster socket to the
   * wrong event.
   */
  private loadGeneration = 0;
  /**
   * Generation of the load that currently owns the full-page spinner. Only a non-silent load
   * raises `loading`, so only a newer non-silent load may leave it raised on its behalf.
   */
  private loadingGeneration = 0;

  protected readonly event = signal<EventDetailView | null>(null);
  protected readonly eventLossEstimate = signal<BattleLossEstimate>(emptyLossEstimate());
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly canEdit = computed(() => this.auth.hasPermission('events.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('events.delete'));
  protected readonly showEditForm = signal(false);
  protected readonly tab = signal<EventDetailTab>('roster');
  protected readonly pendingConfirm = signal<PendingConfirm | null>(null);
  protected readonly saving = signal(false);

  // Live timer tick for countdown
  protected readonly currentTime = signal<number>(Date.now());

  // Roster Builder Interactive Signals
  protected readonly rosterView = signal<'parties' | 'roles' | 'table'>('parties');
  protected readonly benchFilter = signal<'all' | 'unassigned'>('all');
  protected readonly benchSearch = signal('');
  protected readonly swapSourceSlot = signal<CompSlotRow | null>(null);
  protected readonly quickAssignSlot = signal<CompSlotRow | null>(null);
  protected readonly autoFilling = signal(false);
  protected readonly dragOverSlotKey = signal<string | null>(null);
  protected readonly draggedMember = signal<EventParticipant | null>(null);
  protected readonly draggedSeat = signal<EventRosterSeat | null>(null);
  protected readonly draggedBenchMember = signal<EventParticipant | null>(null);
  protected readonly dropTargetSeatKey = signal<string | null>(null);
  protected readonly isDropTargetBench = signal(false);
  protected readonly specializationCatalog = signal<OpenAlbionItem[]>([]);
  protected readonly selectedSpecializationKey = signal('');
  /** The bundled ability catalog, loaded once and keyed by tier-stripped base identifier. */
  protected readonly abilityCatalog = signal<Record<string, OpenAlbionItemAbilities>>({});

  protected readonly selectedSpecializationName = computed(() => {
    const key = this.selectedSpecializationKey();
    const item = this.specializationCatalog().find(
      (entry) => this.specializationKey(entry) === key,
    );
    return item ? normalizeAlbionEquipmentName(item.identifier ?? '', item.name) : 'Nessuna';
  });

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => {
    const detail = this.event();
    const rosterCount = detail?.participants.length ?? 0;
    const battlesCount = detail?.battles.length ?? 0;
    const splitsCount = detail?.splits.length ?? 0;
    return [
      { id: 'roster', label: `${this.t('events.tab.roster')} (${rosterCount})` },
      { id: 'overview', label: this.t('events.tab.overview') },
      { id: 'battles', label: `${this.t('events.tab.battles')} (${battlesCount})` },
      { id: 'splits', label: `${this.t('events.tab.splits')} (${splitsCount})` },
    ];
  });

  protected readonly showBattleLinkForm = signal(false);
  protected readonly showCompSearch = signal(false);
  protected readonly compSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly compSearchLoading = signal(false);
  protected readonly draftCompTitle = signal('');

  protected readonly showBattleSearch = signal(false);
  protected readonly battleSearchRaw = signal<SearchDialogOption[]>([]);
  protected readonly battleSearchTerm = signal('');
  protected readonly battleSearchOptions = computed<SearchDialogOption[]>(() => {
    const term = this.battleSearchTerm().trim().toLowerCase();
    const items = this.battleSearchRaw();
    if (!term) return items;
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
  protected readonly totalSplitValue = computed(() =>
    (this.event()?.splits ?? []).reduce(
      (sum, s) => sum + Number(s.net_value ?? s.estimated_market_value),
      0,
    ),
  );

  protected readonly eventBalance = computed(() => {
    const detail = this.event();
    if (!detail) return { netBalance: 0, totalLoot: 0, totalLoss: 0, isProfitable: true };
    const totalLoot = Number(detail.split_stats?.completed_net_value ?? 0);
    const totalLoss = Number(this.eventLossEstimate()?.total_estimated_loss ?? 0);
    const netBalance = totalLoot - totalLoss;
    return {
      netBalance,
      totalLoot,
      totalLoss,
      isProfitable: netBalance >= 0,
    };
  });

  protected readonly showSplitSearch = signal(false);
  protected readonly splitSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly splitSearchLoading = signal(false);
  protected readonly draftTitle = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCompId = signal('');
  protected readonly draftCallToArms = signal(false);
  protected readonly draftRegear = signal(false);
  protected readonly draftEventDate = signal('');
  protected readonly draftMassTime = signal('19:30');
  protected readonly draftStartTime = signal('20:00');

  protected readonly showJoinForm = signal(false);
  protected readonly showJoinConfirm = signal(false);
  protected readonly joinFormLoading = signal(false);
  protected readonly compLoading = signal(false);
  protected readonly joinSubmitting = signal(false);
  protected readonly joinError = signal<string | null>(null);
  protected readonly availableBuilds = signal<CompBuildEntry[]>([]);
  protected readonly allBuilds = signal<BuildSummary[]>([]);
  protected readonly rosterRoleManagerOpen = signal(false);
  protected readonly rosterRoleSaving = signal(false);
  protected readonly rosterRoleError = signal<string | null>(null);
  protected readonly draftRosterRoleBuildId = signal('');
  protected readonly draftPrimaryBuildId = signal('');
  protected readonly draftSecondaryBuildId = signal('');
  /** Sentinel `<option>` value standing for the virtual, build-less Fill role. */
  protected readonly fillValue = FILL_BUILD_VALUE;
  protected readonly isFillSelected = computed(
    () => this.draftPrimaryBuildId() === FILL_BUILD_VALUE,
  );
  protected readonly selectedJoinBuild = computed<CompBuildEntry | null>(() => {
    const buildId = Number(this.draftPrimaryBuildId());
    return buildId > 0 ? (this.buildIndex().get(buildId) ?? null) : null;
  });
  protected readonly selectedJoinWeapon = computed<BuildItemSlot | null>(() => {
    const buildId = this.selectedJoinBuild()?.build_id;
    return buildId ? (this.buildWeaponByBuildId().get(buildId) ?? null) : null;
  });
  protected readonly selectedJoinSecondaryBuild = computed<CompBuildEntry | null>(() => {
    const buildId = Number(this.draftSecondaryBuildId());
    return buildId > 0 ? (this.buildIndex().get(buildId) ?? null) : null;
  });

  protected readonly canManageParticipants = computed(() => {
    const detail = this.event();
    const userId = this.auth.profile()?.user_id ?? null;
    if (userId === null) return false;
    return this.canEdit() || detail?.created_by === userId;
  });

  protected readonly showMemberSearch = signal(false);
  protected readonly memberSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly memberSearchLoading = signal(false);
  protected readonly draftMember = signal<SearchDialogOption | null>(null);
  private readonly assignBuildsPanel = viewChild<ElementRef<HTMLElement>>('assignBuildsPanel');
  private previouslyFocusedMemberTrigger: HTMLElement | null = null;
  protected readonly draftMemberPrimaryBuildId = signal('');
  protected readonly draftMemberSecondaryBuildId = signal('');
  protected readonly memberSaving = signal(false);
  protected readonly memberError = signal<string | null>(null);

  protected readonly rosterSnapshot = signal<EventRosterView | null>(null);
  protected readonly rosterSnapshotState = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly rosterSnapshotError = signal('');
  protected readonly rosterAnnouncement = signal('');
  protected readonly selectedRosterPartyNumber = signal(1);
  protected readonly rosterCommandSaving = signal(false);
  protected readonly rosterSwapSource = signal<EventRosterSeat | null>(null);
  protected readonly rosterAssignTarget = signal<EventRosterSeat | null>(null);
  /** Total paper-doll slots, for the "n/10 slot" counter on the own-seat equipment card. */
  protected readonly SLOT_COUNT = SLOT_ORDER.length;
  protected readonly activeLegacyQuickAssignSlot = computed(() =>
    this.rosterSnapshot() === null ? this.quickAssignSlot() : null,
  );
  protected readonly visiblePendingConfirm = computed(() => {
    const confirm = this.pendingConfirm();
    return this.rosterSnapshot() !== null && this.isLegacyRosterConfirm(confirm) ? null : confirm;
  });

  protected readonly slotAssignments = signal<Map<string, number | null>>(new Map());
  protected readonly slotSavingKey = signal<string | null>(null);
  protected readonly slotRemovingKey = signal<string | null>(null);
  protected readonly buildDetails = signal<Map<number, BuildDetail>>(new Map());
  protected readonly hoveredSlotKey = signal<string | null>(null);
  protected readonly pinnedSlotKey = signal<string | null>(null);

  protected readonly buildWeaponByBuildId = computed<Map<number, BuildItemSlot>>(() => {
    const map = new Map<number, BuildItemSlot>();
    for (const [buildId, detail] of this.buildDetails()) {
      const weapon =
        detail.items.find((item) => item.slot === 'weapon' && item.loadout === 'main') ??
        detail.items.find((item) => item.slot === 'weapon');
      if (weapon) {
        map.set(buildId, weapon);
      }
    }
    return map;
  });

  private readonly pendingAddSlotBuildId = signal<number | null>(null);

  protected readonly currentParticipant = computed<EventParticipant | null>(() => {
    const detail = this.event();
    const userId = this.auth.profile()?.user_id ?? null;
    if (!detail || userId === null) return null;
    return detail.participants.find((participant) => participant.user_id === userId) ?? null;
  });

  protected readonly rosterParties = computed<readonly EventRosterParty[]>(() => {
    const grouped = new Map<number, EventRosterSeat[]>();
    for (const seat of this.rosterSnapshot()?.seats ?? []) {
      const seats = grouped.get(seat.party_number);
      if (seats) {
        seats.push(seat);
      } else {
        grouped.set(seat.party_number, [seat]);
      }
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .map(([partyNumber, seats]) => ({
        partyNumber,
        seats: [...seats].sort((left, right) => {
          const leftRole = ROSTER_ROLE_ORDER.indexOf(left.role);
          const rightRole = ROSTER_ROLE_ORDER.indexOf(right.role);
          return (
            (leftRole === -1 ? ROSTER_ROLE_ORDER.length : leftRole) -
              (rightRole === -1 ? ROSTER_ROLE_ORDER.length : rightRole) ||
            left.position - right.position
          );
        }),
      }));
  });

  protected readonly activeRosterParty = computed<EventRosterParty | null>(() => {
    const parties = this.rosterParties();
    return (
      parties.find((party) => party.partyNumber === this.selectedRosterPartyNumber()) ??
      parties[0] ??
      null
    );
  });

  protected readonly ownRosterSeat = computed<EventRosterSeat | null>(() => {
    const userId = this.auth.profile()?.user_id ?? null;
    if (userId === null) return null;
    return (
      this.rosterSnapshot()?.seats.find((seat) => seat.participant?.user_id === userId) ?? null
    );
  });

  protected readonly isCurrentUserOnRosterBench = computed(() => {
    const userId = this.auth.profile()?.user_id ?? null;
    return (
      userId !== null && this.rosterSnapshot()?.bench.some((member) => member.user_id === userId)
    );
  });

  /**
   * The current member's own seat, rendered with the build page's paper doll and ability deck.
   *
   * Splitting by loadout here (rather than in the template) keeps the two grids independent, so the
   * swap panel only appears for builds that actually carry a swap set.
   */
  protected readonly ownSeatMainItems = computed(() => this.ownSeatItems('main'));
  protected readonly ownSeatSwapItems = computed(() => this.ownSeatItems('swap'));
  protected readonly ownSeatAbilityRows = computed(() =>
    this.abilityRowsFor(this.ownSeatMainItems()),
  );
  protected readonly ownSeatSwapAbilityRows = computed(() =>
    this.abilityRowsFor(this.ownSeatSwapItems()),
  );

  /** The seat selected for inspection in the compact right sidebar */
  protected readonly selectedInspectSeat = signal<EventRosterSeat | null>(null);

  /** Active seat shown in the right sidebar (selected, or user's own seat, or first seat) */
  protected readonly activeInspectSeat = computed<EventRosterSeat | null>(() => {
    return (
      this.selectedInspectSeat() ??
      this.ownRosterSeat() ??
      this.rosterParties()[0]?.seats[0] ??
      null
    );
  });

  protected readonly inspectLoadout = signal<'main' | 'swap'>('main');

  protected readonly activeInspectItems = computed<BuildItemSlot[]>(() => {
    const seat = this.activeInspectSeat();
    if (!seat) return [];
    return this.rosterSeatBuildItems(seat).filter(
      (item) => (item.loadout ?? 'main') === this.inspectLoadout(),
    );
  });

  protected readonly activeInspectAbilityRows = computed(() => {
    return this.abilityRowsFor(this.activeInspectItems());
  });

  /** Seat inspected in the full modal dialog */
  protected readonly inspectDialogSeat = signal<EventRosterSeat | null>(null);
  protected readonly dialogLoadout = signal<'main' | 'swap'>('main');

  /** Tooltip showing weapon and selected spells on hover */
  protected readonly activeWeaponTooltip = signal<{
    name: string;
    tier?: string;
    icon?: string;
    role?: string;
    buildName: string;
    spells: { key: string; name: string; iconUrl: string }[];
    x: number;
    y: number;
  } | null>(null);

  protected readonly filteredRosterBench = computed<readonly EventParticipant[]>(() => {
    const bench = this.rosterSnapshot()?.bench ?? [];
    const query = this.benchSearch().trim().toLowerCase();
    if (!query) return bench;
    return bench.filter(
      (m) =>
        m.username.toLowerCase().includes(query) ||
        (m.primary_build_name?.toLowerCase().includes(query) ?? false) ||
        (m.secondary_build_name?.toLowerCase().includes(query) ?? false),
    );
  });

  protected readonly extraRosterRoles = computed<readonly EventRosterRole[]>(() =>
    (this.event()?.roster_roles ?? []).filter((role) => !role.is_fill),
  );

  protected readonly availableExtraRoleBuilds = computed<readonly BuildSummary[]>(() => {
    const unavailable = new Set([
      ...this.availableBuilds().map((entry) => entry.build_id),
      ...this.extraRosterRoles().flatMap((role) => (role.build_id === null ? [] : [role.build_id])),
    ]);
    return this.allBuilds().filter((build) => !unavailable.has(build.id));
  });

  protected readonly buildIndex = computed<Map<number, CompBuildEntry>>(() => {
    const map = new Map<number, CompBuildEntry>();
    for (const entry of this.availableBuilds()) {
      map.set(entry.build_id, entry);
    }
    return map;
  });

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

  protected readonly compParties = computed<CompPartyGroup[]>(() => {
    const slots = this.compSlots();
    if (slots.length === 0) return [];

    const parties: CompPartyGroup[] = [];
    const partySize = 20;
    const numParties = Math.ceil(slots.length / partySize);

    for (let p = 0; p < numParties; p++) {
      const partySlots = slots.slice(p * partySize, (p + 1) * partySize);
      let filled = 0;
      for (const slot of partySlots) {
        if (this.slotAssignment(slot) !== null) {
          filled++;
        }
      }
      parties.push({
        partyNumber: p + 1,
        partyName: this.t('events.detail.party_num').replace('{number}', String(p + 1)),
        slots: partySlots,
        filledCount: filled,
        totalCount: partySlots.length,
      });
    }

    return parties;
  });

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

  protected readonly initialSlotAssignments = computed<Map<string, number | null>>(() => {
    const slots = this.compSlots();
    const detail = this.event();
    const assignments = new Map<string, number | null>();
    if (slots.length === 0 || !detail) return assignments;

    const byBuild = new Map<number, EventParticipant[]>();
    for (const participant of detail.participants) {
      const buildId = participant.primary_build_id;
      if (buildId === null) {
        continue;
      }
      const bucket = byBuild.get(buildId);
      if (bucket) {
        bucket.push(participant);
      } else {
        byBuild.set(buildId, [participant]);
      }
    }
    for (const slot of slots) {
      const bucket = byBuild.get(slot.buildId);
      const next = bucket?.shift();
      assignments.set(slot.key, next ? next.user_id : null);
    }
    return assignments;
  });

  protected readonly resolvedAssignments = computed<Map<string, number | null>>(() => {
    const merged = new Map<string, number | null>(this.initialSlotAssignments());
    for (const [key, value] of this.slotAssignments()) {
      merged.set(key, value);
    }
    return merged;
  });

  protected readonly filledSlotsCount = computed(() => {
    let count = 0;
    for (const value of this.resolvedAssignments().values()) {
      if (value !== null) count++;
    }
    return count;
  });

  protected readonly unassignedParticipants = computed<EventParticipant[]>(() => {
    const detail = this.event();
    if (!detail) return [];
    const assigned = new Set<number>();
    for (const value of this.resolvedAssignments().values()) {
      if (value !== null) assigned.add(value);
    }
    return detail.participants.filter((participant) => !assigned.has(participant.user_id));
  });

  protected readonly filteredBenchParticipants = computed<EventParticipant[]>(() => {
    const detail = this.event();
    if (!detail) return [];
    const filter = this.benchFilter();
    if (filter === 'unassigned') {
      return this.unassignedParticipants();
    }
    return detail.participants;
  });

  protected readonly countdownText = computed(() => {
    const detail = this.event();
    if (!detail) return '';
    this.currentTime(); // subscribe to tick
    if (detail.status === 'live') {
      return this.t('events.detail.countdown_live');
    }
    if (
      detail.status === 'stopped' ||
      detail.status === 'auto_stopped' ||
      detail.status === 'cancelled'
    ) {
      return this.t('events.detail.countdown_ended');
    }
    const diffMs = new Date(detail.event_date_utc).getTime() - Date.now();
    if (diffMs <= 0) {
      return 'Starting now';
    }
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((diffMs % (1000 * 60)) / 1000);
    const timeStr = days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m ${secs}s`;
    return this.t('events.detail.countdown_starts_in').replace('{time}', timeStr);
  });

  // Opponents table columns
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

  // Splits table columns
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

  // Battles table columns
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

  // Participants table columns
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
      key: 'specialization_level',
      label: 'events.detail.specialization',
      sortable: true,
      accessor: (participant) => this.participantSpecLevel(participant),
      comparator: (a, b) => this.participantSpecLevel(a) - this.participantSpecLevel(b),
      align: 'right',
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

  protected specializationKey(item: OpenAlbionItem): string {
    return albionSpecializationKey(item);
  }

  protected participantSpecLevel(participant: EventParticipant): number {
    return participant.specializations?.[this.selectedSpecializationKey()] ?? 0;
  }

  protected selectSpecialization(event: Event): void {
    this.selectedSpecializationKey.set((event.target as HTMLSelectElement).value);
  }

  protected onBenchSearchInput(event: Event): void {
    this.benchSearch.set((event.target as HTMLInputElement).value);
  }

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    this.route.paramMap.subscribe((params) => {
      const id = params.get('eventId');
      if (id) {
        this.realtimeRoster.close();
        this.rosterSnapshot.set(null);
        this.rosterSnapshotState.set('loading');
        this.rosterSnapshotError.set('');
        this.clearLegacyRosterInteractionState();
        this.rosterSwapSource.set(null);
        this.rosterAssignTarget.set(null);
        this.eventId = Number(id);
        this.showEditForm.set(false);
        this.showJoinForm.set(false);
        this.tab.set('roster');
        this.pendingConfirm.set(null);
        void this.load();
      }
    });

    const timer = setInterval(() => {
      this.currentTime.set(Date.now());
    }, 1000);

    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.realtimeRoster.close();
    });

    this.realtimeRoster.messages.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((message) => {
      const snapshot = this.rosterSnapshot();
      if (
        message.event_id !== this.eventId ||
        (snapshot !== null && message.roster_version < snapshot.roster_version)
      ) {
        return;
      }
      // The socket invalidates the complete event state, not only the seat snapshot:
      // signups, manager assignments, and role availability must stay synchronized.
      // `silent` keeps the current view mounted instead of flashing the full-page
      // loading state, so the update lands in real time rather than as a page refresh.
      void this.load(true);
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

  protected openRosterRoleManager(): void {
    this.rosterRoleError.set(null);
    this.draftRosterRoleBuildId.set('');
    this.rosterRoleManagerOpen.set(true);
    void this.loadAllBuilds();
  }

  protected closeRosterRoleManager(): void {
    this.rosterRoleManagerOpen.set(false);
    this.rosterRoleError.set(null);
  }

  protected onDraftRosterRoleBuildChange(event: Event): void {
    this.draftRosterRoleBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected async addRosterRole(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const buildId = Number(this.draftRosterRoleBuildId());
    if (!Number.isInteger(buildId) || buildId <= 0) return;

    this.rosterRoleSaving.set(true);
    this.rosterRoleError.set(null);
    try {
      await firstValueFrom(
        this.api.post(`api/events/${this.eventId}/roster-roles`, { build_id: buildId }),
      );
      this.draftRosterRoleBuildId.set('');
      // Silent: adding a role reshapes the seats, but the page must not blink back to the top.
      await this.load(true);
      this.toasts.success('Ruolo extra aggiunto al roster.');
    } catch (error) {
      this.rosterRoleError.set(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.rosterRoleSaving.set(false);
    }
  }

  protected async removeRosterRole(role: EventRosterRole): Promise<void> {
    if (role.id === null) return;
    this.rosterRoleSaving.set(true);
    this.rosterRoleError.set(null);
    try {
      await firstValueFrom(this.api.delete(`api/events/${this.eventId}/roster-roles/${role.id}`));
      await this.load(true);
      this.toasts.success('Ruolo extra rimosso dal roster.');
    } catch (error) {
      this.rosterRoleError.set(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.rosterRoleSaving.set(false);
    }
  }

  protected rosterPartyName(party: EventRosterParty): string {
    return `Party ${party.partyNumber}`;
  }

  protected selectRosterParty(partyNumber: number): void {
    this.selectedRosterPartyNumber.set(partyNumber);
  }

  protected onRosterPartyKeydown(event: Event, partyNumber: number): void {
    if (
      event instanceof KeyboardEvent &&
      (event.key === 'ArrowRight' || event.key === 'ArrowLeft')
    ) {
      event.preventDefault();
      const parties = this.rosterParties();
      const currentIndex = parties.findIndex((party) => party.partyNumber === partyNumber);
      if (currentIndex === -1) return;
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const next = parties[(currentIndex + offset + parties.length) % parties.length];
      this.selectRosterParty(next.partyNumber);
      (event.currentTarget as HTMLElement).parentElement
        ?.querySelector<HTMLElement>(`[aria-controls="event-party-panel-${next.partyNumber}"]`)
        ?.focus();
    }
  }

  protected rosterSeatPartyNumber(seat: EventRosterSeat): number {
    return seat.party_number;
  }

  protected rosterSeatPosition(seat: EventRosterSeat): number {
    return seat.position;
  }

  protected rosterSeatRoleLabel(seat: EventRosterSeat): string {
    return ROLE_ORDER.includes(seat.role as BuildRole)
      ? this.roleLabelName(seat.role as BuildRole)
      : seat.role;
  }

  protected rosterSeatBuildName(seat: EventRosterSeat): string {
    return seat.build_name;
  }

  protected rosterSeatBuildVersion(seat: EventRosterSeat): number {
    return seat.build_version;
  }

  protected rosterSeatBuildItems(seat: EventRosterSeat): BuildItemSlot[] {
    return this.slotTooltipItems(seat.build_id);
  }

  protected rosterSeatCount(): number {
    return this.rosterSnapshot()?.seats.length ?? 0;
  }

  protected rosterFilledSeats(): number {
    return (this.rosterSnapshot()?.seats ?? []).filter((seat) => seat.participant !== null).length;
  }

  protected rosterPartyFilledSeats(party: EventRosterParty): number {
    return party.seats.filter((seat) => seat.participant !== null).length;
  }

  protected rosterSeatKey(seat: EventRosterSeat): string {
    return seat.key;
  }

  protected beginRosterSwap(seat: EventRosterSeat): void {
    if (seat.participant === null) return;
    this.rosterAssignTarget.set(null);
    this.rosterSwapSource.set(seat);
  }

  protected selectRosterAssignTarget(seat: EventRosterSeat): void {
    if (seat.participant !== null) return;
    this.rosterSwapSource.set(null);
    this.rosterAssignTarget.set(seat);
  }

  protected cancelRosterCommandMode(): void {
    this.rosterSwapSource.set(null);
    this.rosterAssignTarget.set(null);
  }

  private isLegacyRosterConfirm(confirm: PendingConfirm | null): boolean {
    return confirm?.kind === 'clear-all' || confirm?.kind === 'remove-participant';
  }

  private clearLegacyRosterInteractionState(): void {
    this.quickAssignSlot.set(null);
    this.swapSourceSlot.set(null);
    this.dragOverSlotKey.set(null);
    this.draggedMember.set(null);
    this.pendingAddSlotBuildId.set(null);
    this.showMemberSearch.set(false);
    this.closeMemberForm();
    if (this.isLegacyRosterConfirm(this.pendingConfirm())) {
      this.pendingConfirm.set(null);
    }
  }

  protected async assignBenchMemberToServerSeat(userId: number): Promise<void> {
    const target = this.rosterAssignTarget();
    const roster = this.rosterSnapshot();
    if (!target || !roster) return;

    await this.runServerRosterCommand('Membro assegnato al posto.', () =>
      firstValueFrom(
        this.api.put<EventRosterView>(
          `api/events/${this.eventId}/roster/seats/${encodeURIComponent(target.key)}`,
          { user_id: userId, expected_roster_version: roster.roster_version },
        ),
      ),
    );
  }

  protected async clearServerRosterSeat(seat: EventRosterSeat): Promise<void> {
    const roster = this.rosterSnapshot();
    const key = this.rosterSeatKey(seat);
    if (!roster) return;

    await this.runServerRosterCommand('Posto liberato.', () =>
      firstValueFrom(
        this.api.delete<EventRosterView>(
          `api/events/${this.eventId}/roster/seats/${encodeURIComponent(key)}`,
          { expected_roster_version: roster.roster_version },
        ),
      ),
    );
  }

  protected async swapServerRosterSeats(target: EventRosterSeat): Promise<void> {
    const source = this.rosterSwapSource();
    const roster = this.rosterSnapshot();
    const targetKey = this.rosterSeatKey(target);
    if (!source || !roster || source.key === targetKey) return;

    await this.runServerRosterCommand('Posti scambiati.', () =>
      firstValueFrom(
        this.api.post<EventRosterView>(`api/events/${this.eventId}/roster/swaps`, {
          source_seat_key: source.key,
          target_seat_key: targetKey,
          expected_roster_version: roster.roster_version,
        }),
      ),
    );
  }

  protected onSeatDragStart(event: DragEvent, seat: EventRosterSeat): void {
    if (!this.canManageParticipants() || !seat.participant || this.rosterCommandSaving()) return;
    this.draggedSeat.set(seat);
    this.draggedBenchMember.set(null);
    this.dropTargetSeatKey.set(null);
    this.isDropTargetBench.set(false);
    if (event.dataTransfer) {
      event.dataTransfer.setData(
        'text/plain',
        JSON.stringify({ type: 'seat', key: this.rosterSeatKey(seat) }),
      );
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  protected onSeatDragOver(event: DragEvent, seat: EventRosterSeat): void {
    if (!this.canManageParticipants() || this.rosterCommandSaving()) return;
    const isDraggingSeat = this.draggedSeat() !== null;
    const isDraggingBench = this.draggedBenchMember() !== null;
    if (!isDraggingSeat && !isDraggingBench) return;

    const seatKey = this.rosterSeatKey(seat);
    if (isDraggingSeat && this.rosterSeatKey(this.draggedSeat()!) === seatKey) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (this.dropTargetSeatKey() !== seatKey) {
      this.dropTargetSeatKey.set(seatKey);
    }
  }

  protected onSeatDragLeave(event: DragEvent, seat: EventRosterSeat): void {
    const seatKey = this.rosterSeatKey(seat);
    if (this.dropTargetSeatKey() === seatKey) {
      this.dropTargetSeatKey.set(null);
    }
  }

  protected async onSeatDrop(event: DragEvent, targetSeat: EventRosterSeat): Promise<void> {
    event.preventDefault();
    this.dropTargetSeatKey.set(null);
    const sourceSeat = this.draggedSeat();
    const benchMember = this.draggedBenchMember();
    this.draggedSeat.set(null);
    this.draggedBenchMember.set(null);
    this.isDropTargetBench.set(false);

    if (!this.canManageParticipants() || this.rosterCommandSaving()) return;

    if (sourceSeat) {
      const sourceKey = this.rosterSeatKey(sourceSeat);
      const targetKey = this.rosterSeatKey(targetSeat);
      if (sourceKey === targetKey) return;
      await this.performSeatSwap(sourceSeat, targetSeat);
    } else if (benchMember) {
      await this.assignBenchMemberToSeatDirect(benchMember.user_id, targetSeat);
    }
  }

  protected onBenchMemberDragStart(event: DragEvent, member: EventParticipant): void {
    if (!this.canManageParticipants() || this.rosterCommandSaving()) return;
    this.draggedBenchMember.set(member);
    this.draggedSeat.set(null);
    this.dropTargetSeatKey.set(null);
    this.isDropTargetBench.set(false);
    if (event.dataTransfer) {
      event.dataTransfer.setData(
        'text/plain',
        JSON.stringify({ type: 'bench', userId: member.user_id }),
      );
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  protected onBenchDragOver(event: DragEvent): void {
    if (!this.canManageParticipants() || !this.draggedSeat() || this.rosterCommandSaving()) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    if (!this.isDropTargetBench()) {
      this.isDropTargetBench.set(true);
    }
  }

  protected onBenchDragLeave(event: DragEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    const related = event.relatedTarget as HTMLElement | null;
    if (target && related && target.contains(related)) {
      return;
    }
    this.isDropTargetBench.set(false);
  }

  protected async onBenchDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.isDropTargetBench.set(false);
    const sourceSeat = this.draggedSeat();
    this.draggedSeat.set(null);
    this.draggedBenchMember.set(null);
    this.dropTargetSeatKey.set(null);

    if (!this.canManageParticipants() || !sourceSeat || this.rosterCommandSaving()) return;
    await this.clearServerRosterSeat(sourceSeat);
  }

  protected onDragEnd(): void {
    this.draggedSeat.set(null);
    this.draggedBenchMember.set(null);
    this.dropTargetSeatKey.set(null);
    this.isDropTargetBench.set(false);
  }

  protected async performSeatSwap(source: EventRosterSeat, target: EventRosterSeat): Promise<void> {
    const roster = this.rosterSnapshot();
    const sourceKey = this.rosterSeatKey(source);
    const targetKey = this.rosterSeatKey(target);
    if (!roster || sourceKey === targetKey) return;

    await this.runServerRosterCommand('Posti scambiati.', () =>
      firstValueFrom(
        this.api.post<EventRosterView>(`api/events/${this.eventId}/roster/swaps`, {
          source_seat_key: sourceKey,
          target_seat_key: targetKey,
          expected_roster_version: roster.roster_version,
        }),
      ),
    );
  }

  protected async assignBenchMemberToSeatDirect(
    userId: number,
    target: EventRosterSeat,
  ): Promise<void> {
    const roster = this.rosterSnapshot();
    const targetKey = this.rosterSeatKey(target);
    if (!roster) return;

    await this.runServerRosterCommand('Membro assegnato al posto.', () =>
      firstValueFrom(
        this.api.put<EventRosterView>(
          `api/events/${this.eventId}/roster/seats/${encodeURIComponent(targetKey)}`,
          { user_id: userId, expected_roster_version: roster.roster_version },
        ),
      ),
    );
  }

  protected async autoFillServerRoster(): Promise<void> {
    const roster = this.rosterSnapshot();
    if (!roster) return;

    await this.runServerRosterCommand('Roster compilato automaticamente.', () =>
      firstValueFrom(
        this.api.post<EventRosterView>(`api/events/${this.eventId}/roster/auto-fill`, {
          expected_roster_version: roster.roster_version,
        }),
      ),
    );
  }

  /**
   * Runs one seat command and folds the roster it returns straight back into the view.
   *
   * Every roster endpoint answers with the freshly recomputed snapshot, so refetching would only
   * repeat the work — and going through the non-silent loader would unmount the whole roster panel
   * behind a spinner, collapsing the page and throwing the officer back to the top on every single
   * assignment. Swapping the data in place keeps the scroll position and the open panels exactly
   * where they were; the socket broadcast still carries the same change to everyone else.
   */
  private async runServerRosterCommand(
    successMessage: string,
    command: () => Promise<EventRosterView | void>,
  ): Promise<void> {
    this.rosterCommandSaving.set(true);
    try {
      const roster = await command();
      this.cancelRosterCommandMode();
      if (isEventRosterView(roster)) {
        this.applyRosterSnapshot(roster);
      } else {
        await this.loadRosterSnapshot(true);
      }
      this.toasts.success(successMessage);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.cancelRosterCommandMode();
        await this.loadRosterSnapshot(true);
        this.toasts.error('Il roster è stato aggiornato da un altro ufficiale. Riprova.');
        return;
      }
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.rosterCommandSaving.set(false);
    }
  }

  protected slotAssignment(slot: CompSlotRow): number | null {
    return this.resolvedAssignments().get(slot.key) ?? null;
  }

  protected slotParticipant(slot: CompSlotRow): EventParticipant | null {
    const userId = this.slotAssignment(slot);
    if (userId === null) return null;
    return this.event()?.participants.find((p) => p.user_id === userId) ?? null;
  }

  protected roleBorderClass(role: string): string {
    switch (role) {
      case 'tank':
        return 'border border-[var(--color-info)] bg-[var(--color-info-container)]';
      case 'healer':
        return 'border border-[var(--color-success)] bg-[var(--color-success-container)]';
      case 'support':
        return 'border border-[var(--color-warning)] bg-[var(--color-warning-container)]';
      case 'dps':
        return 'border border-[var(--color-error)] bg-[var(--color-error-container)]';
      case 'battle_mount':
        return 'border border-[var(--color-primary)] bg-[var(--color-primary-container)]';
      case 'brawler':
        return 'border border-[var(--color-info)] bg-[var(--color-info-container)]';
      default:
        return 'border border-[var(--color-border)]';
    }
  }

  /** Colours for the large "my assignment" role badge — the same palette as {@link roleBorderClass}, at full strength. */
  protected roleSpotlightClass(role: string): string {
    switch (role) {
      case 'tank':
        return 'border-[var(--color-info)] bg-[var(--color-info-container)] text-[var(--color-info)]';
      case 'healer':
        return 'border-[var(--color-success)] bg-[var(--color-success)]/10 text-success';
      case 'support':
        return 'border-[var(--color-warning)]/40 bg-[var(--color-warning-container)] text-warning';
      case 'dps':
        return 'border-[var(--color-error)] bg-[var(--color-error-container)] text-error';
      case 'battle_mount':
        return 'border-[var(--color-primary)] bg-[var(--color-primary-container)] text-[var(--color-primary)]';
      case 'brawler':
        return 'border-[var(--color-info)] bg-[var(--color-info-container)] text-[var(--color-info)]';
      default:
        return 'border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-text)]';
    }
  }

  protected seatWeaponIconUrl(seat: EventRosterSeat): string {
    const detail = this.buildDetails().get(seat.build_id);
    const weapon = detail?.items.find((item) => item.slot === 'weapon');
    return weapon ? this.renderItemIconUrl(weapon) : '';
  }

  protected onSeatHover(seat: EventRosterSeat): void {
    this.hoveredSlotKey.set(seat.key);
  }

  protected onSeatLeave(): void {
    this.hoveredSlotKey.set(null);
  }

  protected toggleSeatTooltip(seat: EventRosterSeat): void {
    this.pinnedSlotKey.update((current) => (current === seat.key ? null : seat.key));
    this.onSeatWeaponClick(seat);
  }

  protected itemSelectedSpells(
    item: BuildItemSlot,
  ): { key: string; name: string; iconUrl: string }[] {
    const catalog = this.abilityCatalog();
    const key = abilityKeyForItem(item);
    const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells);
    return slots
      .filter((s) => s.selected !== null)
      .map((s) => {
        const choice = s.choices.find((c) => c.id === s.selected);
        return {
          key: s.label,
          name: choice?.name ?? s.selected ?? '',
          iconUrl: s.selected ? albionAbilityIconUrl(s.selected) : '',
        };
      });
  }

  protected seatWeaponItem(seat: EventRosterSeat): BuildItemSlot | undefined {
    const items = this.rosterSeatBuildItems(seat);
    return items.find((i) => i.slot === 'weapon' && (i.loadout ?? 'main') === 'main');
  }

  protected seatWeaponSpells(
    seat: EventRosterSeat,
  ): { key: string; name: string; iconUrl: string }[] {
    const weapon = this.seatWeaponItem(seat);
    if (!weapon) return [];
    return this.itemSelectedSpells(weapon);
  }

  protected getSeatWeaponTooltipData(seat: EventRosterSeat) {
    const weapon = this.seatWeaponItem(seat);
    const spells = weapon ? this.itemSelectedSpells(weapon) : [];
    return {
      name: weapon?.openalbion_item_name ?? seat.build_name,
      tier: weapon?.openalbion_item_tier ?? '',
      icon: weapon?.openalbion_item_icon ?? this.seatWeaponIconUrl(seat),
      role: seat.role,
      buildName: seat.build_name,
      spells,
    };
  }

  protected onSeatWeaponMouseEnter(seat: EventRosterSeat, event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const data = this.getSeatWeaponTooltipData(seat);
    const x = Math.min(window.innerWidth - 300, Math.max(12, rect.right + 10));
    const y = Math.min(window.innerHeight - 240, Math.max(16, rect.top - 8));
    this.activeWeaponTooltip.set({
      ...data,
      x,
      y,
    });
  }

  protected onSeatWeaponMouseLeave(): void {
    this.activeWeaponTooltip.set(null);
  }

  protected onSeatWeaponClick(seat: EventRosterSeat): void {
    this.selectedInspectSeat.set(seat);
    this.dialogLoadout.set('main');
    this.inspectDialogSeat.set(seat);
  }

  protected dialogItems(seat: EventRosterSeat): BuildItemSlot[] {
    return this.rosterSeatBuildItems(seat).filter(
      (item) => (item.loadout ?? 'main') === this.dialogLoadout(),
    );
  }

  protected dialogAbilityRows(seat: EventRosterSeat) {
    return this.abilityRowsFor(this.dialogItems(seat));
  }

  protected selectedChoiceInSlot(slot: AbilitySlotView) {
    if (!slot.selected) return null;
    return (
      slot.choices.find((c) => c.id === slot.selected) ?? { id: slot.selected, name: slot.selected }
    );
  }

  protected iconUrlForSpell(spellId: string): string {
    return albionAbilityIconUrl(spellId);
  }

  protected roleGlyphColor(role: string): string {
    switch (role.toLowerCase()) {
      case 'tank':
        return 'text-[var(--color-info)]';
      case 'healer':
        return 'text-success';
      case 'support':
        return 'text-[var(--color-primary)]';
      case 'dps':
      default:
        return 'text-error';
    }
  }

  /**
   * Generates clean markdown formatted text of the parties & player assignments for Discord.
   */
  protected copyRosterForDiscord(): void {
    const detail = this.event();
    const roster = this.rosterSnapshot();
    if (!detail) return;

    const compName = detail.active_comp_name || detail.comp_name || 'Composition';
    const eventDate = new Date(detail.event_date_utc).toUTCString();
    const cta = detail.call_to_arms ? ' [CALL TO ARMS]' : '';

    if (roster && roster.seats.length > 0) {
      let md = `**${detail.title.toUpperCase()}${cta}**\n`;
      md += `Date: **${eventDate}** | Comp: **${compName}** (${this.rosterFilledSeats()}/${this.rosterSeatCount()})\n\n`;

      const parties = this.rosterParties();
      parties.forEach((party) => {
        const filled = this.rosterPartyFilledSeats(party);
        md += `**PARTY ${party.partyNumber} (${filled}/${party.seats.length})**\n`;
        party.seats.forEach((seat) => {
          const roleName = this.rosterSeatRoleLabel(seat);
          if (seat.participant) {
            md += `${seat.position}. [${roleName}] **${seat.participant.username}** — ${seat.build_name}\n`;
          } else {
            md += `${seat.position}. [${roleName}] *EMPTY* — ${seat.build_name}\n`;
          }
        });
        md += `\n`;
      });

      if (roster.bench.length > 0) {
        md += `**BENCH / QUEUE (${roster.bench.length}):**\n`;
        roster.bench.forEach((u) => {
          md += `• **${u.username}** (${u.primary_build_name || 'None'}${u.secondary_build_name ? ` / ${u.secondary_build_name}` : ''})\n`;
        });
      }

      void navigator.clipboard.writeText(md).then(() => {
        this.toasts.success(this.t('events.detail.discord_copied'));
      });
      return;
    }

    // Fallback for legacy
    let md = `**${detail.title.toUpperCase()}${cta}**\n`;
    md += `Date: **${eventDate}** | Comp: **${compName}** (${this.filledSlotsCount()}/${this.compSlots().length})\n\n`;
    const parties = this.compParties();
    parties.forEach((party) => {
      md += `**PARTY ${party.partyNumber} (${party.filledCount}/${party.totalCount})**\n`;
      party.slots.forEach((slot, idx) => {
        const occupant = this.slotParticipant(slot);
        const slotNum = (party.partyNumber - 1) * 20 + idx + 1;
        const roleName = this.roleLabelName(slot.role);
        if (occupant) {
          md += `${slotNum}. [${roleName}] **${occupant.username}** — ${slot.build.name}\n`;
        } else {
          md += `${slotNum}. [${roleName}] *EMPTY* — ${slot.build.name}\n`;
        }
      });
      md += `\n`;
    });

    const unassigned = this.unassignedParticipants();
    if (unassigned.length > 0) {
      md += `**BENCH / QUEUE (${unassigned.length}):**\n`;
      unassigned.forEach((u) => {
        md += `• **${u.username}** (${u.primary_build_name || 'None'}${u.secondary_build_name ? ` / ${u.secondary_build_name}` : ''})\n`;
      });
    }

    void navigator.clipboard.writeText(md).then(() => {
      this.toasts.success(this.t('events.detail.discord_copied'));
    });
  }

  protected slotTooltipItems(buildId: number): BuildItemSlot[] {
    const detail = this.buildDetails().get(buildId);
    if (!detail) return [];
    return [...detail.items].sort(sortBySlotOrder);
  }

  protected renderItemIconUrl(item: BuildItemSlot): string {
    const icon = item.openalbion_item_icon?.trim();
    if (!icon) return '';
    const identifier = icon
      .split('/')
      .pop()
      ?.split('?')
      .shift()
      ?.split('@')
      .shift()
      ?.replace(/\.png$/i, '')
      .trim();
    if (!identifier) return icon;
    return `https://render.albiononline.com/v1/item/${encodeURIComponent(identifier)}.png?quality=1&size=96`;
  }

  protected openMemberPicker(): void {
    this.closeMemberForm();
    this.memberSearchOptions.set([]);
    this.memberError.set(null);
    this.showMemberSearch.set(true);
    void this.loadMemberSearch('');
  }

  protected closeMemberSearch(): void {
    this.showMemberSearch.set(false);
  }

  protected async onMemberSearchFilter(filter: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    await this.loadMemberSearch(filter.search);
  }

  private async loadMemberSearch(search: string): Promise<void> {
    this.memberSearchLoading.set(true);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<UserProfile>>('api/users', {
          page: 1,
          limit: 50,
          username: search.trim() || undefined,
        }),
      );
      this.memberSearchOptions.set(
        data.items.map((user) => ({ id: String(user.id), title: user.username })),
      );
    } catch (error) {
      this.memberError.set(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.memberSearchLoading.set(false);
    }
  }

  protected onMemberSelected(option: SearchDialogOption): void {
    this.showMemberSearch.set(false);
    this.draftMember.set(option);
    this.draftMemberPrimaryBuildId.set('');
    this.draftMemberSecondaryBuildId.set('');
    this.memberError.set(null);
    if (this.availableBuilds().length === 0) {
      void this.loadActiveComp();
    }
  }

  protected onMemberPrimaryBuildChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.draftMemberPrimaryBuildId.set(value);
    if (value === FILL_BUILD_VALUE) {
      this.draftMemberSecondaryBuildId.set('');
    }
    this.memberError.set(null);
  }

  protected onMemberSecondaryBuildChange(event: Event): void {
    this.draftMemberSecondaryBuildId.set((event.target as HTMLSelectElement).value);
    this.memberError.set(null);
  }

  protected async onMemberSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    const member = this.draftMember();
    if (!detail || !member) return;

    const primaryRaw = this.draftMemberPrimaryBuildId();
    const primaryBuildId = primaryRaw === FILL_BUILD_VALUE ? null : Number(primaryRaw);
    if (primaryBuildId !== null && primaryBuildId <= 0) {
      this.memberError.set('Seleziona una build o uno slot primario.');
      return;
    }

    const request: AddEventMemberRequest = {
      user_id: Number(member.id),
      primary_build_id: primaryBuildId,
    };
    const secondaryBuildId = Number(this.draftMemberSecondaryBuildId());
    if (primaryBuildId !== null && secondaryBuildId > 0 && secondaryBuildId !== primaryBuildId) {
      request.secondary_build_id = secondaryBuildId;
    }

    this.memberSaving.set(true);
    this.memberError.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.post<EventDetailView>(`api/events/${detail.id}/participants`, request),
      );
      this.event.set(updated);
      await this.loadRosterSnapshot();
      this.closeMemberForm();
      this.toasts.success('Member added to the event.');
    } catch (error) {
      this.memberError.set(error instanceof Error ? error.message : this.t('common.error'));
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.memberSaving.set(false);
    }
  }

  protected closeMemberForm(): void {
    this.draftMember.set(null);
    this.draftMemberPrimaryBuildId.set('');
    this.draftMemberSecondaryBuildId.set('');
    this.memberError.set(null);
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
    this.battleSearchTerm.set(filter.search);
    if (this.battleSearchRaw().length === 0) {
      void this.loadGuildBattles();
    }
  }

  private async loadGuildBattles(): Promise<void> {
    this.battleSearchLoading.set(true);
    try {
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

  protected unlinkSplit(splitId: number): void {
    this.pendingConfirm.set({ kind: 'unlink-split', splitId });
  }

  private async performUnlinkSplit(splitId: number): Promise<void> {
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

  protected onTabChange(value: string): void {
    if (isEventDetailTab(value)) {
      this.tab.set(value);
    }
  }

  protected requestDelete(): void {
    this.pendingConfirm.set({ kind: 'delete' });
  }

  protected requestCancel(eventId: number): void {
    this.pendingConfirm.set({ kind: 'cancel', eventId });
  }

  protected cancelConfirm(): void {
    this.pendingConfirm.set(null);
  }

  protected confirmTitle(confirm: PendingConfirm): string {
    switch (confirm.kind) {
      case 'delete':
        return this.t('events.detail.delete');
      case 'stop':
        return this.t('events.stop');
      case 'cancel':
        return this.t('events.cancel');
      case 'unlink-split':
        return this.t('events.detail.unlink_split');
      case 'clear-all':
        return this.t('events.detail.clear_all');
      case 'remove-participant':
        return this.t('events.detail.remove_participant');
    }
  }

  protected confirmMessage(confirm: PendingConfirm): string {
    switch (confirm.kind) {
      case 'delete':
        return this.t('events.detail.confirm_delete');
      case 'clear-all':
        return this.t('events.detail.clear_all_confirm');
      case 'remove-participant':
        return `${this.t('events.detail.remove_participant')} — ${confirm.username}?`;
      default:
        return this.t('common.confirm');
    }
  }

  protected confirmActionLabel(confirm: PendingConfirm): string {
    return confirm.kind === 'delete' ||
      confirm.kind === 'remove-participant' ||
      confirm.kind === 'clear-all'
      ? this.t('common.delete')
      : this.t('common.confirm');
  }

  protected async runConfirm(): Promise<void> {
    const confirm = this.pendingConfirm();
    this.pendingConfirm.set(null);
    if (!confirm) return;
    switch (confirm.kind) {
      case 'delete':
        await this.confirmDelete();
        break;
      case 'stop':
        await this.mutate(`api/events/${confirm.eventId}/stop`, 'POST', {});
        break;
      case 'cancel':
        await this.mutate(`api/events/${confirm.eventId}/cancel`, 'POST', {});
        break;
      case 'unlink-split':
        await this.performUnlinkSplit(confirm.splitId);
        break;
      case 'clear-all':
        break;
      case 'remove-participant':
        break;
    }
  }

  protected toggleEditForm(): void {
    const detail = this.event();
    if (detail) {
      this.draftTitle.set(detail.title);
      this.draftDescription.set(detail.description || '');
      this.draftCompId.set(String(detail.active_comp_id || detail.comp_id));
      this.draftCompTitle.set(detail.comp_name || '');
      const start = new Date(detail.start_time_utc ?? detail.event_date_utc);
      const mass = new Date(
        detail.mass_time_utc ?? new Date(start.getTime() - 30 * 60_000).toISOString(),
      );
      this.draftEventDate.set(formatDateInput(start));
      this.draftMassTime.set(formatTimeInput(mass));
      this.draftStartTime.set(formatTimeInput(start));
      this.draftCallToArms.set(detail.call_to_arms);
      this.draftRegear.set(detail.regear);
    }
    this.showEditForm.update((v) => !v);
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

  protected onCallToArmsChange(event: Event): void {
    this.draftCallToArms.set((event.target as HTMLInputElement).checked);
  }

  protected onRegearChange(event: Event): void {
    this.draftRegear.set((event.target as HTMLInputElement).checked);
  }

  protected async onUpdateSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();
    const detail = this.event();
    if (!detail) return;

    const title = this.draftTitle().trim();
    if (!title) {
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
      this.toasts.error("Mass deve essere uguale o precedente all'orario di Start.");
      return;
    }

    const request: UpdateEventRequest = { title };
    const description = this.draftDescription().trim();
    request.description = description || undefined;
    request.call_to_arms = this.draftCallToArms();
    request.regear = this.draftRegear();
    const compId = Number(this.draftCompId());
    if (compId > 0) {
      request.comp_id = compId;
    }
    request.event_date_utc = startAt.toISOString();
    request.mass_time_utc = massAt.toISOString();
    request.start_time_utc = startAt.toISOString();

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
    if (!detail) return;
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
    if (!detail) return;
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

  protected async confirmDelete(): Promise<void> {
    const detail = this.event();
    if (!detail) return;
    try {
      await firstValueFrom(this.api.delete(`api/events/${detail.id}`));
      this.toasts.success(this.t('common.delete'));
      void this.router.navigate(['/events']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected toggleJoinForm(): void {
    if (this.showJoinForm()) {
      this.showJoinForm.set(false);
      return;
    }
    const participation = this.currentParticipant();
    this.draftPrimaryBuildId.set(
      participation
        ? participation.primary_build_id === null
          ? FILL_BUILD_VALUE
          : String(participation.primary_build_id)
        : '',
    );
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
    const value = (event.target as HTMLSelectElement).value;
    this.draftPrimaryBuildId.set(value);
    if (value === FILL_BUILD_VALUE) {
      this.draftSecondaryBuildId.set('');
    }
    this.joinError.set(null);
  }

  /**
   * Build options load asynchronously, so a `[value]` binding on the `<select>` is applied while
   * the list is still empty and the browser silently resets it. Marking the matching `<option>`
   * selected instead keeps the current choice visible once the options arrive.
   */
  protected isSelectedBuild(selected: string, buildId: number): boolean {
    return selected === String(buildId);
  }

  protected onSecondaryBuildChange(event: Event): void {
    this.draftSecondaryBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected async onJoinSubmit(submit: SubmitEvent): Promise<void> {
    submit.preventDefault();

    // `null` is the virtual Fill role: the backend accepts a participation without a build.
    if (!this.isFillSelected() && Number(this.draftPrimaryBuildId()) <= 0) {
      this.joinError.set(this.t('events.detail.primary_required'));
      return;
    }

    // Keep the selection dialog open only long enough to choose a build. The API is called from the
    // explicit confirmation dialog so the selected build and its main-hand weapon can be reviewed.
    this.showJoinForm.set(false);
    this.showJoinConfirm.set(true);
  }

  protected cancelJoinConfirm(): void {
    this.showJoinConfirm.set(false);
    this.showJoinForm.set(true);
  }

  protected async confirmJoin(): Promise<void> {
    const detail = this.event();
    if (!detail) return;

    const isFill = this.isFillSelected();
    const primaryBuildId = isFill ? null : Number(this.draftPrimaryBuildId());
    if (primaryBuildId !== null && primaryBuildId <= 0) {
      this.showJoinConfirm.set(false);
      this.showJoinForm.set(true);
      this.joinError.set(this.t('events.detail.primary_required'));
      return;
    }

    const request: ParticipateEventRequest = { primary_build_id: primaryBuildId };
    const secondaryRaw = this.draftSecondaryBuildId();
    if (primaryBuildId !== null && secondaryRaw) {
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
      await this.loadRosterSnapshot();
      this.showJoinConfirm.set(false);
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
        await this.loadRosterSnapshot(true);
      } else {
        await this.load(true);
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

  protected stop(id: number): void {
    this.pendingConfirm.set({ kind: 'stop', eventId: id });
  }

  protected openBattle(albionbbBattleId: string): void {
    void this.router.navigate(['/battles', albionbbBattleId]);
  }

  protected openFight(fight: EventFight): void {
    if (fight.battle_ids.length === 0) return;
    void this.router.navigate(['/battles/group'], {
      queryParams: { ids: fight.battle_ids.join(',') },
    });
  }

  protected openBattleGroup(detail: EventDetailView): void {
    const ids = detail.battles.map((battle) => battle.albionbb_battle_id);
    if (ids.length === 0) return;
    void this.router.navigate(['/battles/group'], { queryParams: { ids: ids.join(',') } });
  }

  protected formatDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected fightMetrics(fight: EventFight, battles: readonly EventBattleSummary[]): FightKpis {
    const linkedBattles = battles.filter((battle) =>
      fight.battle_ids.includes(battle.albionbb_battle_id),
    );
    const playerCounts = linkedBattles
      .map((battle) => battle.battle_total_players)
      .filter((players): players is number => players !== null);
    const hasLinkedBattles = linkedBattles.length > 0;
    const outcomes = linkedBattles.map((battle) => battle.is_win);

    return {
      outcome:
        fight.outcome?.outcome ??
        (outcomes.length === 0
          ? 'unknown'
          : outcomes.every(Boolean)
            ? 'victory'
            : outcomes.every((outcome) => !outcome)
              ? 'defeat'
              : 'draw'),
      segments: fight.segment_count ?? fight.battle_ids.length,
      players:
        fight.total_players ??
        fight.stats?.total_players ??
        (playerCounts.length > 0 ? Math.max(...playerCounts) : null),
      kills:
        fight.total_kills ??
        fight.stats?.total_kills ??
        (hasLinkedBattles
          ? linkedBattles.reduce((total, battle) => total + battle.guild_kills, 0)
          : null),
      fame:
        fight.total_fame ??
        fight.stats?.total_fame ??
        fight.stats?.total_kill_fame ??
        fight.stats?.kill_fame ??
        (hasLinkedBattles
          ? linkedBattles.reduce((total, battle) => total + battle.guild_kill_fame, 0)
          : null),
    };
  }

  protected fightOutcomeLabel(outcome: FightKpis['outcome']): string {
    return outcome.toUpperCase();
  }

  protected formatNumber(value: number): string {
    return new Intl.NumberFormat().format(Number(value ?? 0));
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString();
  }

  protected netOfSplit(split: SplitSummary): number {
    if (split.net_value !== null && split.net_value !== undefined) {
      return Number(split.net_value);
    }
    return (
      Number(split.estimated_market_value) - Number(split.repair_value) + Number(split.bags_value)
    );
  }

  protected cityLabel(city: string | null | undefined): string {
    if (!city) return '';
    return this.t(`splits.city.${city}` as TranslationKey);
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

  protected roleLabelName(role: BuildRole): string {
    const key = ROLE_LABELS[role];
    return this.t(key);
  }

  protected roleChip(role: string): string {
    return (ROLE_CHIP as Record<string, string>)[role] ?? 'chip';
  }

  protected roleGlyph(role: string): string {
    return (ROLE_GLYPH as Record<string, string>)[role] ?? '•';
  }

  protected fillPercent(current: number, target: number): number {
    if (target <= 0) return 0;
    return Math.min(100, Math.round((current / target) * 100));
  }

  private async loadSpecializationCatalog(): Promise<void> {
    if (this.specializationCatalog().length > 0) return;
    try {
      const catalog = await this.albionCatalog.load();
      this.specializationCatalog.set(deduplicateAlbionCombatCatalog(catalog));
    } catch {
      // The roster remains usable without the optional specialization selector.
    }
  }

  private async loadAbilityCatalog(): Promise<void> {
    if (Object.keys(this.abilityCatalog()).length > 0) return;
    try {
      this.abilityCatalog.set(await this.albionAbilities.load());
    } catch {
      // The roster spotlight card falls back to hiding the abilities section.
    }
  }

  /** The current member's own seat equipment for one loadout, in canonical slot order. */
  private ownSeatItems(loadout: BuildLoadout): BuildItemSlot[] {
    const seat = this.ownRosterSeat();
    if (!seat) return [];
    return this.rosterSeatBuildItems(seat).filter((item) => (item.loadout ?? 'main') === loadout);
  }

  /**
   * One ability bar per equipped item that actually offers abilities.
   *
   * Items with nothing to choose — off-hands, capes, bags, consumables, mounts — produce no row.
   */
  private abilityRowsFor(
    items: readonly BuildItemSlot[],
  ): { slot: BuildSlot; itemName: string; slots: AbilitySlotView[] }[] {
    const catalog = this.abilityCatalog();
    return items.flatMap((item) => {
      const key = abilityKeyForItem(item);
      const slots = abilitySlotsFor(item.slot, key ? catalog[key] : undefined, item.spells);
      return slots.length === 0
        ? []
        : [{ slot: item.slot, itemName: item.openalbion_item_name, slots }];
    });
  }

  protected async load(silent = false): Promise<void> {
    if (!this.eventId) return;
    const eventId = this.eventId;
    // Bump the generation for this navigation/refresh attempt so a response
    // from an already-superseded load can recognize itself as stale below.
    const generation = ++this.loadGeneration;
    // Silent reloads (e.g. a realtime roster event) keep the current view mounted
    // and refresh its data in place, instead of flashing the full-page loading state.
    if (!silent) {
      this.loadingGeneration = generation;
      this.loading.set(true);
    }
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(this.api.get<EventDetailView>(`api/events/${eventId}`));
      if (this.isStaleLoad(generation, eventId)) return;
      this.event.set(detail);
      this.realtimeRoster.connect(eventId);
      this.eventLossEstimate.set(detail.estimated_losses ?? emptyLossEstimate());
      void this.loadSpecializationCatalog();
      void this.loadAbilityCatalog();
      await Promise.all([
        this.loadRosterSnapshot(silent, generation, eventId),
        this.loadActiveComp(),
        this.loadLinkedBattleLosses(detail),
      ]);
    } catch (error) {
      if (this.isStaleLoad(generation, eventId)) return;
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      // A silent reload bumps the generation without ever touching `loading` — and the roster
      // socket, which `connect()` above opens, pushes its first message while this very load is
      // still awaiting the calls below. Deferring to `isStaleLoad` here would hand the spinner to
      // a load that never lowers it, leaving the page stuck on "loading" forever. Only a newer
      // non-silent load, which raises the spinner itself, may keep it up.
      if (!silent && this.loadingGeneration === generation) {
        this.loading.set(false);
      }
    }
  }

  /** True when a newer load (a later navigation or refresh) has since started. */
  private isStaleLoad(generation: number, eventId: number): boolean {
    return generation !== this.loadGeneration || eventId !== this.eventId;
  }

  private async loadRosterSnapshot(
    silent = false,
    generation = this.loadGeneration,
    eventId = this.eventId,
  ): Promise<void> {
    // Silent reloads keep the roster panel mounted and swap the data in place,
    // instead of flashing it to a loading state on every realtime update.
    if (!silent) {
      this.rosterSnapshotState.set('loading');
      this.rosterSnapshotError.set('');
    }
    try {
      const roster = await firstValueFrom(
        this.api.get<EventRosterView>(`api/events/${eventId}/roster`),
      );
      if (this.isStaleLoad(generation, eventId)) return;
      // A silent refresh comes from someone else's action; don't clobber the
      // current user's own in-progress swap/search/drag interactions.
      this.applyRosterSnapshot(roster, { clearInteractions: !silent });
    } catch (error) {
      if (this.isStaleLoad(generation, eventId)) return;
      this.rosterSnapshot.set(null);
      this.rosterSnapshotState.set('error');
      this.rosterSnapshotError.set(
        error instanceof Error ? error.message : 'Impossibile caricare il roster.',
      );
      this.rosterAnnouncement.set('');
    }
  }

  /**
   * Swaps a roster snapshot into the view without ever passing through the loading state.
   *
   * The missing build details are fetched in the background rather than awaited, so the seats
   * repaint on the same frame and only the equipment icons fill in a moment later.
   */
  private applyRosterSnapshot(
    roster: EventRosterView,
    options: { clearInteractions?: boolean } = {},
  ): void {
    this.rosterSnapshot.set(roster);
    this.rosterSnapshotState.set('ready');
    this.rosterSnapshotError.set('');
    if (options.clearInteractions) {
      this.clearLegacyRosterInteractionState();
    }
    void this.preloadRosterBuildDetails(roster.seats.map((seat) => seat.build_id));

    const ownSeat = this.ownRosterSeat();
    this.rosterAnnouncement.set(
      ownSeat
        ? `Roster aggiornato. Il tuo ruolo è ${this.rosterSeatRoleLabel(ownSeat)}, Party ${this.rosterSeatPartyNumber(ownSeat)}, posizione ${ownSeat.position}.`
        : this.isCurrentUserOnRosterBench()
          ? 'Roster aggiornato. Sei in bench, senza un posto assegnato.'
          : 'Roster aggiornato.',
    );
  }

  private async preloadRosterBuildDetails(buildIds: readonly number[]): Promise<void> {
    const cache = this.buildDetails();
    const missing = [...new Set(buildIds)].filter((buildId) => !cache.has(buildId));
    if (missing.length === 0) return;

    const results = await Promise.allSettled(
      missing.map((buildId) =>
        firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`)),
      ),
    );
    const next = new Map(this.buildDetails());
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') next.set(missing[index], result.value);
    });
    this.buildDetails.set(next);
  }

  private async loadActiveComp(): Promise<void> {
    const detail = this.event();
    if (!detail) return;
    const compId = detail.active_comp_id || detail.comp_id;
    if (!compId) return;

    this.compLoading.set(true);
    try {
      const comp = await firstValueFrom(this.api.get<CompDetail>(`api/comps/${compId}`));
      const extraBuildIds = (detail.roster_roles ?? [])
        .filter((role) => !role.is_fill && role.build_id !== null)
        .map((role) => role.build_id as number);
      const extraBuilds = await Promise.all(
        extraBuildIds.map((buildId) =>
          firstValueFrom(this.api.get<BuildSummary>(`api/comps/builds/${buildId}`)).catch(
            () => null,
          ),
        ),
      );
      const compBuildIds = new Set((comp.builds ?? []).map((entry) => entry.build_id));
      const extraEntries: CompBuildEntry[] = extraBuilds
        .filter((build): build is BuildSummary => build !== null && !compBuildIds.has(build.id))
        .map((build) => ({ build_id: build.id, build, quantity: 1 }));
      const rosterBuilds = [...(comp.builds ?? []), ...extraEntries];
      this.availableBuilds.set(rosterBuilds);
      await this.preloadBuildDetails(rosterBuilds);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.compLoading.set(false);
    }
  }

  private async loadAllBuilds(): Promise<void> {
    if (this.allBuilds().length > 0) return;
    try {
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 500,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.allBuilds.set(response.items);
    } catch (error) {
      this.rosterRoleError.set(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async preloadBuildDetails(entries: readonly CompBuildEntry[]): Promise<void> {
    const cache = this.buildDetails();
    const missing = entries.filter((entry) => !cache.has(entry.build_id));
    if (missing.length === 0) return;

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
    if (detail.battles.length === 0) return;
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
      if (estimates.length === 0) return;
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
 * Whether a roster command's response body is a usable snapshot.
 *
 * `DELETE` may answer with an empty body, and a proxy or an older backend can return something else
 * entirely; either way the caller falls back to a silent refetch instead of blanking the roster.
 */
function isEventRosterView(value: unknown): value is EventRosterView {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EventRosterView>;
  return (
    Array.isArray(candidate.seats) &&
    Array.isArray(candidate.bench) &&
    typeof candidate.roster_version === 'number'
  );
}

interface FightKpis {
  readonly outcome: 'victory' | 'defeat' | 'draw' | 'unknown';
  readonly segments: number;
  readonly players: number | null;
  readonly kills: number | null;
  readonly fame: number | null;
}

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

const ROLE_ORDER: readonly BuildRole[] = [
  'tank',
  'healer',
  'support',
  'dps',
  'battle_mount',
  'brawler',
];

const ROLE_LABELS: Readonly<Record<BuildRole, TranslationKey>> = {
  tank: 'events.detail.role_tank',
  healer: 'events.detail.role_healer',
  support: 'events.detail.role_support',
  dps: 'events.detail.role_dps',
  battle_mount: 'events.detail.role_battle_mount',
  brawler: 'events.detail.role_brawler',
};

const ROLE_CHIP: Readonly<Record<BuildRole, string>> = {
  tank: 'chip chip--info',
  healer: 'chip chip--success',
  support: 'chip chip--warning',
  dps: 'chip chip--error',
  battle_mount: 'chip',
  brawler: 'chip',
};

const ROLE_GLYPH: Readonly<Record<BuildRole, string>> = {
  tank: 'T',
  healer: 'H',
  support: 'S',
  dps: 'DPS',
  battle_mount: 'BM',
  brawler: 'BR',
};

interface RoleGrouping {
  readonly role: BuildRole;
  target: number;
  participants: EventParticipant[];
}

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
