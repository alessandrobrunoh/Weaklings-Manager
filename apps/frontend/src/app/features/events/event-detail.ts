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
  OpponentPerformanceView,
  PaginatedData,
  ParticipateEventRequest,
  SplitSummary,
  UpdateEventBattlesRequest,
  UpdateEventRequest,
  UserProfile,
  OpenAlbionItem,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { RealtimeRosterService } from '../../core/services/realtime-roster.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import {
  albionSpecializationKey,
  deduplicateAlbionCombatCatalog,
  normalizeAlbionEquipmentName,
} from '../../shared/data/albion-equipment-catalog';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';

type EventDetailTab = 'roster' | 'overview' | 'battles' | 'splits';

type PendingConfirm =
  | { kind: 'delete' }
  | { kind: 'stop'; eventId: number }
  | { kind: 'unlink-split'; splitId: number }
  | { kind: 'clear-all' }
  | { kind: 'remove-participant'; userId: number; username: string; slotKey?: string };

function isEventDetailTab(value: string): value is EventDetailTab {
  return value === 'roster' || value === 'overview' || value === 'battles' || value === 'splits';
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

@Component({
  selector: 'app-event-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    SearchDialog,
    StatusChip,
    ViewToggle,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (event(); as detail) {
      <!-- Hero Command Banner -->
      <section class="card mb-4 overflow-hidden border border-[var(--color-border)] p-0 rounded-xl">
        <div class="bg-[var(--color-surface-1)] p-5 border-b border-[var(--color-border)]">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn--ghost btn--sm" (click)="backToEvents()">
                &larr; {{ t('events.detail.back') }}
              </button>
              <app-status-chip [value]="detail.status" />
              @if (detail.call_to_arms) {
                <span class="chip chip--warning font-medium" [title]="t('events.call_to_arms')">
                  CTA
                </span>
              }
              <span class="chip chip--info font-mono text-xs">
                {{ countdownText() }}
              </span>
            </div>

            <!-- Management actions -->
            <div class="flex flex-wrap items-center gap-2">
              @if (canManage() && detail.status === 'scheduled') {
                <button type="button" class="btn btn--primary btn--sm" (click)="start(detail.id)">
                  {{ t('events.start') }}
                </button>
              }
              @if (canManage() && detail.status === 'live') {
                <button type="button" class="btn btn--danger btn--sm" (click)="stop(detail.id)">
                  {{ t('events.stop') }}
                </button>
              }
              @if (canEdit()) {
                <button type="button" class="btn btn--outline btn--sm" (click)="toggleEditForm()">
                  {{ showEditForm() ? t('common.close') : t('common.edit') }}
                </button>
                <button type="button" class="btn btn--danger btn--sm" (click)="requestDelete()">
                  {{ t('common.delete') }}
                </button>
              }
            </div>
          </div>

          <div class="mt-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h1 class="text-2xl font-medium tracking-tight text-[var(--color-text)]">
                {{ detail.title }}
              </h1>
              <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
                {{ formatDate(detail.event_date_utc) }} &middot;
                <span class="text-[var(--color-text)]">{{
                  detail.active_comp_name || detail.comp_name || t('events.detail.no_comp_linked')
                }}</span>
                ({{ filledSlotsCount() }}/{{ compSlots().length }}
                {{ t('events.detail.comp_capacity').toLowerCase() }})
              </p>
            </div>

            <!-- Join / Leave Participation Status Widget -->
            <div
              class="flex flex-wrap items-center gap-2 rounded-md bg-[var(--color-surface)] p-2.5 border border-[var(--color-border)]"
            >
              @if (currentParticipant(); as participation) {
                <div class="flex items-center gap-2">
                  <div class="h-2 w-2 rounded-full bg-[var(--color-success)]"></div>
                  <div class="text-xs">
                    <span class="text-[var(--color-text-secondary)]"
                      >{{ t('events.detail.registered_as') }}:</span
                    >
                    <span class="ml-1 font-medium text-[var(--color-text)]">{{
                      participation.primary_build_name || 'Build #' + participation.primary_build_id
                    }}</span>
                    @if (participation.secondary_build_name) {
                      <span class="text-[var(--color-text-secondary)]">
                        / {{ participation.secondary_build_name }}</span
                      >
                    }
                  </div>
                </div>
                <div class="flex items-center gap-1 ml-auto">
                  <button type="button" class="btn btn--ghost btn--sm" (click)="toggleJoinForm()">
                    {{ showJoinForm() ? t('common.close') : t('events.detail.change_build') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--outline btn--sm text-[var(--color-danger)]"
                    (click)="leave(detail.id)"
                  >
                    {{ t('events.leave') }}
                  </button>
                </div>
              } @else {
                <span class="text-xs text-[var(--color-text-secondary)]">
                  {{ t('events.detail.no_participants') }}
                </span>
                <button type="button" class="btn btn--primary btn--sm" (click)="toggleJoinForm()">
                  {{ showJoinForm() ? t('common.close') : t('events.participate') }}
                </button>
              }
            </div>
          </div>

          @if (detail.description) {
            <p class="mt-3 text-xs text-[var(--color-text-secondary)] max-w-4xl">
              {{ detail.description }}
            </p>
          }
        </div>

        <!-- Navigation Tab Strip -->
        <div
          class="bg-[var(--color-surface)] px-4 py-2 flex items-center justify-between border-b border-[var(--color-border)]"
        >
          <app-view-toggle
            pageTabs
            [options]="tabOptions()"
            [active]="tab()"
            (activeChange)="onTabChange($event)"
          />
        </div>
      </section>

      <app-page-stack>
        <!-- Edit Event Form Modal/Dropdown -->
        @if (showEditForm()) {
          <form
            class="card grid gap-3 p-5 border border-[var(--color-border)] mb-4 rounded-xl"
            (submit)="onUpdateSubmit($event)"
          >
            <h2 class="text-sm font-medium text-[var(--color-text)]">{{ t('common.edit') }}</h2>
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
                    <span class="truncate text-xs">{{
                      draftCompTitle() || t('events.detail.no_comp_linked')
                    }}</span>
                  </div>
                  <button
                    type="button"
                    class="btn btn--outline whitespace-nowrap btn--sm"
                    (click)="showCompSearch.set(true)"
                  >
                    {{ t('events.detail.link_comp') }}
                  </button>
                  @if (draftCompId()) {
                    <button
                      type="button"
                      class="btn btn--danger whitespace-nowrap btn--sm"
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
            <div class="flex items-center justify-between mt-2">
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  class="checkbox"
                  type="checkbox"
                  [checked]="draftCallToArms()"
                  (change)="onCallToArmsChange($event)"
                />
                <span class="text-xs font-medium">{{ t('events.call_to_arms') }}</span>
              </label>
              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  class="checkbox"
                  type="checkbox"
                  [checked]="draftRegear()"
                  (change)="onRegearChange($event)"
                />
                <span class="text-xs font-medium">{{ t('events.regear') }}</span>
              </label>
              <div class="flex gap-2">
                <button type="button" class="btn btn--ghost btn--sm" (click)="toggleEditForm()">
                  {{ t('common.cancel') }}
                </button>
                <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
                  {{ t('common.save') }}
                </button>
              </div>
            </div>
          </form>
        }

        <!-- Join Form Modal -->
        @if (showJoinForm()) {
          <form
            class="card grid gap-3 p-5 border border-[var(--color-border)] mb-4 rounded-xl"
            (submit)="onJoinSubmit($event)"
          >
            <h2 class="text-sm font-medium text-[var(--color-text)]">
              {{ currentParticipant() ? t('events.detail.change_build') : t('events.participate') }}
            </h2>
            @if (compLoading()) {
              <app-loading [label]="t('common.loading')" />
            } @else if (availableBuilds().length === 0) {
              <p class="text-xs" style="color: var(--color-text-secondary)">
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
                      {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
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
                      {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
                    </option>
                  }
                </select>
              </label>
              @if (joinError()) {
                <p class="text-xs" style="color: var(--color-danger)">{{ joinError() }}</p>
              }
              <div class="flex justify-end gap-2 mt-2">
                <button type="button" class="btn btn--ghost btn--sm" (click)="toggleJoinForm()">
                  {{ t('common.cancel') }}
                </button>
                <button
                  type="submit"
                  class="btn btn--primary btn--sm"
                  [disabled]="joinSubmitting()"
                >
                  {{ t('events.participate') }}
                </button>
              </div>
            }
          </form>
        }

        @switch (tab()) {
          <!-- ================= TAB 1: ROSTER & COMPOSITION BUILDER ================= -->
          @case ('roster') {
            @if (rosterSnapshot(); as roster) {
              <div class="space-y-4">
                <p class="event-detail__roster-live" aria-live="polite" aria-atomic="true">
                  {{ rosterAnnouncement() }}
                </p>

                <section
                  class="card p-4 rounded-xl border border-[var(--color-border)]"
                  aria-labelledby="my-assignment-heading"
                >
                  <div class="grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
                    <div>
                      <p
                        class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                      >
                        Roster room
                      </p>
                      <h2
                        id="my-assignment-heading"
                        class="mt-1 text-base font-semibold text-[var(--color-text)]"
                      >
                        Il tuo incarico
                      </h2>
                    </div>
                    @if (ownRosterSeat(); as seat) {
                      <div class="event-detail__assignment-summary">
                        <span
                          >Party {{ rosterSeatPartyNumber(seat) }} · Posizione
                          {{ rosterSeatPosition(seat) }}</span
                        >
                        <strong>{{ rosterSeatRoleLabel(seat) }}</strong>
                        <span
                          >{{ rosterSeatBuildName(seat)
                          }}{{
                            rosterSeatBuildVersion(seat)
                              ? ' · v' + rosterSeatBuildVersion(seat)
                              : ''
                          }}</span
                        >
                      </div>
                    } @else if (isCurrentUserOnRosterBench()) {
                      <p class="event-detail__assignment-summary">Bench, nessun posto assegnato.</p>
                    } @else {
                      <p class="event-detail__assignment-summary">Nessun incarico assegnato.</p>
                    }
                  </div>

                  @if (ownRosterSeat(); as seat) {
                    @if (rosterSeatBuildItems(seat).length > 0) {
                      <details class="mt-3 text-xs text-[var(--color-text-secondary)]">
                        <summary class="cursor-pointer text-[var(--color-text)]">
                          Equipaggiamento e abilità
                        </summary>
                        <ul class="mt-2 grid gap-1 sm:grid-cols-2" role="list">
                          @for (
                            item of rosterSeatBuildItems(seat);
                            track item.slot + ':' + item.loadout
                          ) {
                            <li>
                              {{ slotLabel(item.slot) }}: {{ item.openalbion_item_name
                              }}{{ rosterItemSpells(item) ? ' · ' + rosterItemSpells(item) : '' }}
                            </li>
                          }
                        </ul>
                      </details>
                    }
                  }
                </section>

                <section aria-labelledby="party-roster-heading">
                  <div class="event-detail__section-header">
                    <div>
                      <h2 id="party-roster-heading">Party roster</h2>
                      <p>Assegnazioni confermate dal server.</p>
                    </div>
                    <span class="chip text-xs"
                      >{{ rosterFilledSeats() }}/{{ rosterSeatCount() }} posti</span
                    >
                  </div>

                  <div class="grid gap-4 lg:grid-cols-2">
                    @for (party of rosterParties(); track party.partyNumber) {
                      <section
                        class="card p-0 overflow-hidden rounded-xl border border-[var(--color-border)]"
                        [attr.aria-labelledby]="'party-heading-' + party.partyNumber"
                      >
                        <header
                          class="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-4 py-3"
                        >
                          <h3
                            [id]="'party-heading-' + party.partyNumber"
                            class="text-sm font-semibold text-[var(--color-text)]"
                          >
                            {{ rosterPartyName(party) }}
                          </h3>
                          <span class="text-xs text-[var(--color-text-secondary)]"
                            >{{ rosterPartyFilledSeats(party) }}/{{ party.seats.length }}</span
                          >
                        </header>
                        <ol
                          class="divide-y divide-[var(--color-border)]"
                          [attr.aria-label]="rosterPartyName(party)"
                        >
                          @for (
                            seat of party.seats;
                            track seat.party_number + ':' + seat.position
                          ) {
                            <li class="event-detail__roster-seat">
                              <div class="min-w-0">
                                <p class="text-xs font-medium text-[var(--color-text)]">
                                  {{ rosterSeatRoleLabel(seat) }} · Posizione
                                  {{ rosterSeatPosition(seat) }}
                                </p>
                                <p
                                  class="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]"
                                >
                                  {{ rosterSeatBuildName(seat)
                                  }}{{
                                    rosterSeatBuildVersion(seat)
                                      ? ' · v' + rosterSeatBuildVersion(seat)
                                      : ''
                                  }}
                                </p>
                              </div>
                              @if (seat.participant; as participant) {
                                <span
                                  class="text-right text-xs font-medium text-[var(--color-text)]"
                                  >{{ participant.username }}</span
                                >
                              } @else {
                                <span
                                  class="text-right text-xs italic text-[var(--color-text-secondary)]"
                                  >Posto libero</span
                                >
                              }
                            </li>
                          }
                        </ol>
                      </section>
                    } @empty {
                      <p class="event-detail__empty">Nessuna party configurata.</p>
                    }
                  </div>
                </section>

                <section
                  class="card p-4 rounded-xl border border-[var(--color-border)]"
                  aria-labelledby="bench-heading"
                >
                  <div class="event-detail__section-header">
                    <div>
                      <h2 id="bench-heading">Bench</h2>
                      <p>Iscritti senza un posto nella party.</p>
                    </div>
                    <span class="chip text-xs">{{ roster.bench.length }}</span>
                  </div>
                  <ul class="mt-3 flex flex-wrap gap-2" role="list">
                    @for (member of roster.bench; track member.user_id) {
                      <li class="chip text-xs">
                        {{ member.username
                        }}{{ member.primary_build_name ? ' · ' + member.primary_build_name : '' }}
                      </li>
                    } @empty {
                      <li class="text-xs text-[var(--color-text-secondary)]">
                        Nessun iscritto in bench.
                      </li>
                    }
                  </ul>
                </section>
              </div>
            } @else {
              <!-- Roster Control Bar -->
              <section class="card p-4 mb-4 rounded-xl border border-[var(--color-border)]">
                <div class="flex flex-wrap items-center justify-between gap-4">
                  <!-- Capacity & Role Fills -->
                  <div class="flex flex-wrap items-center gap-3">
                    <div class="flex items-center gap-2">
                      <span
                        class="text-xs font-medium text-[var(--color-text-secondary)] uppercase tracking-wider"
                      >
                        {{ t('events.detail.comp_filling') }}:
                      </span>
                      <span
                        class="font-mono text-xs px-2 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-text)]"
                      >
                        {{ filledSlotsCount() }} / {{ compSlots().length }} ({{
                          fillPercent(filledSlotsCount(), compSlots().length)
                        }}%)
                      </span>
                    </div>

                    <div class="flex flex-wrap items-center gap-1.5">
                      @for (group of participantsByRole(); track group.role) {
                        <span class="chip text-xs" [class]="roleChip(group.role)">
                          {{ roleGlyph(group.role) }} {{ t(roleLabel(group.role)) }}:
                          <span class="font-medium"
                            >{{ group.participants.length }}/{{ group.target }}</span
                          >
                        </span>
                      }
                    </div>
                  </div>

                  <!-- View Switcher & Actions -->
                  <div class="flex flex-wrap items-center gap-2">
                    <div
                      class="flex rounded-md bg-[var(--color-surface-2)] p-0.5 border border-[var(--color-border)]"
                    >
                      <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                        [class.bg-[var(--color-surface)]]="rosterView() === 'parties'"
                        [class.text-[var(--color-text)]]="rosterView() === 'parties'"
                        [class.text-[var(--color-text-secondary)]]="rosterView() !== 'parties'"
                        (click)="rosterView.set('parties')"
                      >
                        {{ t('events.detail.view_parties') }}
                      </button>
                      <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                        [class.bg-[var(--color-surface)]]="rosterView() === 'roles'"
                        [class.text-[var(--color-text)]]="rosterView() === 'roles'"
                        [class.text-[var(--color-text-secondary)]]="rosterView() !== 'roles'"
                        (click)="rosterView.set('roles')"
                      >
                        {{ t('events.detail.view_roles') }}
                      </button>
                      <button
                        type="button"
                        class="px-2.5 py-1 text-xs font-medium rounded transition-colors"
                        [class.bg-[var(--color-surface)]]="rosterView() === 'table'"
                        [class.text-[var(--color-text)]]="rosterView() === 'table'"
                        [class.text-[var(--color-text-secondary)]]="rosterView() !== 'table'"
                        (click)="rosterView.set('table')"
                      >
                        {{ t('events.detail.view_table') }}
                      </button>
                    </div>

                    @if (canEdit()) {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm"
                        (click)="openRosterRoleManager()"
                      >
                        + Ruolo extra
                      </button>
                    }

                    @if (canManageParticipants()) {
                      <button
                        type="button"
                        class="btn btn--tonal btn--sm"
                        (click)="autoFillRoster()"
                        [disabled]="autoFilling() || unassignedParticipants().length === 0"
                        title="Auto-fill empty slots with matching primary signups"
                      >
                        {{ t('events.detail.auto_fill') }}
                      </button>
                      <button
                        type="button"
                        class="btn btn--outline btn--sm"
                        (click)="openMemberSearch()"
                      >
                        + {{ t('events.detail.add_participant') }}
                      </button>
                    }

                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      (click)="copyRosterForDiscord()"
                      title="Copy formatted roster for Discord"
                    >
                      {{ t('events.detail.copy_discord') }}
                    </button>

                    @if (canManageParticipants() && filledSlotsCount() > 0) {
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm text-[var(--color-danger)]"
                        (click)="requestClearAll()"
                        title="Clear all assigned seats"
                      >
                        {{ t('events.detail.clear_all') }}
                      </button>
                    }
                  </div>
                </div>

                <!-- Swap Mode Active Notification Banner -->
                @if (swapSourceSlot(); as source) {
                  <div
                    class="mt-3 flex items-center justify-between gap-3 rounded-md bg-[var(--color-surface-2)] p-2.5 border border-[var(--color-primary)] text-xs"
                  >
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-sm text-[var(--color-primary)]">&harr;</span>
                      <span>
                        <strong class="font-medium text-[var(--color-text-secondary)]"
                          >{{ t('events.detail.swap_selected') }}:</strong
                        >
                        <span class="ml-1 font-medium text-[var(--color-text)]">
                          {{ slotParticipant(source)?.username || t('events.detail.seat_empty') }}
                        </span>
                        ({{ source.build.name }})
                      </span>
                    </div>
                    <button type="button" class="btn btn--ghost btn--sm" (click)="cancelSwapMode()">
                      {{ t('events.detail.cancel_swap') }}
                    </button>
                  </div>
                }
              </section>

              <!-- Main Layout: Grid Comp Board + Side Bench Tray -->
              <div class="grid gap-5 lg:grid-cols-[1fr_20rem] xl:grid-cols-[1fr_22rem]">
                <!-- COMPOSITION BOARD -->
                <div class="space-y-4">
                  <section
                    class="card p-4 border border-[var(--color-border)] rounded-xl"
                    aria-labelledby="roster-spec-heading"
                  >
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h2
                          id="roster-spec-heading"
                          class="text-sm font-semibold text-[var(--color-text)]"
                        >
                          Filtro spec arma
                        </h2>
                        <p class="text-xs text-[var(--color-text-secondary)]">
                          Mostra il livello della specializzazione accanto ai partecipanti.
                        </p>
                      </div>
                      <select
                        class="input w-full sm:w-auto"
                        aria-label="Seleziona arma o armatura"
                        [value]="selectedSpecializationKey()"
                        (change)="selectSpecialization($event)"
                      >
                        <option value="">Nessuna spec selezionata</option>
                        @for (item of specializationCatalog(); track item.id + ':' + item.type) {
                          <option [value]="specializationKey(item)">{{ item.name }}</option>
                        }
                      </select>
                    </div>
                    @if (selectedSpecializationKey()) {
                      <p class="mt-2 text-xs text-[var(--color-text-secondary)]">
                        Spec selezionata:
                        <strong class="text-[var(--color-text)]">{{
                          selectedSpecializationName()
                        }}</strong>
                        · usa la colonna nella vista tabella per ordinare i giocatori.
                      </p>
                    }
                  </section>
                  @if (compLoading()) {
                    <app-loading [label]="t('common.loading')" />
                  } @else if (compSlots().length === 0) {
                    <app-empty-state [message]="t('events.detail.no_builds')" icon="package" />
                  } @else {
                    <!-- VIEW 1: 20-MAN PARTIES VIEW -->
                    @if (rosterView() === 'parties') {
                      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
                        @for (party of compParties(); track party.partyNumber) {
                          <div
                            class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl"
                          >
                            <!-- Party Header -->
                            <div
                              class="bg-[var(--color-surface-1)] px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between"
                            >
                              <div class="flex items-center gap-2">
                                <span
                                  class="font-medium text-xs text-[var(--color-text)] uppercase tracking-wider"
                                >
                                  {{ party.partyName }}
                                </span>
                              </div>
                              <div class="flex items-center gap-2">
                                <div
                                  class="h-1.5 w-16 bg-[var(--color-surface-2)] rounded-full overflow-hidden"
                                >
                                  <div
                                    class="h-full bg-[var(--color-success)] rounded-full transition-all"
                                    [style.width.%]="(party.filledCount / party.totalCount) * 100"
                                  ></div>
                                </div>
                                <span class="font-mono text-xs text-[var(--color-text-secondary)]">
                                  {{ party.filledCount }}/{{ party.totalCount }}
                                </span>
                              </div>
                            </div>

                            <!-- Party Slot Seats -->
                            <div class="p-3 space-y-2">
                              @for (slot of party.slots; track slot.key) {
                                <div
                                  class="slot-card relative flex items-center justify-between gap-3 p-2.5 rounded-md border transition-all"
                                  [class.border-[var(--color-border)]]="
                                    swapSourceSlot()?.key !== slot.key &&
                                    dragOverSlotKey() !== slot.key
                                  "
                                  [class.border-[var(--color-primary)]]="
                                    swapSourceSlot()?.key === slot.key
                                  "
                                  [class.bg-[var(--color-surface-1)]]="
                                    swapSourceSlot()?.key === slot.key
                                  "
                                  [class.border-dashed]="dragOverSlotKey() === slot.key"
                                  [class.bg-[var(--color-surface)]]="
                                    swapSourceSlot()?.key !== slot.key
                                  "
                                  (dragover)="onSlotDragOver($event, slot)"
                                  (dragleave)="onSlotDragLeave(slot)"
                                  (drop)="onSlotDrop($event, slot)"
                                >
                                  <!-- Left: Weapon Render & Build info -->
                                  <div class="flex items-center gap-3 min-w-0">
                                    <div
                                      class="relative flex-shrink-0 h-10 w-10 rounded p-0.5 flex items-center justify-center border border-[var(--color-border)] cursor-pointer group bg-[var(--color-surface-1)]"
                                      (click)="toggleSlotTooltip(slot)"
                                      (mouseenter)="onSlotHover(slot)"
                                      (mouseleave)="onSlotLeave()"
                                      title="Click or hover to inspect loadout"
                                    >
                                      @if (weaponRenderIconUrl(slot); as icon) {
                                        <img
                                          [src]="icon"
                                          [alt]="slot.build.name"
                                          class="h-full w-full object-contain"
                                          loading="lazy"
                                        />
                                      } @else {
                                        <span
                                          class="text-xs font-mono font-medium text-[var(--color-text-secondary)]"
                                          >{{ roleGlyph(slot.role) }}</span
                                        >
                                      }
                                    </div>

                                    <div class="min-w-0">
                                      <div class="flex items-center gap-1.5">
                                        <span
                                          class="font-medium text-xs text-[var(--color-text)] truncate max-w-[10rem]"
                                        >
                                          {{ slot.build.name }}
                                        </span>
                                        <span
                                          class="text-[0.625rem] uppercase font-mono px-1 py-0.2 rounded"
                                          [class]="roleChip(slot.role)"
                                        >
                                          {{ roleGlyph(slot.role) }}
                                        </span>
                                      </div>

                                      <!-- Assigned Participant or Empty -->
                                      <div class="mt-0.5">
                                        @if (slotParticipant(slot); as occupant) {
                                          <div class="flex items-center gap-1.5">
                                            <span
                                              class="text-xs font-medium text-[var(--color-text)] truncate"
                                              [class.text-[var(--color-primary)]]="
                                                occupant.user_id === currentParticipant()?.user_id
                                              "
                                            >
                                              {{ occupant.username }}
                                            </span>
                                            @if (occupant.primary_build_id === slot.buildId) {
                                              <span
                                                class="text-[0.625rem] text-[var(--color-success)]"
                                                title="Primary build match"
                                              >
                                                [{{ t('events.detail.primary_choice') }}]
                                              </span>
                                            } @else if (
                                              occupant.secondary_build_id === slot.buildId
                                            ) {
                                              <span
                                                class="text-[0.625rem] text-[var(--color-info)]"
                                                title="Secondary build match"
                                              >
                                                [{{ t('events.detail.secondary_choice') }}]
                                              </span>
                                            } @else {
                                              <span
                                                class="text-[0.625rem] text-[var(--color-warning)]"
                                                title="Off-role assignment"
                                              >
                                                [{{ t('events.detail.off_role') }}]
                                              </span>
                                            }
                                          </div>
                                        } @else {
                                          <span
                                            class="text-xs italic text-[var(--color-text-disabled)]"
                                          >
                                            + {{ t('events.detail.seat_empty') }}
                                          </span>
                                        }
                                      </div>
                                    </div>
                                  </div>

                                  <!-- Right: Quick Actions -->
                                  <div class="flex items-center gap-1 flex-shrink-0">
                                    @if (slotSavingKey() === slot.key) {
                                      <app-loading [label]="''" />
                                    } @else {
                                      @if (canManageParticipants()) {
                                        @if (swapSourceSlot(); as source) {
                                          @if (source.key !== slot.key) {
                                            <button
                                              type="button"
                                              class="btn btn--primary btn--sm text-xs py-0.5 px-2"
                                              (click)="handleSlotClick(slot)"
                                            >
                                              {{ slotParticipant(slot) ? 'Swap' : 'Place' }}
                                            </button>
                                          }
                                        } @else {
                                          @if (slotParticipant(slot)) {
                                            <button
                                              type="button"
                                              class="btn btn--ghost btn--sm p-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-primary)]"
                                              (click)="startSwapFromSlot(slot)"
                                              title="Swap with another seat"
                                            >
                                              &harr;
                                            </button>
                                            <button
                                              type="button"
                                              class="btn btn--ghost btn--sm p-1 text-xs text-[var(--color-danger)]"
                                              (click)="clearSlot(slot)"
                                              title="Unassign to Bench"
                                            >
                                              &times;
                                            </button>
                                          } @else {
                                            <button
                                              type="button"
                                              class="btn btn--outline btn--sm text-xs py-0.5 px-2"
                                              (click)="openQuickAssign(slot)"
                                            >
                                              + {{ t('events.detail.quick_assign') }}
                                            </button>
                                          }
                                        }
                                      }
                                    }
                                  </div>

                                  <!-- Loadout Paperdoll Tooltip -->
                                  @if (slotTooltipVisible(slot)) {
                                    <div
                                      class="event-detail__tooltip border border-[var(--color-border)] rounded-md"
                                      role="tooltip"
                                    >
                                      <div
                                        class="flex items-center justify-between pb-2 mb-2 border-b border-[var(--color-border)]"
                                      >
                                        <span
                                          class="text-xs font-medium text-[var(--color-text)]"
                                          >{{ slot.build.name }}</span
                                        >
                                        <span
                                          class="text-[0.625rem] uppercase font-mono"
                                          [class]="roleChip(slot.role)"
                                          >{{ roleLabelName(slot.role) }}</span
                                        >
                                      </div>
                                      <div class="event-detail__tooltip-items">
                                        @for (
                                          item of slotTooltipItems(slot.buildId);
                                          track item.slot
                                        ) {
                                          <div class="event-detail__tooltip-item">
                                            @if (item.openalbion_item_icon) {
                                              <img
                                                [src]="renderItemIconUrl(item)"
                                                [alt]="item.openalbion_item_name"
                                                loading="lazy"
                                              />
                                            } @else {
                                              <span
                                                class="event-detail__tooltip-item-placeholder font-mono text-xs"
                                              >
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
                            </div>
                          </div>
                        }
                      </div>
                    }

                    <!-- VIEW 2: ROLE MATRIX VIEW -->
                    @if (rosterView() === 'roles') {
                      <div class="space-y-4">
                        <div
                          class="card overflow-hidden border border-dashed border-[var(--color-border)] rounded-xl"
                        >
                          <div
                            class="bg-[var(--color-surface-1)] px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between gap-3"
                          >
                            <div>
                              <span class="chip chip--tonal font-medium text-xs">Fill</span>
                              <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
                                Posti illimitati per i partecipanti non assegnati alla comp.
                              </p>
                            </div>
                            <span class="text-xs font-mono text-[var(--color-text-secondary)]"
                              >{{ unassignedParticipants().length }} iscritti</span
                            >
                          </div>
                          <div class="p-3 flex flex-wrap gap-2">
                            @for (
                              participant of unassignedParticipants();
                              track participant.user_id
                            ) {
                              <span class="chip text-xs"
                                >{{ participant.username }} ·
                                {{ participant.primary_build_name }}</span
                              >
                            } @empty {
                              <span class="text-xs text-[var(--color-text-secondary)]"
                                >Nessun partecipante nel Fill.</span
                              >
                            }
                          </div>
                        </div>

                        @for (group of compSlotsByRole(); track group.role) {
                          <div
                            class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl"
                          >
                            <div
                              class="bg-[var(--color-surface-1)] px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between"
                            >
                              <div class="flex items-center gap-2">
                                <span
                                  class="chip font-medium text-xs font-mono"
                                  [class]="roleChip(group.role)"
                                >
                                  {{ roleGlyph(group.role) }} {{ t(roleLabel(group.role)) }}
                                </span>
                                <span class="text-xs text-[var(--color-text-secondary)]">
                                  {{ groupRoleFilledCount(group) }} /
                                  {{ group.slots.length }} filled
                                </span>
                              </div>
                            </div>

                            <div class="p-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                              @for (slot of group.slots; track slot.key) {
                                <div
                                  class="flex items-center justify-between gap-2 p-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
                                  [class.border-[var(--color-primary)]]="
                                    swapSourceSlot()?.key === slot.key
                                  "
                                >
                                  <div class="flex items-center gap-2.5 min-w-0">
                                    @if (weaponRenderIconUrl(slot); as icon) {
                                      <img
                                        [src]="icon"
                                        [alt]="slot.build.name"
                                        class="h-8 w-8 object-contain flex-shrink-0"
                                      />
                                    }
                                    <div class="min-w-0">
                                      <p
                                        class="text-xs font-medium text-[var(--color-text)] truncate"
                                      >
                                        {{ slot.build.name }}
                                      </p>
                                      @if (slotParticipant(slot); as occupant) {
                                        <p class="text-xs text-[var(--color-text)] truncate">
                                          {{ occupant.username }}
                                        </p>
                                      } @else {
                                        <p
                                          class="text-[0.625rem] text-[var(--color-text-disabled)] italic"
                                        >
                                          + {{ t('events.detail.seat_empty') }}
                                        </p>
                                      }
                                    </div>
                                  </div>

                                  @if (canManageParticipants()) {
                                    <button
                                      type="button"
                                      class="btn btn--ghost btn--sm p-1 text-xs"
                                      (click)="startSwapFromSlot(slot)"
                                    >
                                      &harr;
                                    </button>
                                  }
                                </div>
                              }
                            </div>
                          </div>
                        }
                      </div>
                    }

                    <!-- VIEW 3: TABLE VIEW -->
                    @if (rosterView() === 'table') {
                      <div
                        class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl"
                      >
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
                          <ng-template dataTableCell="specialization_level" let-row>
                            @if (selectedSpecializationKey()) {
                              <span
                                class="font-mono font-semibold"
                                [class.text-[var(--color-success)]]="
                                  participantSpecLevel(row) >= 100
                                "
                                [class.text-[var(--color-warning)]]="
                                  participantSpecLevel(row) > 0 && participantSpecLevel(row) < 100
                                "
                              >
                                {{ participantSpecLevel(row) }}/120
                              </span>
                            } @else {
                              <span class="text-[var(--color-text-disabled)]">—</span>
                            }
                          </ng-template>
                        </app-data-table>
                      </div>
                    }
                  }
                </div>

                <!-- BENCH & UNASSIGNED SIGNUPS TRAY -->
                <aside
                  class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl h-fit"
                >
                  <div
                    class="bg-[var(--color-surface-1)] px-4 py-3 border-b border-[var(--color-border)]"
                  >
                    <div class="flex items-center justify-between">
                      <h2
                        class="font-medium text-xs uppercase tracking-wider text-[var(--color-text)]"
                      >
                        {{ t('events.detail.unassigned_signups') }}
                      </h2>
                      <span class="chip chip--info font-mono text-xs">
                        {{ unassignedParticipants().length }} / {{ detail.participants.length }}
                      </span>
                    </div>
                    <p class="mt-1 text-[0.6875rem] text-[var(--color-text-secondary)]">
                      {{ t('events.detail.unassigned_hint') }}
                    </p>

                    <!-- Filter Chips -->
                    <div class="mt-2.5 flex flex-wrap gap-1">
                      <button
                        type="button"
                        class="px-2 py-0.5 text-[0.625rem] rounded transition-colors font-medium"
                        [class.bg-[var(--color-primary)]]="benchFilter() === 'all'"
                        [class.text-white]="benchFilter() === 'all'"
                        [class.bg-[var(--color-surface-2)]]="benchFilter() !== 'all'"
                        [class.text-[var(--color-text-secondary)]]="benchFilter() !== 'all'"
                        (click)="benchFilter.set('all')"
                      >
                        {{ t('events.detail.filter_all') }}
                      </button>
                      <button
                        type="button"
                        class="px-2 py-0.5 text-[0.625rem] rounded transition-colors font-medium"
                        [class.bg-[var(--color-primary)]]="benchFilter() === 'unassigned'"
                        [class.text-white]="benchFilter() === 'unassigned'"
                        [class.bg-[var(--color-surface-2)]]="benchFilter() !== 'unassigned'"
                        [class.text-[var(--color-text-secondary)]]="benchFilter() !== 'unassigned'"
                        (click)="benchFilter.set('unassigned')"
                      >
                        {{ t('events.detail.filter_unassigned') }}
                      </button>
                    </div>
                  </div>

                  <!-- Signups List -->
                  <div class="p-3 space-y-2 max-h-[36rem] overflow-y-auto">
                    @for (member of filteredBenchParticipants(); track member.user_id) {
                      <div
                        class="p-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-primary)] transition-all cursor-grab active:cursor-grabbing"
                        draggable="true"
                        (dragstart)="onBenchMemberDragStart($event, member)"
                      >
                        <div class="flex items-center justify-between gap-2">
                          <div class="flex items-center gap-2 min-w-0">
                            <div
                              class="h-5 w-5 rounded bg-[var(--color-surface-2)] flex items-center justify-center text-[0.625rem] font-mono font-medium flex-shrink-0 text-[var(--color-text)]"
                            >
                              {{ member.username.slice(0, 1).toUpperCase() }}
                            </div>
                            <span class="text-xs font-medium text-[var(--color-text)] truncate">
                              {{ member.username }}
                            </span>
                          </div>

                          <!-- Seat badge -->
                          @if (isParticipantAssigned(member.user_id); as seatSlot) {
                            <span
                              class="text-[0.625rem] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-success)] font-mono"
                            >
                              Seat #{{ seatSlot.slotIndex + 1 }}
                            </span>
                          } @else {
                            <span
                              class="text-[0.625rem] px-1.5 py-0.5 rounded bg-[var(--color-surface-2)] text-[var(--color-warning)] font-mono"
                            >
                              Bench
                            </span>
                          }
                        </div>

                        <div class="mt-2 space-y-1 text-[0.6875rem]">
                          <div
                            class="flex items-center justify-between text-[var(--color-text-secondary)]"
                          >
                            <span>1st:</span>
                            <span class="text-[var(--color-text)] truncate max-w-[12rem]">{{
                              member.primary_build_name || 'Build #' + member.primary_build_id
                            }}</span>
                          </div>
                          @if (member.secondary_build_name) {
                            <div
                              class="flex items-center justify-between text-[var(--color-text-secondary)]"
                            >
                              <span>2nd:</span>
                              <span
                                class="text-[var(--color-text-secondary)] truncate max-w-[12rem]"
                                >{{ member.secondary_build_name }}</span
                              >
                            </div>
                          }
                        </div>

                        @if (canManageParticipants() && swapSourceSlot(); as source) {
                          <button
                            type="button"
                            class="mt-2 w-full btn btn--primary btn--sm text-xs py-1"
                            (click)="assignMemberToSlot(source, member.user_id)"
                          >
                            Assign to {{ source.build.name }}
                          </button>
                        }
                      </div>
                    } @empty {
                      <p class="text-xs text-center py-6 text-[var(--color-text-secondary)]">
                        {{ t('events.detail.bench_empty') }}
                      </p>
                    }
                  </div>
                </aside>
              </div>
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
              <article
                class="surface p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
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
              <article
                class="surface p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
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
              <article
                class="surface p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <p class="event-detail__label">{{ t('events.detail.our_guild_loss') }}</p>
                <p class="event-detail__value mt-1 text-[var(--color-danger)] font-mono">
                  {{ formatAmount(eventLossEstimate().total_estimated_loss) }}
                </p>
                <p class="event-detail__sub">
                  {{ eventLossEstimate().priced_items }}/{{ eventLossEstimate().total_items }}
                  {{ t('events.detail.our_guild_loss_hint') }}
                </p>
              </article>

              <!-- Card 4: Net Financial Outcome (Loot vs Expenses) -->
              <article
                class="surface p-4 rounded-xl border bg-[var(--color-surface)]"
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
              <section
                class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)]"
              >
                <header class="event-detail__section-header">
                  <div class="flex items-center gap-2">
                    <h2>{{ t('events.detail.our_guild_losses_by_player') }}</h2>
                    <span class="chip chip--tonal font-mono text-xs">{{
                      eventLossEstimate().players.length
                    }}</span>
                  </div>
                </header>
                @if (eventLossEstimate().players.length > 0) {
                  <div class="p-3 space-y-1.5 max-h-96 overflow-y-auto">
                    @for (player of eventLossEstimate().players; track player.player_name) {
                      <div
                        class="flex items-center justify-between gap-3 p-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                      >
                        <div class="flex items-center gap-2.5 min-w-0">
                          <div
                            class="h-7 w-7 rounded bg-[var(--color-surface-2)] flex items-center justify-center text-xs font-mono text-[var(--color-text)] flex-shrink-0"
                          >
                            {{ player.player_name.slice(0, 1).toUpperCase() }}
                          </div>
                          <div class="min-w-0">
                            <p class="text-xs font-medium text-[var(--color-text)] truncate">
                              {{ player.player_name }}
                            </p>
                            <p class="text-[0.6875rem] text-[var(--color-text-secondary)]">
                              {{ player.deaths }}
                              {{ player.deaths === 1 ? 'death' : 'deaths' }} &middot;
                              {{ player.priced_items }}/{{ player.total_items }} items
                            </p>
                          </div>
                        </div>

                        <div class="text-right flex-shrink-0">
                          <span class="font-mono text-xs font-medium text-[var(--color-danger)]">
                            -{{ formatAmount(player.estimated_loss) }}
                          </span>
                          <span
                            class="block text-[0.625rem] font-mono text-[var(--color-text-secondary)]"
                          >
                            silver
                          </span>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <p class="event-detail__empty">{{ t('events.detail.no_opponents') }}</p>
                }
              </section>

              <!-- Right Column: Top Opponents -->
              <section
                class="card p-0 overflow-hidden border border-[var(--color-border)] rounded-xl bg-[var(--color-surface)]"
              >
                <header class="event-detail__section-header">
                  <div class="flex items-center gap-2">
                    <h2>{{ t('events.detail.opponents') }}</h2>
                    <span class="chip chip--tonal font-mono text-xs">{{
                      detail.stats.top_opponents.length
                    }}</span>
                  </div>
                </header>
                @if (detail.stats.top_opponents.length > 0) {
                  <div class="p-3 space-y-1.5 max-h-96 overflow-y-auto">
                    @for (
                      opponent of detail.stats.top_opponents;
                      track opponent.guild_id || opponent.guild_name
                    ) {
                      <div
                        class="flex items-center justify-between gap-3 p-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                      >
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center justify-between mb-1">
                            <span class="text-xs font-medium text-[var(--color-text)] truncate">
                              {{ opponent.guild_name || t('common.none') }}
                            </span>
                            <span
                              class="text-[0.6875rem] font-mono text-[var(--color-text-secondary)]"
                            >
                              {{ formatCompact(opponent.guild_kill_fame) }} vs
                              {{ formatCompact(opponent.opponent_kill_fame) }}
                            </span>
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
                  <p class="event-detail__empty">{{ t('events.detail.no_opponents') }}</p>
                }
              </section>
            </div>
          }

          <!-- ================= TAB 3: BATTLES & COMBAT LOGS ================= -->
          @case ('battles') {
            <div class="space-y-4">
              <!-- Battles Management Bar -->
              <section
                class="card p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="flex items-center gap-3">
                    <h2
                      class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]"
                    >
                      Fight {{ detail.fights.length }} · {{ t('events.detail.battles') }} ({{
                        detail.battles.length
                      }})
                    </h2>
                    <span class="font-mono text-xs text-[var(--color-text-secondary)]">
                      {{ detail.stats.wins }}W / {{ detail.stats.losses }}L
                    </span>
                    <span class="font-mono text-xs text-[var(--color-danger)]">
                      Combat Loss: -{{ formatAmount(eventLossEstimate().total_estimated_loss) }}
                    </span>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    @if (detail.battles.length > 0) {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm text-xs"
                        (click)="openBattleGroup(detail)"
                      >
                        {{ t('battles.group_selected') }}
                      </button>
                    }
                    @if (canEdit()) {
                      <button
                        type="button"
                        class="btn btn--tonal btn--sm text-xs"
                        (click)="toggleBattleLinkForm()"
                      >
                        {{
                          showBattleLinkForm()
                            ? t('common.close')
                            : t('events.detail.manage_battles')
                        }}
                      </button>
                    }
                  </div>
                </div>

                @if (showBattleLinkForm()) {
                  <form
                    class="grid gap-3 p-3 mt-3 bg-[var(--color-surface-1)] rounded-lg border border-[var(--color-border)]"
                    (submit)="onBattleLinksSubmit($event)"
                  >
                    <div>
                      <div class="flex justify-between items-center mb-2">
                        <span class="label font-medium text-xs">{{
                          t('events.detail.battle_ids')
                        }}</span>
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-xs"
                          (click)="showBattleSearch.set(true)"
                        >
                          + {{ t('events.detail.add_battle') }}
                        </button>
                      </div>

                      <div class="flex flex-col gap-2">
                        @for (link of draftBattleLinks(); track link.id) {
                          <div class="flex items-center gap-2">
                            <div
                              class="flex-1 input flex items-center bg-[var(--color-surface)] text-xs truncate"
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
                        }
                        @if (draftBattleLinks().length === 0) {
                          <p class="text-xs text-[var(--color-text-secondary)]">
                            {{ t('events.detail.no_battles_linked') }}
                          </p>
                        }
                      </div>
                    </div>

                    <div class="flex justify-end gap-2">
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        (click)="toggleBattleLinkForm()"
                      >
                        {{ t('common.cancel') }}
                      </button>
                      <button
                        type="submit"
                        class="btn btn--primary btn--sm"
                        [disabled]="battleLinksSaving()"
                      >
                        {{ t('common.save') }}
                      </button>
                    </div>
                  </form>
                }
              </section>

              @if (detail.fights.length > 0) {
                <section class="space-y-2" aria-label="Canonical fights">
                  @for (fight of detail.fights; track fight.id) {
                    @let metrics = fightMetrics(fight, detail.battles);
                    <article
                      class="card p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
                    >
                      <div class="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 class="font-medium">Fight #{{ fight.id }}</h3>
                          <p class="text-xs text-[var(--color-text-secondary)]">
                            {{ formatDate(fight.started_at) }} · {{ fight.grouping_method }}
                            @if (fight.needs_review) {
                              · review needed
                            }
                          </p>
                        </div>
                        <button
                          type="button"
                          class="btn btn--primary btn--sm"
                          (click)="openFight(fight)"
                        >
                          Open Fight
                        </button>
                      </div>

                      <div
                        class="grid grid-cols-2 gap-3 pt-3 mt-3 border-t border-[var(--color-border)] sm:grid-cols-3 xl:grid-cols-6"
                      >
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <p class="event-detail__label">{{ t('battles.outcome') }}</p>
                          <span
                            class="chip mt-1 font-mono text-[0.6875rem]"
                            [class.chip--success]="metrics.outcome === 'victory'"
                            [class.chip--error]="metrics.outcome === 'defeat'"
                          >
                            {{ fightOutcomeLabel(metrics.outcome) }}
                          </span>
                        </div>
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <p class="event-detail__label">{{ t('battles.segments') }}</p>
                          <p class="event-detail__value-sm mt-1">{{ metrics.segments }}</p>
                        </div>
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <p class="event-detail__label">Confidence</p>
                          <p class="event-detail__value-sm mt-1">
                            {{ formatPercent(fight.grouping_confidence) }}
                          </p>
                        </div>
                        @if (metrics.players !== null) {
                          <div
                            class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                          >
                            <p class="event-detail__label">{{ t('battles.players') }}</p>
                            <p class="event-detail__value-sm mt-1">
                              {{ formatNumber(metrics.players) }}
                            </p>
                          </div>
                        }
                        @if (metrics.kills !== null) {
                          <div
                            class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                          >
                            <p class="event-detail__label">{{ t('battles.kills') }}</p>
                            <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                              {{ formatNumber(metrics.kills) }}
                            </p>
                          </div>
                        }
                        @if (metrics.fame !== null) {
                          <div
                            class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                          >
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
                    <article
                      class="card p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-surface-3)] transition-colors"
                    >
                      <div
                        class="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]"
                      >
                        <div class="flex items-center gap-2.5 flex-wrap">
                          <span
                            class="chip font-mono text-xs font-medium"
                            [class.chip--success]="battle.is_win"
                            [class.chip--error]="!battle.is_win"
                          >
                            {{ battle.is_win ? 'VICTORY' : 'DEFEAT' }}
                          </span>
                          <a
                            class="font-mono text-xs text-[var(--color-primary)] font-medium hover:underline"
                            [routerLink]="['/battles', battle.albionbb_battle_id]"
                          >
                            Battle #{{ battle.albionbb_battle_id }}
                          </a>
                          <span class="text-xs text-[var(--color-text-secondary)]">
                            &middot; {{ formatDate(battle.battle_started_at) }}
                          </span>
                          @if (battle.opponent_guild_name) {
                            <span class="text-xs font-medium text-[var(--color-text)]">
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
                      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            Forces
                          </span>
                          <p class="font-mono text-sm font-medium text-[var(--color-text)] mt-0.5">
                            {{ battle.guild_players_count }}
                            <span class="text-[0.6875rem] text-[var(--color-text-secondary)]"
                              >vs</span
                            >
                            {{ battle.opponent_players_count ?? '—' }}
                          </p>
                          <p class="text-[0.625rem] text-[var(--color-text-secondary)]">
                            {{
                              battle.battle_total_players ??
                                battle.guild_players_count + (battle.opponent_players_count ?? 0)
                            }}
                            total in fight
                          </p>
                        </div>

                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            Kills &middot; Deaths
                          </span>
                          <p class="font-mono text-sm font-medium text-[var(--color-text)] mt-0.5">
                            <span class="text-[var(--color-success)]">{{
                              battle.guild_kills
                            }}</span>
                            /
                            <span class="text-[var(--color-danger)]">{{
                              battle.guild_deaths
                            }}</span>
                          </p>
                          <p class="text-[0.625rem] font-mono text-[var(--color-text-secondary)]">
                            K/D:
                            {{
                              (
                                battle.guild_kills /
                                (battle.guild_deaths > 0 ? battle.guild_deaths : 1)
                              ).toFixed(2)
                            }}
                          </p>
                        </div>

                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            Kill Fame
                          </span>
                          <p
                            class="font-mono text-sm font-medium text-[var(--color-success)] mt-0.5"
                          >
                            +{{ formatCompact(battle.guild_kill_fame) }}
                          </p>
                          <p class="text-[0.625rem] font-mono text-[var(--color-text-secondary)]">
                            Enemy: {{ formatCompact(battle.opponent_kill_fame ?? 0) }}
                          </p>
                        </div>

                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            Deaths & Losses
                          </span>
                          <p
                            class="font-mono text-sm font-medium text-[var(--color-danger)] mt-0.5"
                          >
                            {{ battle.guild_deaths }} deaths
                          </p>
                          <p class="text-[0.625rem] text-[var(--color-text-secondary)]">
                            Recorded in regear logs
                          </p>
                        </div>
                      </div>
                    </article>
                  }
                </div>
              } @else {
                <div
                  class="card p-8 text-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
                >
                  <app-empty-state [message]="t('events.detail.no_battles')" icon="swords" />
                </div>
              }
            </div>
          }

          <!-- ================= TAB 4: LOOT & SPLITS ================= -->
          @case ('splits') {
            <div class="space-y-4">
              <!-- Summary Strip -->
              <section
                class="card p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
              >
                <div class="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <h2 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                    {{ t('events.detail.splits') }} ({{ detail.splits.length }})
                  </h2>
                  <div class="flex items-center gap-2">
                    <span class="text-xs font-mono text-[var(--color-text-secondary)]">
                      Total Net:
                      <strong class="text-[var(--color-success)]">{{
                        formatAmount(detail.split_stats.completed_net_value)
                      }}</strong>
                    </span>
                    @if (canEdit()) {
                      <button
                        type="button"
                        class="btn btn--primary btn--sm text-xs"
                        (click)="showSplitSearch.set(true)"
                      >
                        + {{ t('events.detail.link_split') }}
                      </button>
                    }
                  </div>
                </div>

                @if (detail.split_stats.total_splits > 0) {
                  <div
                    class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-[var(--color-border)]"
                  >
                    <div
                      class="surface p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                    >
                      <p class="event-detail__label">{{ t('events.detail.split_total') }}</p>
                      <p class="event-detail__value-sm mt-1">
                        {{ detail.split_stats.total_splits }}
                      </p>
                    </div>
                    <div
                      class="surface p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                    >
                      <p class="event-detail__label">{{ t('events.detail.split_completed') }}</p>
                      <p class="event-detail__value-sm mt-1 text-[var(--color-success)]">
                        {{ detail.split_stats.completed_splits }}
                      </p>
                    </div>
                    <div
                      class="surface p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                    >
                      <p class="event-detail__label">{{ t('events.detail.split_pending') }}</p>
                      <p class="event-detail__value-sm mt-1 text-[var(--color-warning)]">
                        {{ detail.split_stats.pending_splits }}
                      </p>
                    </div>
                    <div
                      class="surface p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                    >
                      <p class="event-detail__label">{{ t('events.detail.split_net') }}</p>
                      <p
                        class="event-detail__value-sm mt-1 text-[var(--color-success)] font-medium font-mono"
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
                    <article
                      class="card p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-surface-3)] transition-colors"
                    >
                      <div
                        class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]"
                      >
                        <div class="flex items-center gap-2.5 flex-wrap">
                          <app-status-chip [value]="split.status" />
                          <a
                            class="text-sm font-medium text-[var(--color-text)] hover:underline"
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
                              class="btn btn--danger btn--sm"
                              (click)="unlinkSplit(split.id)"
                              [attr.aria-label]="t('events.detail.unlink_split')"
                            >
                              <app-icon name="close" size="0.875rem" />
                            </button>
                          }
                        </div>
                      </div>

                      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            {{ t('splits.estimated') }}
                          </span>
                          <p class="font-mono text-xs text-[var(--color-text)] mt-0.5">
                            {{ formatAmount(split.estimated_market_value) }}
                          </p>
                        </div>
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            {{ t('splits.repair_cost') }}
                          </span>
                          <p class="font-mono text-xs text-[var(--color-danger)] mt-0.5">
                            -{{ formatAmount(split.repair_value) }}
                          </p>
                        </div>
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            {{ t('splits.bags_value') }}
                          </span>
                          <p class="font-mono text-xs text-[var(--color-text)] mt-0.5">
                            +{{ formatAmount(split.bags_value) }}
                          </p>
                        </div>
                        <div
                          class="surface p-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)]"
                        >
                          <span
                            class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]"
                          >
                            {{ t('splits.net_value') }}
                          </span>
                          <p
                            class="font-mono text-xs font-medium text-[var(--color-success)] mt-0.5"
                          >
                            {{ formatAmount(netOfSplit(split)) }} ({{ split.participant_count }} p)
                          </p>
                        </div>
                      </div>
                    </article>
                  }
                </div>
              } @else {
                <div
                  class="card p-8 text-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
                >
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

    <!-- Quick Assign Modal for a Slot -->
    @if (quickAssignSlot(); as targetSlot) {
      <div
        class="modal-backdrop"
        (click)="closeQuickAssign()"
        (keydown.escape)="closeQuickAssign()"
      >
        <div class="modal-card" (click)="$event.stopPropagation()">
          <header class="event-detail__section-header">
            <div>
              <h2 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                {{ t('events.detail.quick_assign') }} &middot; {{ targetSlot.build.name }}
              </h2>
              <p class="text-xs text-[var(--color-text-secondary)] font-mono mt-0.5">
                {{ roleGlyph(targetSlot.role) }} &middot; {{ roleLabelName(targetSlot.role) }}
              </p>
            </div>
            <button type="button" class="btn btn--ghost btn--icon" (click)="closeQuickAssign()">
              <app-icon name="close" size="1rem" />
            </button>
          </header>

          <div class="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
            <!-- Best matching signups (Primary) -->
            <div>
              <span
                class="text-[0.6875rem] font-medium uppercase text-[var(--color-text-secondary)] tracking-wider"
              >
                {{ t('events.detail.primary_choice') }} ({{
                  primaryMatchParticipants(targetSlot.buildId).length
                }})
              </span>
              <div class="mt-1.5 space-y-1">
                @for (
                  member of primaryMatchParticipants(targetSlot.buildId);
                  track member.user_id
                ) {
                  <button
                    type="button"
                    class="w-full flex items-center justify-between p-2 rounded-md border border-[var(--color-border)] hover:border-[var(--color-success)] bg-[var(--color-surface-1)] transition-colors text-left"
                    (click)="assignMemberToSlot(targetSlot, member.user_id)"
                  >
                    <span class="text-xs font-medium text-[var(--color-text)]">{{
                      member.username
                    }}</span>
                    <span class="text-[0.625rem] text-[var(--color-success)] font-mono"
                      >Primary</span
                    >
                  </button>
                } @empty {
                  <p class="text-xs text-[var(--color-text-secondary)] italic py-1">
                    No primary signups for this build.
                  </p>
                }
              </div>
            </div>

            <!-- Secondary matching signups -->
            <div class="pt-2 border-t border-[var(--color-border)]">
              <span
                class="text-[0.6875rem] font-medium uppercase text-[var(--color-text-secondary)] tracking-wider"
              >
                {{ t('events.detail.secondary_choice') }} ({{
                  secondaryMatchParticipants(targetSlot.buildId).length
                }})
              </span>
              <div class="mt-1.5 space-y-1">
                @for (
                  member of secondaryMatchParticipants(targetSlot.buildId);
                  track member.user_id
                ) {
                  <button
                    type="button"
                    class="w-full flex items-center justify-between p-2 rounded-md border border-[var(--color-border)] hover:border-[var(--color-info)] bg-[var(--color-surface-1)] transition-colors text-left"
                    (click)="assignMemberToSlot(targetSlot, member.user_id)"
                  >
                    <span class="text-xs font-medium text-[var(--color-text)]">{{
                      member.username
                    }}</span>
                    <span class="text-[0.625rem] text-[var(--color-info)] font-mono"
                      >Secondary</span
                    >
                  </button>
                }
              </div>
            </div>

            <!-- All Other Registered Members -->
            <div class="pt-2 border-t border-[var(--color-border)]">
              <span
                class="text-[0.6875rem] font-medium uppercase text-[var(--color-text-secondary)] tracking-wider"
              >
                {{ t('events.detail.unassigned_signups') }}
              </span>
              <div class="mt-1.5 space-y-1">
                @for (member of unassignedParticipants(); track member.user_id) {
                  @if (
                    member.primary_build_id !== targetSlot.buildId &&
                    member.secondary_build_id !== targetSlot.buildId
                  ) {
                    <button
                      type="button"
                      class="w-full flex items-center justify-between p-2 rounded-md border border-[var(--color-border)] hover:border-[var(--color-primary)] bg-[var(--color-surface)] transition-colors text-left"
                      (click)="assignMemberToSlot(targetSlot, member.user_id)"
                    >
                      <span class="text-xs text-[var(--color-text)]">{{ member.username }}</span>
                      <span class="text-[0.625rem] text-[var(--color-text-secondary)] font-mono"
                        >Off-role</span
                      >
                    </button>
                  }
                }
              </div>
            </div>

            <div class="pt-3 border-t border-[var(--color-border)] flex justify-between gap-2">
              <button
                type="button"
                class="btn btn--outline btn--sm text-xs"
                (click)="openMemberSearchFromSlot(targetSlot)"
              >
                + {{ t('events.detail.search_member') }}
              </button>
              <button type="button" class="btn btn--ghost btn--sm" (click)="closeQuickAssign()">
                {{ t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    }

    @if (rosterRoleManagerOpen()) {
      <app-dialog title="Ruoli extra del roster" size="md" (closed)="closeRosterRoleManager()">
        <div class="grid gap-4">
          <section
            aria-labelledby="fill-role-heading"
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
          >
            <h2 id="fill-role-heading" class="text-sm font-medium text-[var(--color-text)]">
              Fill
            </h2>
            <p class="mt-1 text-xs text-[var(--color-text-secondary)]">
              Ruolo automatico con posti illimitati. Non può essere rimosso.
            </p>
          </section>

          <form class="grid gap-2" (submit)="addRosterRole($event)">
            <label for="extra-roster-build" class="label">Build per il nuovo ruolo</label>
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
                    {{ build.name }} · {{ roleLabelName(build.role) }}
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
              <p class="text-xs text-[var(--color-danger)]" aria-live="polite">
                {{ rosterRoleError() }}
              </p>
            }
          </form>

          <section aria-labelledby="extra-roles-heading">
            <h2 id="extra-roles-heading" class="label">Ruoli aggiunti per questo evento</h2>
            <div class="mt-2 grid gap-2">
              @for (role of extraRosterRoles(); track role.id) {
                <div
                  class="flex min-h-12 items-center justify-between gap-3 rounded-md border border-[var(--color-border)] px-3 py-2"
                >
                  <span class="text-sm text-[var(--color-text)]">{{ role.name }}</span>
                  <button
                    type="button"
                    class="btn btn--danger btn--sm"
                    (click)="removeRosterRole(role)"
                    [disabled]="rosterRoleSaving()"
                  >
                    Rimuovi
                  </button>
                </div>
              } @empty {
                <p class="text-xs text-[var(--color-text-secondary)]">Nessun ruolo extra.</p>
              }
            </div>
          </section>
        </div>
      </app-dialog>
    }

    <!-- Search dialogs -->
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

    <!-- Assign builds dialog for manually added member -->
    @if (draftMember(); as member) {
      <div class="modal-backdrop" (click)="closeMemberForm()" (keydown.escape)="closeMemberForm()">
        <div
          #assignBuildsPanel
          class="modal-card"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          (click)="$event.stopPropagation()"
        >
          <header class="event-detail__section-header">
            <h2>{{ t('events.detail.assign_builds') }} &middot; {{ member.title }}</h2>
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
              <p class="text-xs" style="color: var(--color-text-secondary)">
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
                      {{ entry.build.name }} &middot; {{ roleLabelName(entry.build.role) }}
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
              <p class="text-xs" style="color: var(--color-danger)">{{ memberError() }}</p>
            }
            <div class="flex justify-end gap-2">
              <button type="button" class="btn btn--ghost btn--sm" (click)="closeMemberForm()">
                {{ t('common.cancel') }}
              </button>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="memberSaving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- Confirmation Dialog -->
    @if (pendingConfirm(); as confirm) {
      <app-dialog [title]="confirmTitle(confirm)" size="sm" (closed)="cancelConfirm()">
        <p>{{ confirmMessage(confirm) }}</p>
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
  `,
  styles: `
    @layer components {
      .event-detail__label {
        color: var(--color-text-secondary);
        font-family: var(--font-universalsans);
        font-size: 0.6875rem;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .event-detail__value {
        color: var(--color-text);
        font-family: var(--font-berkeley-mono, monospace);
        font-size: clamp(1.25rem, 2vw, 1.5rem);
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      .event-detail__value-sm {
        color: var(--color-text);
        font-family: var(--font-berkeley-mono, monospace);
        font-size: 1rem;
        font-weight: 500;
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
      .event-detail__section-header h2 {
        color: var(--color-text);
        font-family: var(--font-universalsans);
        font-size: 0.75rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
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
      details > summary:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 3px;
      }
      @media (max-width: 40rem) {
        .event-detail__assignment-summary {
          align-items: flex-start;
          text-align: start;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .event-detail__fill-bar span {
          transition: none;
        }
      }
      .event-detail__tooltip {
        position: absolute;
        top: calc(100% + 0.4rem);
        left: 2.5rem;
        z-index: 50;
        min-width: 18rem;
        max-width: min(26rem, calc(100vw - 2rem));
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        padding: 0.6rem;
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
        grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
        gap: 0.4rem;
      }
      .event-detail__tooltip-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.2rem;
        text-align: center;
      }
      .event-detail__tooltip-item img {
        width: 2.5rem;
        height: 2.5rem;
        object-fit: contain;
        background: var(--color-surface-1);
        border-radius: 4px;
      }
      .event-detail__tooltip-item-placeholder {
        width: 2.5rem;
        height: 2.5rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.75rem;
        background: var(--color-surface-1);
        border-radius: 4px;
        color: var(--color-text-secondary);
      }
      .event-detail__tooltip-item-name {
        font-size: 0.625rem;
        color: var(--color-text);
        word-break: break-word;
      }
      .event-detail__tooltip-empty {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(8, 9, 10, 0.75);
        backdrop-filter: blur(2px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
        padding: 1rem;
      }
      .modal-card {
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 12px;
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
  private readonly realtimeRoster = inject(RealtimeRosterService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);
  private readonly destroyRef = inject(DestroyRef);
  private eventId = 0;

  protected readonly event = signal<EventDetailView | null>(null);
  protected readonly eventLossEstimate = signal<BattleLossEstimate>(emptyLossEstimate());
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly canEdit = signal(false);
  protected readonly showEditForm = signal(false);
  protected readonly tab = signal<EventDetailTab>('roster');
  protected readonly pendingConfirm = signal<PendingConfirm | null>(null);
  protected readonly saving = signal(false);

  // Live timer tick for countdown
  protected readonly currentTime = signal<number>(Date.now());

  // Roster Builder Interactive Signals
  protected readonly rosterView = signal<'parties' | 'roles' | 'table'>('parties');
  protected readonly benchFilter = signal<'all' | 'unassigned'>('all');
  protected readonly swapSourceSlot = signal<CompSlotRow | null>(null);
  protected readonly quickAssignSlot = signal<CompSlotRow | null>(null);
  protected readonly autoFilling = signal(false);
  protected readonly dragOverSlotKey = signal<string | null>(null);
  protected readonly draggedMember = signal<EventParticipant | null>(null);
  protected readonly specializationCatalog = signal<OpenAlbionItem[]>([]);
  protected readonly selectedSpecializationKey = signal('');

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
  protected readonly draftScheduledAt = signal('');
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
  protected readonly allBuilds = signal<BuildSummary[]>([]);
  protected readonly rosterRoleManagerOpen = signal(false);
  protected readonly rosterRoleSaving = signal(false);
  protected readonly rosterRoleError = signal<string | null>(null);
  protected readonly draftRosterRoleBuildId = signal('');
  protected readonly draftPrimaryBuildId = signal('');
  protected readonly draftSecondaryBuildId = signal('');

  protected readonly canManageParticipants = computed(() => {
    const detail = this.event();
    const userId = this.auth.profile()?.user_id ?? null;
    if (userId === null) return false;
    return this.canManage() || detail?.created_by === userId;
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
  protected readonly rosterSnapshotLoading = signal(false);
  protected readonly rosterAnnouncement = signal('');

  protected readonly slotAssignments = signal<Map<string, number | null>>(new Map());
  protected readonly slotSavingKey = signal<string | null>(null);
  protected readonly slotRemovingKey = signal<string | null>(null);
  protected readonly buildDetails = signal<Map<number, BuildDetail>>(new Map());
  protected readonly hoveredSlotKey = signal<string | null>(null);
  protected readonly pinnedSlotKey = signal<string | null>(null);

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
        seats: [...seats].sort((left, right) => left.position - right.position),
      }));
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

  protected readonly participantsByRole = computed<RoleGrouping[]>(() => {
    const detail = this.event();
    if (!detail) return [];
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
      if (participant.primary_build_id === null) {
        continue;
      }
      const entry = index.get(participant.primary_build_id);
      const role = entry?.build.role ?? 'dps';
      ensureGroup(role).participants.push(participant);
    }

    return ROLE_ORDER.map((role) => groups.get(role)).filter(
      (group): group is RoleGrouping => !!group,
    );
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

  /**
   * Group composition slots into 20-man Parties (Party 1, Party 2, Party 3, etc.)
   */
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
    if (detail.status === 'stopped' || detail.status === 'auto_stopped') {
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

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    this.canEdit.set(this.auth.hasPermission('events.manage'));
    this.route.paramMap.subscribe((params) => {
      const id = params.get('eventId');
      if (id) {
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
      void this.loadRosterSnapshot();
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
      await this.load();
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
      await this.load();
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

  protected rosterSeatPartyNumber(seat: EventRosterSeat): number {
    return seat.party_number;
  }

  protected rosterSeatPosition(seat: EventRosterSeat): number {
    return seat.position;
  }

  protected rosterSeatRoleLabel(seat: EventRosterSeat): string {
    return this.roleLabelName(seat.role);
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

  protected rosterItemSpells(item: BuildItemSlot): string {
    const active = Object.values(item.spells?.active ?? {});
    const passive = Object.values(item.spells?.passive ?? {});
    return [...active, ...passive].join(', ');
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

  protected slotAssignment(slot: CompSlotRow): number | null {
    return this.resolvedAssignments().get(slot.key) ?? null;
  }

  protected slotParticipant(slot: CompSlotRow): EventParticipant | null {
    const userId = this.slotAssignment(slot);
    if (userId === null) return null;
    return this.event()?.participants.find((p) => p.user_id === userId) ?? null;
  }

  protected isParticipantAssigned(userId: number): CompSlotRow | null {
    for (const [key, assignedUserId] of this.resolvedAssignments()) {
      if (assignedUserId === userId) {
        return this.compSlots().find((s) => s.key === key) ?? null;
      }
    }
    return null;
  }

  protected groupRoleFilledCount(group: CompSlotGroup): number {
    let count = 0;
    for (const slot of group.slots) {
      if (this.slotAssignment(slot) !== null) count++;
    }
    return count;
  }

  protected primaryMatchParticipants(buildId: number): EventParticipant[] {
    return (this.event()?.participants ?? []).filter((p) => p.primary_build_id === buildId);
  }

  protected secondaryMatchParticipants(buildId: number): EventParticipant[] {
    return (this.event()?.participants ?? []).filter((p) => p.secondary_build_id === buildId);
  }

  protected openQuickAssign(slot: CompSlotRow): void {
    this.quickAssignSlot.set(slot);
  }

  protected closeQuickAssign(): void {
    this.quickAssignSlot.set(null);
  }

  protected openMemberSearchFromSlot(slot: CompSlotRow): void {
    this.pendingAddSlotBuildId.set(slot.buildId);
    this.closeQuickAssign();
    this.openMemberSearch();
  }

  protected startSwapFromSlot(slot: CompSlotRow): void {
    this.swapSourceSlot.set(slot);
  }

  protected cancelSwapMode(): void {
    this.swapSourceSlot.set(null);
  }

  /**
   * Click-to-Swap or Click-to-Move handler.
   */
  protected async handleSlotClick(targetSlot: CompSlotRow): Promise<void> {
    const sourceSlot = this.swapSourceSlot();
    if (!sourceSlot || sourceSlot.key === targetSlot.key) {
      this.swapSourceSlot.set(null);
      return;
    }

    const sourceUserId = this.slotAssignment(sourceSlot);
    const targetUserId = this.slotAssignment(targetSlot);
    const detail = this.event();
    if (!detail || sourceUserId === null) {
      this.swapSourceSlot.set(null);
      return;
    }

    this.swapSourceSlot.set(null);
    this.slotSavingKey.set(targetSlot.key);

    try {
      if (targetUserId === null) {
        // Move source player to empty target slot
        await firstValueFrom(
          this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${sourceUserId}`, {
            primary_build_id: targetSlot.buildId,
          }),
        );
        this.toasts.success(this.t('events.detail.participant_updated'));
      } else {
        // Swap both players
        await Promise.all([
          firstValueFrom(
            this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${sourceUserId}`, {
              primary_build_id: targetSlot.buildId,
            }),
          ),
          firstValueFrom(
            this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${targetUserId}`, {
              primary_build_id: sourceSlot.buildId,
            }),
          ),
        ]);
        this.toasts.success(this.t('events.detail.participant_updated'));
      }
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.slotSavingKey.set(null);
    }
  }

  /**
   * Assigns a specific member to a slot.
   */
  protected async assignMemberToSlot(slot: CompSlotRow, userId: number): Promise<void> {
    const detail = this.event();
    if (!detail) return;
    this.closeQuickAssign();
    this.swapSourceSlot.set(null);
    this.slotSavingKey.set(slot.key);

    try {
      const updated = await firstValueFrom(
        this.api.put<EventDetailView>(`api/events/${detail.id}/participants/${userId}`, {
          primary_build_id: slot.buildId,
        }),
      );
      this.event.set(updated);
      await this.loadRosterSnapshot();
      this.toasts.success(this.t('events.detail.participant_updated'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.slotSavingKey.set(null);
    }
  }

  /**
   * Drag and drop handlers for comp slots and bench
   */
  protected onBenchMemberDragStart(event: DragEvent, member: EventParticipant): void {
    this.draggedMember.set(member);
    event.dataTransfer?.setData('text/plain', String(member.user_id));
  }

  protected onSlotDragOver(event: DragEvent, slot: CompSlotRow): void {
    event.preventDefault();
    this.dragOverSlotKey.set(slot.key);
  }

  protected onSlotDragLeave(slot: CompSlotRow): void {
    if (this.dragOverSlotKey() === slot.key) {
      this.dragOverSlotKey.set(null);
    }
  }

  protected async onSlotDrop(event: DragEvent, slot: CompSlotRow): Promise<void> {
    event.preventDefault();
    this.dragOverSlotKey.set(null);
    const member = this.draggedMember();
    this.draggedMember.set(null);
    if (!member) return;

    await this.assignMemberToSlot(slot, member.user_id);
  }

  /**
   * Auto-assigns registered participants to vacant comp slots matching their Primary / Secondary builds.
   */
  protected async autoFillRoster(): Promise<void> {
    const detail = this.event();
    if (!detail) return;

    const unassigned = [...this.unassignedParticipants()];
    if (unassigned.length === 0) return;

    this.autoFilling.set(true);
    const requests: Promise<unknown>[] = [];

    // First pass: match primary builds
    for (const slot of this.compSlots()) {
      if (this.slotAssignment(slot) !== null) continue;
      const matchIndex = unassigned.findIndex((u) => u.primary_build_id === slot.buildId);
      if (matchIndex !== -1) {
        const matched = unassigned.splice(matchIndex, 1)[0];
        requests.push(
          firstValueFrom(
            this.api.put<EventDetailView>(
              `api/events/${detail.id}/participants/${matched.user_id}`,
              {
                primary_build_id: slot.buildId,
              },
            ),
          ),
        );
      }
    }

    // Second pass: match secondary builds
    for (const slot of this.compSlots()) {
      if (this.slotAssignment(slot) !== null) continue;
      const matchIndex = unassigned.findIndex((u) => u.secondary_build_id === slot.buildId);
      if (matchIndex !== -1) {
        const matched = unassigned.splice(matchIndex, 1)[0];
        requests.push(
          firstValueFrom(
            this.api.put<EventDetailView>(
              `api/events/${detail.id}/participants/${matched.user_id}`,
              {
                primary_build_id: slot.buildId,
              },
            ),
          ),
        );
      }
    }

    try {
      await Promise.allSettled(requests);
      await this.load();
      this.toasts.success(this.t('events.detail.auto_fill_success'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.autoFilling.set(false);
    }
  }

  /**
   * Generates clean markdown formatted text of the parties & player assignments for Discord.
   */
  protected copyRosterForDiscord(): void {
    const detail = this.event();
    if (!detail) return;

    const compName = detail.active_comp_name || detail.comp_name || 'Composition';
    const eventDate = new Date(detail.event_date_utc).toUTCString();
    const cta = detail.call_to_arms ? ' [CALL TO ARMS]' : '';

    let md = `**${detail.title.toUpperCase()}${cta}**\n`;
    md += `Date: **${eventDate}** | Comp: **${compName}** (${this.filledSlotsCount()}/${this.compSlots().length})\n\n`;

    const parties = this.compParties();
    parties.forEach((party) => {
      md += `**PARTY ${party.partyNumber} (${party.filledCount}/${party.totalCount})**\n`;
      party.slots.forEach((slot, idx) => {
        const occupant = this.slotParticipant(slot);
        const slotNum = (party.partyNumber - 1) * 5 + idx + 1;
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

  protected requestClearAll(): void {
    this.pendingConfirm.set({ kind: 'clear-all' });
  }

  protected async clearSlot(slot: CompSlotRow): Promise<void> {
    const userId = this.slotAssignment(slot);
    if (userId === null) return;
    const participant = this.slotParticipant(slot);
    if (participant) {
      this.pendingConfirm.set({
        kind: 'remove-participant',
        userId,
        username: participant.username,
        slotKey: slot.key,
      });
    }
  }

  private async performClearSlot(slotKey?: string, userId?: number): Promise<void> {
    const detail = this.event();
    if (!detail || !userId) return;
    if (slotKey) this.slotRemovingKey.set(slotKey);
    try {
      const updated = await firstValueFrom(
        this.api.delete<EventDetailView>(`api/events/${detail.id}/participants/${userId}`),
      );
      if (updated) {
        this.event.set(updated);
        await this.loadRosterSnapshot();
      } else {
        await this.load();
      }
      this.toasts.success(this.t('events.detail.participant_removed'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      if (slotKey) this.slotRemovingKey.set(null);
    }
  }

  protected async performClearAll(): Promise<void> {
    const detail = this.event();
    if (!detail) return;
    const requests = detail.participants.map((p) =>
      firstValueFrom(
        this.api.delete<EventDetailView>(`api/events/${detail.id}/participants/${p.user_id}`),
      ),
    );
    try {
      await Promise.allSettled(requests);
      await this.load();
      this.toasts.success(this.t('events.detail.all_cleared'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected onSlotHover(slot: CompSlotRow): void {
    this.hoveredSlotKey.set(slot.key);
  }

  protected onSlotLeave(): void {
    this.hoveredSlotKey.set(null);
  }

  protected toggleSlotTooltip(slot: CompSlotRow): void {
    this.pinnedSlotKey.update((current) => (current === slot.key ? null : slot.key));
  }

  protected slotTooltipItems(buildId: number): BuildItemSlot[] {
    const detail = this.buildDetails().get(buildId);
    if (!detail) return [];
    return [...detail.items].sort(sortBySlotOrder);
  }

  protected slotTooltipVisible(slot: CompSlotRow): boolean {
    const isActive = this.hoveredSlotKey() === slot.key || this.pinnedSlotKey() === slot.key;
    return isActive && this.buildDetails().has(slot.buildId);
  }

  protected weaponRenderIconUrl(slot: CompSlotRow): string {
    const weapon = this.buildWeaponByBuildId().get(slot.buildId);
    return weapon ? this.renderItemIconUrl(weapon) : '';
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
      if (filter.search) params['username'] = filter.search;
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

  protected onMemberSelected(option: SearchDialogOption): void {
    this.draftMember.set(option);
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
    if (!detail || !member) return;
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
      await this.loadRosterSnapshot();
      this.closeMemberForm();
      this.toasts.success(this.t('events.detail.participant_added'));
    } catch (error) {
      this.memberError.set(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.memberSaving.set(false);
    }
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

  protected cancelConfirm(): void {
    this.pendingConfirm.set(null);
  }

  protected confirmTitle(confirm: PendingConfirm): string {
    switch (confirm.kind) {
      case 'delete':
        return this.t('events.detail.delete');
      case 'stop':
        return this.t('events.stop');
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
      case 'unlink-split':
        await this.performUnlinkSplit(confirm.splitId);
        break;
      case 'clear-all':
        await this.performClearAll();
        break;
      case 'remove-participant':
        await this.performClearSlot(confirm.slotKey, confirm.userId);
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
      const d = new Date(detail.event_date_utc);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      this.draftScheduledAt.set(d.toISOString().slice(0, 16));
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

  protected onScheduledAtChange(event: Event): void {
    this.draftScheduledAt.set((event.target as HTMLInputElement).value);
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

    const request: UpdateEventRequest = { title };
    const description = this.draftDescription().trim();
    request.description = description || undefined;
    request.call_to_arms = this.draftCallToArms();
    request.regear = this.draftRegear();
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
    if (!detail) return;

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
      await this.loadRosterSnapshot();
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
        await this.loadRosterSnapshot();
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

  protected roleChip(role: BuildRole): string {
    return ROLE_CHIP[role];
  }

  protected roleGlyph(role: BuildRole): string {
    return ROLE_GLYPH[role] ?? '•';
  }

  protected slotGlyph(slot: BuildSlot): string {
    return SLOT_GLYPH[slot] ?? '•';
  }

  protected slotLabel(slot: BuildSlot): string {
    return SLOT_LABELS[slot] ?? slot;
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

  protected async load(): Promise<void> {
    if (!this.eventId) return;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(
        this.api.get<EventDetailView>(`api/events/${this.eventId}`),
      );
      this.event.set(detail);
      this.realtimeRoster.connect(this.eventId);
      this.eventLossEstimate.set(detail.estimated_losses ?? emptyLossEstimate());
      void this.loadSpecializationCatalog();
      await Promise.all([
        this.loadRosterSnapshot(),
        this.loadActiveComp(),
        this.loadLinkedBattleLosses(detail),
      ]);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadRosterSnapshot(): Promise<void> {
    this.rosterSnapshotLoading.set(true);
    try {
      const roster = await firstValueFrom(
        this.api.get<EventRosterView>(`api/events/${this.eventId}/roster`),
      );
      this.rosterSnapshot.set(roster);
      await this.preloadRosterBuildDetails(roster.seats.map((seat) => seat.build_id));
      const ownSeat = this.ownRosterSeat();
      this.rosterAnnouncement.set(
        ownSeat
          ? `Roster aggiornato. Il tuo incarico è ${this.rosterSeatRoleLabel(ownSeat)}, Party ${this.rosterSeatPartyNumber(ownSeat)}, posizione ${ownSeat.position}.`
          : this.isCurrentUserOnRosterBench()
            ? 'Roster aggiornato. Sei in bench, senza un posto assegnato.'
            : 'Roster aggiornato.',
      );
    } catch {
      this.rosterSnapshot.set(null);
      this.rosterAnnouncement.set('');
    } finally {
      this.rosterSnapshotLoading.set(false);
    }
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
      void this.preloadBuildDetails(rosterBuilds);
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

const SLOT_GLYPH: Readonly<Record<BuildSlot, string>> = {
  weapon: 'W',
  off_hand: 'O',
  head: 'H',
  armor: 'A',
  shoes: 'S',
  cape: 'C',
  bag: 'B',
  potion: 'P',
  food: 'F',
  mount: 'M',
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
