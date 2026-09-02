import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuildMember,
  EventView,
  MatchedParticipant,
  PaginatedData,
  SplitDetail,
  SplitIsland,
  SplitIslandCity,
  SplitParticipant,
  TransactionStatus,
  TransactionView,
  UpdateSplitRequest,
  UpdateTransactionRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  SearchDialog,
  type SearchDialogOption,
} from '../../shared/components/search-dialog/search-dialog';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

type DetailMode = 'view' | 'edit';

const DEFAULT_SPLIT_FEE = 20;

function parsePercentageInput(raw: string): number | null {
  const normalized = raw.trim().replace(/%\s*$/, '').replace(',', '.');
  if (!normalized || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * View-first split page. Officers can switch to edit only while the split
 * is still pending.
 */
@Component({
  selector: 'app-split-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    DataTableCell,
    Dialog,
    ErrorState,
    Icon,
    Loading,
    PageHeader,
    PageStack,
    RouterLink,
    SearchDialog,
    StatusChip,
  ],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed() || !split()) {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="reload()"
      />
    } @else {
      @if (split(); as detail) {
        <app-page-header [title]="detail.note || t('splits.untitled', { id: detail.id })">
          <a routerLink="/splits" class="btn btn--ghost btn--sm">
            <app-icon name="chevron-left" size="0.875rem" />
            {{ t('splits.detail.back') }}
          </a>
          @if (canEdit()) {
            <button type="button" class="btn btn--ghost btn--sm" (click)="toggleMode()">
              {{ mode() === 'edit' ? t('common.close') : t('common.edit') }}
            </button>
          }
          @if (detail.status === 'pending' && canAct()) {
            <button
              type="button"
              class="btn btn--primary btn--sm"
              (click)="showCompleteConfirmDialog.set(true)"
            >
              {{ t('splits.payout_complete') }}
            </button>
            <button
              type="button"
              class="btn btn--outline btn--sm"
              (click)="closeSplit('not-completed')"
            >
              {{ t('splits.mark_not_completed') }}
            </button>
            <button type="button" class="btn btn--danger btn--sm" (click)="closeSplit('lost')">
              {{ t('splits.mark_lost') }}
            </button>
          }
          @if (canDelete()) {
            <button type="button" class="btn btn--danger btn--sm" (click)="showDelete.set(true)">
              {{ t('common.delete') }}
            </button>
          }
        </app-page-header>

        <app-page-stack>
          <section class="card p-4 sm:p-5">
            <div class="mb-1.5 flex flex-wrap items-center gap-2">
              <app-status-chip [value]="detail.status" />
            </div>
            <p class="text-xs text-[var(--color-text-secondary)]">
              {{ t('splits.created_by', { name: detail.created_by_username }) }}
              &middot; {{ formatDate(detail.created_at) }}
              @if (detail.event_title && detail.event_id) {
                &middot; {{ t('splits.event_linked') }}:
                <a
                  class="text-primary no-underline hover:underline"
                  [routerLink]="['/events', detail.event_id]"
                >
                  {{ detail.event_title }}
                </a>
              }
              @if (detail.island_tab_id) {
                &middot; {{ locationLabel(detail) }}
              }
            </p>
          </section>

          @if (mode() === 'edit' && canEdit()) {
            <form id="edit-split-form" class="space-y-4" (submit)="onEditSubmit($event)">
              <div class="grid gap-4 lg:grid-cols-2">
                <!-- LEFT COLUMN: NOTE & FINANCIALS -->
                <div class="space-y-4">
                  <!-- Note & Location Card -->
                  <section class="card p-4 space-y-3">
                    <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                      {{ t('splits.location') }} &middot; {{ t('splits.note') }}
                    </h3>

                    <label class="block">
                      <span class="label font-medium text-xs">{{ t('common.name') }} / {{ t('splits.note') }}</span>
                      <input
                        class="input text-xs"
                        type="text"
                        [value]="editNote()"
                        (input)="onEditNoteChange($event)"
                      />
                    </label>

                    <div>
                      <span class="label font-medium text-xs">{{ t('splits.event_linked') }}</span>
                      <div class="flex items-center gap-2">
                        <div
                          class="input flex flex-1 items-center bg-[var(--color-surface-1)] text-xs truncate"
                        >
                          <span class="truncate">{{ editEventTitle() || t('splits.no_event') }}</span>
                        </div>
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-xs whitespace-nowrap"
                          (click)="showEventSearch.set(true)"
                        >
                          {{ t('splits.link_event') }}
                        </button>
                        @if (editEventId()) {
                          <button
                            type="button"
                            class="btn btn--danger btn--sm whitespace-nowrap"
                            [attr.aria-label]="t('splits.unlink_event')"
                            (click)="unlinkEditEvent()"
                          >
                            <app-icon name="close" size="0.875rem" />
                          </button>
                        }
                      </div>
                    </div>

                    <div class="grid gap-2 sm:grid-cols-2">
                      <label class="block">
                        <span class="label font-medium text-xs">{{ t('splits.island') }}</span>
                        <select
                          class="select text-xs"
                          [value]="editIslandId()"
                          (change)="onEditIslandChange($event)"
                        >
                          <option value="">{{ t('splits.pick_island') }}</option>
                          @for (island of islands(); track island.id) {
                            <option [value]="island.id">
                              {{ cityLabel(island.city) }} &middot; {{ island.name }}
                            </option>
                          }
                        </select>
                      </label>
                      <label class="block">
                        <span class="label font-medium text-xs">{{ t('splits.tab') }}</span>
                        <select
                          class="select text-xs"
                          [value]="editTabId()"
                          [disabled]="!editIslandId()"
                          (change)="onEditTabChange($event)"
                        >
                          <option value="">{{ t('splits.pick_tab') }}</option>
                          @for (tab of editIslandTabs(); track tab.id) {
                            <option [value]="tab.id">{{ tab.name }}</option>
                          }
                        </select>
                      </label>
                    </div>
                  </section>

                  <!-- Silver Breakdown & Live Computation -->
                  <section class="card p-4 space-y-3">
                    <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                      {{ t('splits.net_value') }}
                    </h3>

                    <div class="grid gap-2 sm:grid-cols-4">
                      <label class="block">
                        <span class="label font-medium text-[0.6875rem]">{{ t('splits.estimated') }}</span>
                        <input
                          class="input font-mono text-xs"
                          type="number"
                          min="0"
                          [value]="editEstimated()"
                          (input)="onEditEstimatedChange($event)"
                        />
                      </label>
                      <label class="block">
                        <span class="label font-medium text-[0.6875rem]">{{ t('splits.fee') }}</span>
                        <div class="flex items-center gap-1">
                          <input
                            class="input font-mono text-xs"
                            type="text"
                            inputmode="decimal"
                            [value]="editFeeInput()"
                            (input)="onEditFeeChange($event)"
                          />
                          <span class="text-xs text-[var(--color-text-secondary)] font-mono">%</span>
                        </div>
                      </label>
                      <label class="block">
                        <span class="label font-medium text-[0.6875rem]">{{ t('splits.repair_cost') }} (-)</span>
                        <input
                          class="input font-mono text-xs"
                          type="number"
                          min="0"
                          [value]="editRepair()"
                          (input)="onEditRepairChange($event)"
                        />
                      </label>
                      <label class="block">
                        <span class="label font-medium text-[0.6875rem]">{{ t('splits.bags_value') }} (+)</span>
                        <input
                          class="input font-mono text-xs"
                          type="number"
                          min="0"
                          [value]="editBags()"
                          (input)="onEditBagsChange($event)"
                        />
                      </label>
                    </div>

                    <div class="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-1)] flex items-center justify-between">
                      <div>
                        <span class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                          {{ t('splits.net_value') }}
                        </span>
                        <p class="text-[0.6875rem] text-[var(--color-text-secondary)] mt-0.5">
                          {{ formatAmount(editEstimated()) }} − {{ formatAmount(editEstimated() * editFee() / 100) }} ({{ editFee() }}%) − {{ formatAmount(editRepair()) }} + {{ formatAmount(editBags()) }}
                        </p>
                      </div>
                      <div class="text-right">
                        <span class="font-mono text-xl font-medium text-[var(--color-success)]">
                          {{ formatAmount(editNetPreview()) }}
                        </span>
                        <span class="block text-[0.6875rem] font-mono text-[var(--color-text-secondary)]">
                          silver
                        </span>
                      </div>
                    </div>
                  </section>
                </div>

                <!-- RIGHT COLUMN: ROSTER & WEIGHTS -->
                <section class="card p-4 space-y-3 flex flex-col justify-between">
                  <div class="space-y-3">
                    <div class="flex items-center justify-between gap-2 pb-2 border-b border-[var(--color-border)]">
                      <div class="flex items-center gap-2">
                        <h3 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                          {{ t('splits.roster_management') }} ({{ editParticipants().length }})
                        </h3>
                        <span
                          class="chip font-mono text-xs font-medium"
                          [class.chip--success]="editTotalWeight() === 100"
                          [class.chip--warning]="editTotalWeight() !== 100"
                        >
                          {{ editTotalWeight() }}%
                        </span>
                      </div>

                      <div class="flex items-center gap-1.5">
                        @if (editParticipants().length > 0) {
                          <button
                            type="button"
                            class="btn btn--outline btn--sm text-xs py-0.5 px-2"
                            (click)="distributeEditWeightsEvenly()"
                          >
                            {{ t('splits.distribute_evenly') }}
                          </button>
                        }
                        <button
                          type="button"
                          class="btn btn--primary btn--sm text-xs py-0.5 px-2"
                          (click)="showParticipantSearch.set(true)"
                        >
                          + {{ t('splits.add_participant') }}
                        </button>
                      </div>
                    </div>

                    <div class="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                      @for (participant of editParticipants(); track participant.user_id) {
                        <div class="flex items-center justify-between gap-2 p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]">
                          <div class="flex items-center gap-2 min-w-0">
                            <div class="h-6 w-6 rounded bg-[var(--color-surface-2)] flex items-center justify-center text-[0.6875rem] font-mono text-[var(--color-text)] flex-shrink-0">
                              {{ participant.username.slice(0, 1).toUpperCase() }}
                            </div>
                            <div class="min-w-0">
                              <p class="truncate text-xs font-medium text-[var(--color-text)]">
                                {{ participant.username }}
                              </p>
                              <p class="truncate text-[0.625rem] text-[var(--color-text-secondary)]">
                                {{ t('splits.share') }}:
                                <span class="font-mono text-[var(--color-success)]">
                                  {{
                                    formatAmount(
                                      estimatedShare(
                                        editNetPreview(),
                                        toNumber(participant.weight),
                                        editTotalWeight()
                                      )
                                    )
                                  }}
                                </span>
                              </p>
                            </div>
                          </div>

                          <div class="flex items-center gap-2 flex-shrink-0">
                            <div class="flex items-center gap-1">
                              <input
                                class="input font-mono text-xs text-right py-0.5 px-1 w-14"
                                type="text"
                                inputmode="decimal"
                                placeholder="12,33"
                                [value]="editWeightValue(participant)"
                                (input)="onEditWeightChange(participant.user_id, $event)"
                              />
                              <span class="text-xs text-[var(--color-text-secondary)] font-mono">%</span>
                            </div>
                            <button
                              type="button"
                              class="btn btn--ghost btn--sm p-1 text-xs text-[var(--color-danger)]"
                              (click)="removeEditParticipant(participant.user_id)"
                              [attr.aria-label]="t('splits.remove_participant')"
                            >
                              &times;
                            </button>
                          </div>
                        </div>
                      } @empty {
                        <p class="py-6 text-center text-xs text-[var(--color-text-secondary)]">
                          {{ t('splits.roster_empty') }}
                        </p>
                      }
                    </div>
                  </div>

                  <div class="flex justify-end gap-2 pt-3 border-t border-[var(--color-border)]">
                    <button type="button" class="btn btn--ghost btn--sm" (click)="cancelEdit()">
                      {{ t('common.cancel') }}
                    </button>
                    <button
                      type="submit"
                      class="btn btn--primary btn--sm"
                      [disabled]="saving() || editTotalWeight() !== 100"
                    >
                      {{ saving() ? t('common.loading') : t('common.save') }}
                    </button>
                  </div>
                </section>
              </div>
            </form>
          } @else {
            <section class="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <article class="surface p-3.5">
                <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.estimated') }}
                </p>
                <p class="font-mono text-base font-medium text-[var(--color-warning)] mt-1">
                  {{ formatAmount(detail.estimated_market_value) }}
                </p>
              </article>
              <article class="surface p-3.5">
                <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.fee') }}
                </p>
                <p class="font-mono text-base font-medium text-[var(--color-danger)] mt-1">
                  {{ formatAmount((toNumber(detail.estimated_market_value) - toNumber(detail.repair_value) + toNumber(detail.bags_value)) * toNumber(detail.fee ?? defaultFee) / 100) }} ({{ detail.fee ?? defaultFee }}%)
                </p>
              </article>
              <article class="surface p-3.5">
                <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.repair_cost') }}
                </p>
                <p class="font-mono text-base font-medium text-[var(--color-danger)] mt-1">
                  -{{ formatAmount(detail.repair_value) }}
                </p>
              </article>
              <article class="surface p-3.5">
                <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.bags_value') }}
                </p>
                <p class="font-mono text-base font-medium text-[var(--color-text)] mt-1">
                  +{{ formatAmount(detail.bags_value) }}
                </p>
              </article>
              <article
                class="surface p-3.5 border-[var(--color-success)]"
              >
                <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {{ t('splits.net_value') }}
                </p>
                <p class="font-mono text-base font-medium text-[var(--color-success)] mt-1">
                  {{ formatAmount(netOf(detail)) }}
                </p>
              </article>
            </section>

            <section
              class="surface overflow-hidden"
            >
              <header
                class="flex items-center justify-between border-b border-[var(--color-border)] p-3.5"
              >
                <h2 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                  {{ t('splits.participants') }} ({{ detail.participants.length }})
                </h2>
                <span
                  class="font-mono text-xs"
                  [class.text-[var(--color-warning)]]="detail.status === 'pending'"
                  [class.text-[var(--color-success)]]="detail.status !== 'pending'"
                >
                  {{
                    detail.status === 'pending' ? t('splits.pending_payout') : t('splits.paid_out')
                  }}
                </span>
              </header>
              <app-data-table
                [columns]="participantColumns"
                [rows]="detail.participants"
                [trackBy]="trackParticipant"
                [hideSearch]="true"
                emptyIcon="users"
                [emptyLabel]="'splits.roster_empty'"
              >
                <ng-template dataTableCell="username" let-row>
                  <div class="flex items-center gap-2">
                    <div class="h-6 w-6 rounded bg-[var(--color-surface-2)] flex items-center justify-center text-[0.6875rem] font-mono text-[var(--color-text)] flex-shrink-0">
                      {{ row.username.slice(0, 1).toUpperCase() }}
                    </div>
                    <span class="font-medium text-xs">{{ row.username }}</span>
                  </div>
                </ng-template>
                <ng-template dataTableCell="weight" let-row>
                  <span class="font-mono text-xs">{{ row.weight }}%</span>
                </ng-template>
                <ng-template dataTableCell="share" let-row>
                  <span class="font-mono text-xs font-medium text-[var(--color-success)]">
                    {{
                      formatAmount(
                        row.share_amount ??
                          estimatedShare(
                            netOf(detail),
                            toNumber(row.weight),
                            participantsTotalWeight(detail.participants)
                          )
                      )
                    }}
                  </span>
                </ng-template>
              </app-data-table>
            </section>

            @if (canViewSplitTransactions()) {
              <section class="surface overflow-hidden">
                <header class="flex items-center justify-between border-b border-[var(--color-border)] p-3.5">
                  <h2 class="text-xs font-medium uppercase tracking-wider text-[var(--color-text)]">
                    {{ t('splits.detail.transactionsTitle') }} ({{ splitTransactions().length }})
                  </h2>
                </header>
                <app-data-table
                  [columns]="transactionColumns()"
                  [rows]="splitTransactions()"
                  [loading]="transactionsLoading()"
                  [trackBy]="trackTransaction"
                  [hideSearch]="true"
                  emptyIcon="bank"
                  [emptyLabel]="'splits.detail.transactionsEmpty'"
                >
                  <ng-template dataTableCell="to_username" let-row>
                    <span class="text-xs font-medium">{{ row.to_username }}</span>
                  </ng-template>
                  <ng-template dataTableCell="amount" let-row>
                    <span class="font-mono text-xs font-medium">{{ formatAmount(row.amount) }}</span>
                  </ng-template>
                  <ng-template dataTableCell="status" let-row>
                    <app-status-chip [value]="row.status" />
                  </ng-template>
                  <ng-template dataTableCell="created_at" let-row>
                    <span class="text-xs" style="color: var(--color-text-secondary)">
                      {{ formatDate(row.created_at) }}
                    </span>
                  </ng-template>
                  @if (canEditTransactions()) {
                    <ng-template dataTableCell="actions" let-row>
                      <div class="flex justify-end">
                        <button
                          type="button"
                          class="btn btn--outline btn--sm text-xs py-0.5 px-2"
                          (click)="openEditTransaction(row)"
                        >
                          {{ t('common.edit') }}
                        </button>
                      </div>
                    </ng-template>
                  }
                </app-data-table>
              </section>
            }
          }
        </app-page-stack>
      }
    }

    @if (showCompleteConfirmDialog()) {
      <app-dialog
        [title]="t('splits.detail.confirmCompleteTitle')"
        [subtitle]="t('splits.detail.confirmCompleteSubtitle')"
        size="md"
        (closed)="showCompleteConfirmDialog.set(false)"
      >
        <div class="space-y-4">
          @if (split(); as detail) {
            <div
              class="rounded-xl p-3.5 border border-[var(--color-border)] bg-[var(--color-surface-2)] flex items-center justify-between"
            >
              <div>
                <p class="text-xs font-semibold uppercase text-[var(--color-text-secondary)]">
                  {{ t('splits.net_value') }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)]">
                  {{ detail.participants.length }} {{ t('splits.participants') }}
                </p>
              </div>
              <p class="font-mono text-2xl font-medium text-[var(--color-success)]">
                {{ formatAmount(netOf(detail)) }}
              </p>
            </div>

            <div
              class="rounded-xl border border-[var(--color-border)] overflow-hidden"
            >
              <div
                class="px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]"
              >
                {{ t('splits.roster_management') }}
              </div>
              <div class="max-h-60 overflow-y-auto divide-y border-[var(--color-border)]">
                @for (participant of detail.participants; track participant.user_id) {
                  <div
                    class="p-2.5 flex items-center justify-between gap-3 text-sm bg-[var(--color-surface-1)]"
                  >
                    <span class="font-medium text-xs text-[var(--color-text)]">
                      {{ participant.username }}
                    </span>
                    <div class="text-right">
                      <span class="font-mono text-xs font-medium text-[var(--color-success)]">
                        {{
                          formatAmount(
                            participant.share_amount ??
                              estimatedShare(
                                netOf(detail),
                                toNumber(participant.weight),
                                participantsTotalWeight(detail.participants)
                              )
                          )
                        }}
                      </span>
                      <span class="text-xs ml-1 font-mono text-[var(--color-text-secondary)]">
                        ({{ participant.weight }}%)
                      </span>
                    </div>
                  </div>
                }
              </div>
            </div>

            <p class="text-xs text-[var(--color-text-secondary)]">
              {{ t('splits.detail.confirmCompleteWarning') }}
            </p>
          }
        </div>

        <div dialogFooter class="flex justify-end gap-2">
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            (click)="showCompleteConfirmDialog.set(false)"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm flex items-center gap-2"
            [disabled]="saving()"
            (click)="executeCompleteSplit()"
          >
            <app-icon name="check" size="1rem" />
            {{ saving() ? t('common.loading') : t('splits.detail.confirmCompleteAction') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (showDelete()) {
      <app-dialog [title]="t('common.delete')" size="sm" (closed)="showDelete.set(false)">
        <p class="text-xs">{{ t('splits.confirm_delete') }}</p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="showDelete.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger btn--sm"
            [disabled]="saving()"
            (click)="confirmDelete()"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (editTransactionTarget(); as tx) {
      <app-dialog [title]="t('splits.detail.transactionsEdit')" size="sm" (closed)="closeEditTransaction()">
        <form id="edit-transaction-form" class="grid gap-4" (submit)="saveEditTransaction($event)">
          <p class="text-xs" style="color: var(--color-text-secondary)">{{ tx.to_username }}</p>
          <label class="block">
            <span class="label text-xs">{{ t('common.amount') }}</span>
            <input
              class="input text-xs"
              type="number"
              min="0.01"
              step="0.01"
              required
              [value]="editTransactionAmount() ?? ''"
              (input)="onEditTransactionAmount($event)"
            />
          </label>
          <label class="block">
            <span class="label text-xs">{{ t('common.status') }}</span>
            <select class="select text-xs" [value]="editTransactionStatus()" (change)="onEditTransactionStatus($event)">
              <option value="pending">{{ t('bank.status.pending') }}</option>
              <option value="requested">{{ t('bank.status.requested') }}</option>
              <option value="rejected">{{ t('bank.status.rejected') }}</option>
              <option value="withdrawn">{{ t('bank.status.withdrawn') }}</option>
              <option value="donated">{{ t('bank.status.donated') }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label text-xs">{{ t('admin.transactions.fields.type') }}</span>
            <input class="input text-xs" type="text" [value]="editTransactionType()" (input)="onEditTransactionType($event)" />
          </label>
        </form>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--ghost btn--sm" (click)="closeEditTransaction()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary btn--sm"
            form="edit-transaction-form"
            [disabled]="savingTransaction()"
          >
            {{ savingTransaction() ? t('common.loading') : t('common.save') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (showEventSearch()) {
      <app-search-dialog
        [title]="t('splits.link_event')"
        [options]="eventSearchOptions()"
        [loading]="eventSearchLoading()"
        [showDateFilters]="true"
        (filterChange)="onEventSearchFilter($event)"
        (select)="onEditEventSelect($event)"
        (close)="showEventSearch.set(false)"
      />
    }

    @if (showParticipantSearch()) {
      <app-search-dialog
        [title]="t('splits.add_participant')"
        [placeholder]="t('splits.search_roster')"
        [options]="participantSearchOptions()"
        [loading]="searchingRoster()"
        (filterChange)="onParticipantSearchFilter($event)"
        (select)="onParticipantSelect($event)"
        (close)="showParticipantSearch.set(false)"
      />
    }
  `,
})
export class SplitDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly split = signal<SplitDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly mode = signal<DetailMode>('view');
  protected readonly showDelete = signal(false);
  protected readonly showCompleteConfirmDialog = signal(false);
  protected readonly islands = signal<SplitIsland[]>([]);
  protected readonly defaultFee = DEFAULT_SPLIT_FEE;

  protected readonly editNote = signal('');
  protected readonly editEstimated = signal(0);
  protected readonly editFeeInput = signal(String(DEFAULT_SPLIT_FEE));
  protected readonly editRepair = signal(0);
  protected readonly editBags = signal(0);
  protected readonly editEventId = signal<number | null>(null);
  protected readonly editEventTitle = signal('');
  protected readonly editIslandId = signal('');
  protected readonly editTabId = signal('');
  protected readonly editParticipants = signal<SplitParticipant[]>([]);
  protected readonly editWeightInputs = signal<Record<number, string>>({});

  protected readonly showEventSearch = signal(false);
  protected readonly eventSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly eventSearchLoading = signal(false);
  protected readonly showParticipantSearch = signal(false);
  protected readonly participantSearchOptions = signal<SearchDialogOption[]>([]);
  protected readonly searchingRoster = signal(false);

  protected readonly splitTransactions = signal<TransactionView[]>([]);
  protected readonly transactionsLoading = signal(false);
  protected readonly editTransactionTarget = signal<TransactionView | null>(null);
  protected readonly editTransactionAmount = signal<number | null>(null);
  protected readonly editTransactionStatus = signal<TransactionStatus>('pending');
  protected readonly editTransactionType = signal('');
  protected readonly savingTransaction = signal(false);

  protected readonly trackParticipant = (row: SplitParticipant): number => row.user_id;

  protected readonly participantColumns: readonly DataTableColumn<SplitParticipant>[] = [
    { key: 'username', label: 'splits.player', accessor: (row) => row.username },
    { key: 'weight', label: 'splits.weight', align: 'right', accessor: (row) => row.weight },
    { key: 'share', label: 'splits.share', align: 'right', accessor: (row) => row.share_amount },
  ];

  protected readonly trackTransaction = (row: TransactionView): number => row.id;

  protected readonly transactionColumns = computed<DataTableColumn<TransactionView>[]>(() => {
    const base: DataTableColumn<TransactionView>[] = [
      { key: 'to_username', label: 'admin.transactions.fields.to', accessor: (row) => row.to_username },
      {
        key: 'amount',
        label: 'common.amount',
        align: 'right',
        accessor: (row) => Number(row.amount) || 0,
      },
      { key: 'status', label: 'common.status', accessor: (row) => row.status },
      { key: 'created_at', label: 'common.date', accessor: (row) => row.created_at },
    ];
    if (this.canEditTransactions()) {
      base.push({ key: 'actions', label: 'common.actions', align: 'right' });
    }
    return base;
  });

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly canAct = computed(() => this.auth.hasPermission('splits.edit'));
  protected readonly canDelete = computed(() => this.auth.hasPermission('splits.delete'));
  protected readonly canEdit = computed(() => this.canAct() && this.split()?.status === 'pending');
  protected readonly canViewSplitTransactions = computed(
    () => this.auth.hasPermission('bank.view_others') || this.auth.hasPermission('bank.withdraw.accept'),
  );
  protected readonly canEditTransactions = computed(() =>
    this.auth.hasPermission('bank.transactions.edit'),
  );
  protected readonly editFee = computed(() => parsePercentageInput(this.editFeeInput()) ?? DEFAULT_SPLIT_FEE);
  protected readonly editNetPreview = computed(() =>
    Math.max(
      0,
      this.editEstimated() - (this.editEstimated() * this.editFee()) / 100 - this.editRepair() + this.editBags(),
    ),
  );
  protected readonly editIslandTabs = computed(() => {
    const id = Number(this.editIslandId());
    return this.islands().find((island) => island.id === id)?.tabs ?? [];
  });

  constructor() {
    void this.loadIslands();
    void this.onEventSearchFilter({ search: '', dateFrom: '', dateTo: '' });
    this.route.paramMap.subscribe((params) => {
      const id = Number(params.get('splitId'));
      if (!Number.isFinite(id) || id <= 0) {
        this.loadFailed.set(true);
        this.split.set(null);
        return;
      }
      void this.load(id);
    });
  }

  protected reload(): void {
    const id = Number(this.route.snapshot.paramMap.get('splitId'));
    if (Number.isFinite(id) && id > 0) {
      void this.load(id);
    }
  }

  protected cityLabel(city: SplitIslandCity): string {
    return this.t(`splits.city.${city}` as TranslationKey);
  }

  protected locationLabel(split: SplitDetail): string {
    if (
      !split.island_tab_id ||
      !split.island_name ||
      !split.island_city ||
      !split.island_tab_name
    ) {
      return this.t('splits.no_location');
    }
    return `${this.cityLabel(split.island_city as SplitIslandCity)} · ${split.island_name} · ${split.island_tab_name}`;
  }

  protected netOf(split: SplitDetail): number {
    if (split.net_value !== null && split.net_value !== undefined) {
      return Number(split.net_value);
    }
    const estimated = Number(split.estimated_market_value);
    return Math.max(
      0,
      estimated - (estimated * Number(split.fee ?? DEFAULT_SPLIT_FEE)) / 100 - Number(split.repair_value) + Number(split.bags_value),
    );
  }

  protected editTotalWeight(): number {
    return this.editParticipants().reduce(
      (sum, participant) => sum + Number(participant.weight),
      0,
    );
  }

  /** Real sum of participant weights, used instead of assuming they already total 100. */
  protected participantsTotalWeight(participants: readonly SplitParticipant[]): number {
    return participants.reduce((sum, participant) => sum + this.toNumber(participant.weight), 0);
  }

  protected editWeightValue(participant: SplitParticipant): string {
    return this.editWeightInputs()[participant.user_id] ?? this.formatWeightInput(participant.weight);
  }

  protected toNumber(value: number | string | null | undefined): number {
    return Number(value) || 0;
  }

  protected estimatedShare(netValue: number, weight: number, totalWeight: number): number {
    if (totalWeight <= 0 || netValue <= 0) {
      return 0;
    }
    return Math.round(netValue * (weight / totalWeight) * 100) / 100;
  }

  protected toggleMode(): void {
    if (this.mode() === 'edit') {
      this.cancelEdit();
      return;
    }
    this.hydrateEdit();
    this.mode.set('edit');
  }

  protected cancelEdit(): void {
    this.mode.set('view');
    this.showEventSearch.set(false);
    this.showParticipantSearch.set(false);
  }

  protected onEditNoteChange(event: Event): void {
    this.editNote.set((event.target as HTMLInputElement).value);
  }
  protected onEditEstimatedChange(event: Event): void {
    this.editEstimated.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onEditFeeChange(event: Event): void {
    this.editFeeInput.set((event.target as HTMLInputElement).value);
  }
  protected onEditRepairChange(event: Event): void {
    this.editRepair.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onEditBagsChange(event: Event): void {
    this.editBags.set(Number((event.target as HTMLInputElement).value) || 0);
  }
  protected onEditIslandChange(event: Event): void {
    this.editIslandId.set((event.target as HTMLSelectElement).value);
    this.editTabId.set('');
  }
  protected onEditTabChange(event: Event): void {
    this.editTabId.set((event.target as HTMLSelectElement).value);
  }
  protected onEditWeightChange(userId: number, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.editWeightInputs.update((inputs) => ({ ...inputs, [userId]: raw }));
    const weight = parsePercentageInput(raw);
    if (weight === null) {
      return;
    }
    this.editParticipants.update((list) =>
      list.map((participant) =>
        participant.user_id === userId ? { ...participant, weight } : participant,
      ),
    );
  }

  protected distributeEditWeightsEvenly(): void {
    const list = this.editParticipants();
    if (list.length === 0) {
      return;
    }
    const totalCents = 10_000;
    const baseCents = Math.floor(totalCents / list.length);
    const remainderCents = totalCents - baseCents * list.length;
    const redistributed = list.map((participant, index) => ({
      ...participant,
      weight: (baseCents + (index < remainderCents ? 1 : 0)) / 100,
    }));
    this.editParticipants.set(redistributed);
    this.editWeightInputs.set(this.weightInputsFor(redistributed));
  }

  protected unlinkEditEvent(): void {
    this.editEventId.set(null);
    this.editEventTitle.set('');
  }

  protected onEditEventSelect(opt: SearchDialogOption): void {
    this.editEventId.set(Number(opt.id));
    this.editEventTitle.set(opt.title);
    this.showEventSearch.set(false);
  }

  protected async onEventSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    this.eventSearchLoading.set(true);
    try {
      const params: Record<string, string> = { page: '1', limit: '50' };
      if (filters.search) {
        params['search'] = filters.search;
      }
      if (filters.dateFrom) {
        params['date_from'] = filters.dateFrom;
      }
      if (filters.dateTo) {
        params['date_to'] = filters.dateTo;
      }
      const res = await firstValueFrom(
        this.api.get<PaginatedData<EventView>>('/api/events', params),
      );
      this.eventSearchOptions.set(
        res.items.map((event) => ({
          id: event.id,
          title: event.title,
          subtitle: this.formatDate(event.event_date_utc),
          chip: event.status,
        })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.eventSearchLoading.set(false);
    }
  }

  protected async onParticipantSearchFilter(filters: {
    search: string;
    dateFrom: string;
    dateTo: string;
  }): Promise<void> {
    const query = filters.search.trim();
    if (!query) {
      this.participantSearchOptions.set([]);
      return;
    }
    this.searchingRoster.set(true);
    try {
      const rosterPage = await firstValueFrom(
        this.api.get<PaginatedData<AlbionGuildMember>>('api/albion/guild/roster', {
          q: query,
          limit: 25,
        }),
      );
      this.participantSearchOptions.set(
        rosterPage.items.map((member) => ({ id: member.id, title: member.name })),
      );
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.searchingRoster.set(false);
    }
  }

  protected async onParticipantSelect(opt: SearchDialogOption): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const matched = await firstValueFrom(
        this.api.post<MatchedParticipant[]>('api/splits/match-participants', {
          names: [opt.title],
        }),
      );
      const hit = matched.at(0);
      if (!hit) {
        this.toasts.error(this.t('splits.unlinked_character'));
        return;
      }
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
          user_id: hit.user_id,
          weight: 1,
        }),
      );
      this.split.set(detail);
      this.editParticipants.set(this.normalizeParticipants(detail.participants));
      this.editWeightInputs.set(this.weightInputsFor(detail.participants));
      this.toasts.success(this.t('splits.added_to_split', { name: hit.matched_name }));
      this.showParticipantSearch.set(false);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async removeEditParticipant(userId: number): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.delete<SplitDetail>(`api/splits/${current.id}/participants/${userId}`),
      );
      if (detail?.participants) {
        this.split.set(detail);
        this.editParticipants.set(this.normalizeParticipants(detail.participants));
        this.editWeightInputs.set(this.weightInputsFor(detail.participants));
      } else {
        this.editParticipants.update((list) =>
          list.filter((participant) => participant.user_id !== userId),
        );
        this.editWeightInputs.update((inputs) => {
          const next = { ...inputs };
          delete next[userId];
          return next;
        });
      }
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async onEditSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const current = this.split();
    if (!current) {
      return;
    }

    const fee = parsePercentageInput(this.editFeeInput());
    if (fee === null || fee < 0 || fee > 100) {
      this.toasts.error(this.t('splits.fee_invalid'));
      return;
    }

    const weights: Array<{ participant: SplitParticipant; weight: number }> = [];
    for (const participant of this.editParticipants()) {
      const weight = parsePercentageInput(this.editWeightValue(participant));
      if (weight === null || weight <= 0) {
        this.toasts.error(this.t('validation.positive'));
        return;
      }
      weights.push({ participant, weight });
    }
    if (Math.abs(this.editTotalWeight() - 100) > 0.01) {
      this.toasts.error(this.t('splits.weight_sum_invalid'));
      return;
    }

    this.saving.set(true);
    try {
      const request: UpdateSplitRequest = {
        note: this.editNote().trim(),
        estimated_market_value: this.editEstimated(),
        fee,
        repair_value: this.editRepair(),
        bags_value: this.editBags(),
        event_id: this.editEventId(),
        island_tab_id: this.editTabId() ? Number(this.editTabId()) : undefined,
      };
      let detail = await firstValueFrom(
        this.api.patch<SplitDetail>(`api/splits/${current.id}`, request),
      );
      for (const { participant, weight } of weights) {
        detail = await firstValueFrom(
          this.api.post<SplitDetail>(`api/splits/${current.id}/participants`, {
            user_id: participant.user_id,
            weight,
          }),
        );
      }
      this.split.set(detail);
      this.mode.set('view');
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async closeSplit(action: 'complete' | 'not-completed' | 'lost'): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    try {
      const detail = await firstValueFrom(
        this.api.post<SplitDetail>(`api/splits/${current.id}/${action}`, {}),
      );
      this.split.set(detail);
      this.mode.set('view');
      const toastKey: TranslationKey =
        action === 'complete'
          ? 'splits.status.completed'
          : action === 'not-completed'
            ? 'splits.status.not_completed'
            : 'splits.status.lost';
      this.toasts.success(this.t(toastKey));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async executeCompleteSplit(): Promise<void> {
    this.showCompleteConfirmDialog.set(false);
    await this.closeSplit('complete');
  }

  protected async confirmDelete(): Promise<void> {
    const current = this.split();
    if (!current) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete(`api/splits/${current.id}`));
      this.toasts.success(this.t('common.delete'));
      void this.router.navigate(['/splits']);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
      this.showDelete.set(false);
    }
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined) {
      return '—';
    }
    return Number(value).toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  private hydrateEdit(): void {
    const detail = this.split();
    if (!detail) {
      return;
    }
    this.editNote.set(detail.note || '');
    this.editEstimated.set(Number(detail.estimated_market_value) || 0);
    this.editFeeInput.set(String(detail.fee ?? DEFAULT_SPLIT_FEE));
    this.editRepair.set(Number(detail.repair_value) || 0);
    this.editBags.set(Number(detail.bags_value) || 0);
    this.editEventId.set(detail.event_id ?? null);
    this.editEventTitle.set(detail.event_title || '');
    this.editIslandId.set(detail.island_id ? String(detail.island_id) : '');
    this.editTabId.set(detail.island_tab_id ? String(detail.island_tab_id) : '');
    this.editParticipants.set(this.normalizeParticipants(detail.participants));
    this.editWeightInputs.set(this.weightInputsFor(detail.participants));
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const detail = await firstValueFrom(this.api.get<SplitDetail>(`api/splits/${id}`));
      this.split.set(detail);
      if (detail.status !== 'pending') {
        this.mode.set('view');
      }
    } catch (error) {
      this.loadFailed.set(true);
      this.split.set(null);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
    if (this.canViewSplitTransactions()) {
      void this.loadTransactions(id);
    }
  }

  protected async loadTransactions(id: number): Promise<void> {
    this.transactionsLoading.set(true);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', {
          split_id: id,
          limit: 100,
        }),
      );
      this.splitTransactions.set(data.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.transactionsLoading.set(false);
    }
  }

  protected openEditTransaction(row: TransactionView): void {
    this.editTransactionTarget.set(row);
    this.editTransactionAmount.set(Number(row.amount));
    this.editTransactionStatus.set(row.status);
    this.editTransactionType.set(row.type);
  }

  protected closeEditTransaction(): void {
    this.editTransactionTarget.set(null);
  }

  protected onEditTransactionAmount(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.editTransactionAmount.set(Number.isFinite(value) ? value : null);
  }
  protected onEditTransactionStatus(event: Event): void {
    this.editTransactionStatus.set((event.target as HTMLSelectElement).value as TransactionStatus);
  }
  protected onEditTransactionType(event: Event): void {
    this.editTransactionType.set((event.target as HTMLInputElement).value);
  }

  protected async saveEditTransaction(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const target = this.editTransactionTarget();
    const amount = this.editTransactionAmount();
    const current = this.split();
    if (!target || !current) {
      return;
    }
    if (!amount || amount <= 0) {
      this.toasts.error(this.t('validation.positive'));
      return;
    }
    this.savingTransaction.set(true);
    try {
      const payload: UpdateTransactionRequest = {
        amount,
        status: this.editTransactionStatus(),
        type: this.editTransactionType().trim() || undefined,
      };
      await firstValueFrom(
        this.api.patch<TransactionView>(`api/bank/transactions/${target.id}`, payload),
      );
      this.closeEditTransaction();
      await this.loadTransactions(current.id);
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingTransaction.set(false);
    }
  }

  private normalizeParticipants(participants: SplitParticipant[]): SplitParticipant[] {
    return participants.map((participant) => ({
      ...participant,
      weight: Number(participant.weight),
    }));
  }

  private weightInputsFor(participants: SplitParticipant[]): Record<number, string> {
    return Object.fromEntries(
      participants.map((participant) => [
        participant.user_id,
        this.formatWeightInput(participant.weight),
      ]),
    );
  }

  private formatWeightInput(value: number | string): string {
    return String(value).replace('.', ',');
  }

  private async loadIslands(): Promise<void> {
    try {
      const islands = await firstValueFrom(this.api.get<SplitIsland[]>('api/splits/islands'));
      this.islands.set(islands);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}
