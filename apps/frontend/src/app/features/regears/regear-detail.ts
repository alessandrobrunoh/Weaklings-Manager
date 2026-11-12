import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AcceptRegearRequest,
  RegearBreakdownRow,
  RegearBuildSlot,
  RegearDeathView,
  RegearStatus,
  RejectRegearRequest,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';

/** Editing copy of a breakdown row used in the officer accept dialog. */
interface EditableBreakdownRow extends RegearBreakdownRow {
  /** Position in the auto-estimate breakdown; keys the row's controls. */
  index: number;
  /** Editable unit_price as a string for the input binding. */
  unit_price_input: string;
}

/** One entry of the death's history: when it happened and, for decisions, the officer note. */
interface HistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly at: string | null;
  readonly note: string | null;
}

/** Translation key for each equipment slot (the shared slot names used by regear settings). */
const SLOT_LABEL_KEYS: Readonly<Record<RegearBuildSlot, TranslationKey>> = {
  weapon: 'admin.regears.slot.weapon',
  off_hand: 'admin.regears.slot.off_hand',
  head: 'admin.regears.slot.head',
  armor: 'admin.regears.slot.armor',
  shoes: 'admin.regears.slot.shoes',
  cape: 'admin.regears.slot.cape',
  bag: 'admin.regears.slot.bag',
  potion: 'admin.regears.slot.potion',
  food: 'admin.regears.slot.food',
  mount: 'admin.regears.slot.mount',
};

/**
 * Regear request page for one death.
 *
 * Header: the player, the event and date, the status, one primary action (Request for the member
 * who died, Accept for an officer with a pending request) and an overflow menu (Reject for an
 * officer). Below it: the key figures, the requested items as a table with unit price, line value
 * and included state, the death and battle context, and the history of the request.
 *
 * Officers accept or reject through `app-dialog`; there is no generic edit of the death.
 */
@Component({
  selector: 'app-regear-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    Checkbox,
    DataTable,
    DataTableCell,
    Dialog,
    EntityHeader,
    ErrorState,
    Loading,
    PageStack,
    Stat,
    StatusChip,
    SummaryBand,
  ],
  styles: `
    :host {
      display: block;
      min-width: 0;
      color: var(--color-text);
    }
    .regear-back {
      margin-block-end: 0.75rem;
    }
    .regear-facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      gap: 0.875rem 1.25rem;
      margin: 0;
    }
    .regear-facts dt {
      font-size: var(--ui-text-xs);
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .regear-facts dd {
      margin: 0.125rem 0 0;
      font-size: var(--ui-text-md);
      overflow-wrap: anywhere;
    }
    .regear-link {
      font-weight: 500;
      color: var(--color-primary);
    }
    .regear-item {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }
    .regear-item img {
      flex: none;
      width: 2rem;
      height: 2rem;
      object-fit: contain;
      padding: 0.125rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
    }
    .regear-item__id {
      font-family: var(--font-mono);
      font-size: var(--ui-text-sm);
      overflow-wrap: anywhere;
    }
    .regear-muted {
      color: var(--color-text-secondary);
    }
    .regear-history {
      display: grid;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .regear-history li {
      display: grid;
      grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
      gap: 0.25rem 1rem;
      padding-block: 0.625rem;
      border-top: 1px solid var(--color-border);
      font-size: var(--ui-text-sm);
    }
    .regear-history li:first-child {
      border-top: 0;
    }
    .regear-history__label {
      font-weight: 600;
    }
    .regear-history__time {
      font-family: var(--font-mono);
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }
    .regear-history__note {
      grid-column: 2;
      margin: 0;
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }
    .regear-accept-total {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
      margin-block: 0.75rem;
      font-size: var(--ui-text-sm);
    }
    .regear-accept-total strong {
      font-size: var(--ui-text-lg);
    }
    .regear-error {
      margin: 0 0 0.75rem;
      font-size: var(--ui-text-sm);
      color: var(--color-error);
    }
    .regear-price {
      width: 8rem;
      text-align: right;
      font-family: var(--font-mono);
    }
  `,
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      @if (notFound()) {
        <app-error-state variant="not-found">
          <a class="btn btn--outline btn--sm" routerLink="/regears">{{ t('regears.detail.back') }}</a>
        </app-error-state>
      } @else {
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
      }
    } @else if (death(); as current) {
      <a class="btn btn--ghost btn--sm regear-back" routerLink="/regears">← {{ t('regears.detail.back') }}</a>

      <app-entity-header
        [title]="current.player_name"
        [menuItems]="menuItems()"
        [menuLabel]="t('ui.menu.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <app-status-chip entityBadges [value]="current.status" [label]="statusLabel(current.status)" />

        <div entityMeta>
          <span>{{ current.event_title }}</span>
          <span>{{ formatDate(current.killed_at) }}</span>
        </div>

        @if (canRequest()) {
          <button entityPrimary type="button" class="btn btn--primary" (click)="requestRegear()" [disabled]="acting()">
            {{ t('regears.request') }}
          </button>
        } @else if (canAdjudicatePending()) {
          <button entityPrimary type="button" class="btn btn--primary" (click)="openAcceptDialog()" [disabled]="acting()">
            {{ t('regears.accept') }}
          </button>
        }

        <div entitySummary>
          <app-summary-band [ariaLabel]="t('regears.detail.summary')">
            <app-stat [label]="t('regears.estimate')" [value]="formatAmount(current.auto_estimate_total)" [hint]="t('regears.silver')" />
            <app-stat
              [label]="t('regears.final')"
              [value]="formatAmount(current.final_amount)"
              [hint]="current.final_amount === null ? t('regears.detail.notDecided') : t('regears.silver')"
              [tone]="current.final_amount === null ? 'default' : 'success'"
            />
            <app-stat
              [label]="t('regears.detail.includedItems')"
              [value]="includedCount()"
              [hint]="t('regears.detail.includedOf', { count: breakdown().length })"
            />
          </app-summary-band>
        </div>
      </app-entity-header>

      <app-page-stack>
        <section class="card" aria-labelledby="regear-breakdown-title">
          <h2 id="regear-breakdown-title" class="section-title">{{ t('regears.detail.breakdown') }}</h2>
          <app-data-table
            [columns]="breakdownColumns"
            [rows]="breakdown()"
            [trackBy]="trackBreakdownRow"
            [hideSearch]="true"
            [hidePageSize]="true"
            [syncUrl]="false"
            [pageSize]="50"
            [ariaLabel]="t('regears.detail.breakdown')"
            emptyLabel="regears.detail.noItems"
          >
            <ng-template dataTableCell="slot" let-row>
              {{ slotLabel(row.slot) }}
            </ng-template>
            <ng-template dataTableCell="item" let-row>
              <span class="regear-item">
                <img [src]="itemIconUrl(row.item_id)" alt="" loading="lazy" />
                <span class="regear-item__id">{{ row.item_id }}</span>
              </span>
            </ng-template>
            <ng-template dataTableCell="unit" let-row>
              <span class="num">{{ formatAmount(row.unit_price) ?? '—' }}</span>
            </ng-template>
            <ng-template dataTableCell="qty" let-row>
              <span class="num">{{ row.quantity }}</span>
            </ng-template>
            <ng-template dataTableCell="value" let-row>
              <span class="num">
                @if (row.included) {
                  {{ formatAmount(lineValue(row)) }}
                } @else {
                  —
                }
              </span>
            </ng-template>
            <ng-template dataTableCell="included" let-row>
              @if (row.included) {
                <app-status-chip value="included" [label]="t('regears.included')" toneOverride="success" />
              } @else {
                <app-status-chip value="excluded" [label]="t('regears.excluded')" toneOverride="neutral" />
              }
            </ng-template>
          </app-data-table>
        </section>

        <section class="card" aria-labelledby="regear-context-title">
          <h2 id="regear-context-title" class="section-title">{{ t('regears.detail.context') }}</h2>
          <dl class="regear-facts">
            <div>
              <dt>{{ t('regears.battle') }}</dt>
              <dd>
                @if (current.albionbb_battle_id) {
                  <a [routerLink]="['/battles', current.albionbb_battle_id]" class="regear-link">
                    {{ t('regears.detail.battleNumber', { id: current.albionbb_battle_id }) }}
                  </a>
                } @else {
                  <span class="regear-muted">{{ t('regears.source.selfReported') }}</span>
                }
              </dd>
            </div>
            <div>
              <dt>{{ t('regears.build') }}</dt>
              <dd>{{ current.primary_build_name || '—' }}</dd>
            </div>
          </dl>
        </section>

        <section class="card" aria-labelledby="regear-history-title">
          <h2 id="regear-history-title" class="section-title">{{ t('regears.detail.history') }}</h2>
          <ol class="regear-history">
            @for (entry of history(); track entry.id) {
              <li>
                <span class="regear-history__label">{{ entry.label }}</span>
                @if (entry.at; as at) {
                  <time class="regear-history__time" [attr.datetime]="at">{{ formatDate(at) }}</time>
                }
                @if (entry.note) {
                  <p class="regear-history__note">
                    <span class="font-semibold">{{ t('regears.officerNote') }}:</span> {{ entry.note }}
                  </p>
                }
              </li>
            }
          </ol>
        </section>
      </app-page-stack>
    }

    @if (acceptOpen()) {
      <app-dialog [title]="t('regears.acceptTitle')" size="lg" (closed)="closeAcceptDialog()">
        <p class="hint">{{ t('regears.acceptHint') }}</p>
        <app-data-table
          [columns]="acceptColumns"
          [rows]="acceptRows()"
          [trackBy]="trackEditableRow"
          [hideSearch]="true"
          [hidePageSize]="true"
          [syncUrl]="false"
          [pageSize]="50"
          [maxHeight]="'20rem'"
          [ariaLabel]="t('regears.detail.breakdown')"
          emptyLabel="regears.detail.noItems"
        >
          <ng-template dataTableCell="slot" let-row>
            {{ slotLabel(row.slot) }}
          </ng-template>
          <ng-template dataTableCell="item" let-row>
            <span class="regear-item">
              <img [src]="itemIconUrl(row.item_id)" alt="" loading="lazy" />
              <span class="regear-item__id">{{ row.item_id }}</span>
            </span>
          </ng-template>
          <ng-template dataTableCell="unit" let-row>
            <input
              class="input input--sm regear-price"
              type="number"
              min="0"
              inputmode="numeric"
              [attr.aria-label]="t('regears.unitPrice') + ' · ' + row.item_id"
              [value]="row.unit_price_input"
              (input)="updateEditablePrice(row.index, $event)"
            />
          </ng-template>
          <ng-template dataTableCell="included" let-row>
            <app-checkbox
              [inputId]="'regear-row-' + row.index"
              [label]="t('regears.included')"
              [checked]="row.included"
              (checkedChange)="setEditableIncluded(row.index, $event)"
            />
          </ng-template>
        </app-data-table>

        <div class="regear-accept-total">
          <span class="regear-muted">{{ t('common.total') }}</span>
          <strong class="num">{{ formatSilver(acceptTotal()) }}</strong>
        </div>
        @if (acceptHasNegativePrice()) {
          <p class="regear-error">{{ t('regears.negativePrice') }}</p>
        }
        <label class="block">
          <span class="label">{{ t('regears.note') }} ({{ t('common.optional') }})</span>
          <input class="input" type="text" [value]="acceptNote()" (input)="onAcceptNote($event)" />
        </label>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeAcceptDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--primary"
            (click)="confirmAccept()"
            [disabled]="acting() || acceptHasNegativePrice()"
          >
            {{ t('regears.confirmAccept') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (rejectOpen()) {
      <app-dialog [title]="t('regears.rejectTitle')" (closed)="closeRejectDialog()">
        <p class="regear-error">{{ t('regears.rejectWarning') }}</p>
        <form id="regear-reject-form" class="grid gap-2" (submit)="confirmReject($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block">
            <span class="label">{{ t('regears.rejectReason') }} <span class="regear-error" aria-hidden="true">*</span></span>
            <textarea
              class="textarea"
              name="reject_reason"
              rows="3"
              required
              [value]="rejectNote()"
              (input)="onRejectNote($event)"
            ></textarea>
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeRejectDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            form="regear-reject-form"
            class="btn btn--danger"
            [disabled]="acting() || !rejectNote().trim()"
          >
            {{ t('regears.reject') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class RegearDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly acting = signal(false);
  protected readonly death = signal<RegearDeathView | null>(null);
  protected readonly acceptOpen = signal(false);
  protected readonly rejectOpen = signal(false);
  protected readonly acceptRows = signal<EditableBreakdownRow[]>([]);
  protected readonly acceptNote = signal('');
  protected readonly rejectNote = signal('');

  protected readonly canAdjudicate = computed(() => this.auth.hasPermission('regear.adjudicate'));
  protected readonly currentUserId = computed(() => this.auth.profile()?.user_id ?? null);

  protected readonly breakdown = computed<RegearBreakdownRow[]>(() => {
    const death = this.death();
    if (!death) {
      return [];
    }
    return death.final_breakdown ?? death.auto_estimate_breakdown;
  });

  protected readonly includedCount = computed(() => this.breakdown().filter((row) => row.included).length);

  protected readonly acceptTotal = computed(() => this.computeEditableTotal(this.acceptRows()));

  /** Zero is a legitimate unit price (e.g. a worthless slot); only negatives are rejected. */
  protected readonly acceptHasNegativePrice = computed(() =>
    this.acceptRows().some((row) => Number(row.unit_price) < 0),
  );

  protected readonly canRequest = computed(() => {
    const death = this.death();
    return (
      death !== null &&
      death.status === 'available' &&
      death.user_id === this.currentUserId() &&
      this.auth.hasPermission('regear.request')
    );
  });

  protected readonly canAdjudicatePending = computed(
    () => this.canAdjudicate() && this.death()?.status === 'pending',
  );

  /** Officer actions that do not fit the primary button. */
  protected readonly menuItems = computed<EntityMenuItem[]>(() =>
    this.canAdjudicatePending() ? [{ id: 'reject', label: this.t('regears.reject'), danger: true }] : [],
  );

  protected readonly history = computed<HistoryEntry[]>(() => {
    const death = this.death();
    if (!death) {
      return [];
    }
    const entries: HistoryEntry[] = [
      { id: 'killed', label: this.t('regears.killedAt'), at: death.killed_at, note: null },
    ];
    if (death.requested_at) {
      entries.push({
        id: 'requested',
        label: this.t('regears.detail.historyRequested'),
        at: death.requested_at,
        note: null,
      });
    }
    if (death.decided_at) {
      entries.push({
        id: 'decided',
        label: this.statusLabel(death.status),
        at: death.decided_at,
        note: death.officer_note,
      });
    }
    if (death.bank_transaction_id !== null) {
      entries.push({ id: 'credited', label: this.t('regears.detail.historyCredited'), at: null, note: null });
    }
    return entries;
  });

  protected readonly breakdownColumns: DataTableColumn<RegearBreakdownRow>[] = [
    { key: 'slot', label: 'regears.slot' },
    { key: 'item', label: 'regears.item' },
    { key: 'unit', label: 'regears.unitPrice', align: 'right' },
    { key: 'qty', label: 'regears.qty', align: 'right' },
    { key: 'value', label: 'regears.detail.lineValue', align: 'right' },
    { key: 'included', label: 'regears.included', align: 'center' },
  ];

  protected readonly acceptColumns: DataTableColumn<EditableBreakdownRow>[] = [
    { key: 'slot', label: 'regears.slot' },
    { key: 'item', label: 'regears.item' },
    { key: 'unit', label: 'regears.unitPrice', align: 'right' },
    { key: 'included', label: 'regears.included', align: 'center' },
  ];

  protected readonly trackBreakdownRow = (row: RegearBreakdownRow): string => `${row.slot}:${row.item_id}`;

  protected readonly trackEditableRow = (row: EditableBreakdownRow): number => row.index;

  protected t = (key: TranslationKey, params?: Record<string, string | number>) => this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected itemIconUrl(itemId: string): string {
    return `https://render.albiononline.com/v1/item/${itemId}.png`;
  }

  protected slotLabel(slot: RegearBuildSlot): string {
    return this.t(SLOT_LABEL_KEYS[slot]);
  }

  protected async load(): Promise<void> {
    this.loadFailed.set(false);
    this.notFound.set(false);
    const deathId = Number(this.route.snapshot.paramMap.get('deathId'));
    if (!Number.isFinite(deathId) || deathId <= 0) {
      this.death.set(null);
      this.notFound.set(true);
      this.loadFailed.set(true);
      return;
    }
    this.loading.set(true);
    try {
      const death = await firstValueFrom(
        this.api.get<RegearDeathView>(`api/regear/deaths/${deathId}`),
      );
      this.death.set(death);
    } catch (error) {
      this.death.set(null);
      this.loadFailed.set(true);
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      } else {
        this.toasts.error(this.t('common.error'));
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected onMenu(id: string): void {
    if (id === 'reject') {
      this.openRejectDialog();
    }
  }

  protected async requestRegear(): Promise<void> {
    const death = this.death();
    if (!death || this.acting()) {
      return;
    }
    this.acting.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/deaths/${death.id}/request`),
      );
      this.death.set(updated);
      this.toasts.success(this.t('regears.requested'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected openAcceptDialog(): void {
    const death = this.death();
    if (!death) {
      return;
    }
    this.acceptRows.set(
      death.auto_estimate_breakdown.map((row, index) => ({
        ...row,
        index,
        unit_price_input: String(row.unit_price),
      })),
    );
    this.acceptNote.set('');
    this.acceptOpen.set(true);
  }

  protected closeAcceptDialog(): void {
    this.acceptOpen.set(false);
  }

  protected updateEditablePrice(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.acceptRows.update((rows) =>
      rows.map((row) =>
        row.index === index ? { ...row, unit_price_input: value, unit_price: Number(value) || 0 } : row,
      ),
    );
  }

  protected setEditableIncluded(index: number, included: boolean): void {
    this.acceptRows.update((rows) =>
      rows.map((row) => (row.index === index ? { ...row, included } : row)),
    );
  }

  protected onAcceptNote(event: Event): void {
    this.acceptNote.set((event.target as HTMLInputElement).value);
  }

  protected async confirmAccept(): Promise<void> {
    const death = this.death();
    if (!death || this.acting()) {
      return;
    }
    if (this.acceptHasNegativePrice()) {
      this.toasts.error(this.t('regears.negativePrice'));
      return;
    }
    this.acting.set(true);
    try {
      const rows = this.acceptRows();
      const payload: AcceptRegearRequest = {
        final_amount: this.computeEditableTotal(rows),
        breakdown: rows.map(({ unit_price_input: _ignored, index: _index, ...row }) => row),
        note: this.acceptNote().trim() || undefined,
      };
      const updated = await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${death.id}/accept`, payload),
      );
      this.death.set(updated);
      this.closeAcceptDialog();
      this.toasts.success(this.t('regears.accepted'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected openRejectDialog(): void {
    this.rejectNote.set('');
    this.rejectOpen.set(true);
  }

  protected closeRejectDialog(): void {
    this.rejectOpen.set(false);
  }

  protected onRejectNote(event: Event): void {
    this.rejectNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirmReject(event: Event): Promise<void> {
    event.preventDefault();
    const death = this.death();
    const note = this.rejectNote().trim();
    if (!death || !note || this.acting()) {
      return;
    }
    this.acting.set(true);
    try {
      const payload: RejectRegearRequest = { note };
      const updated = await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${death.id}/reject`, payload),
      );
      this.death.set(updated);
      this.closeRejectDialog();
      this.toasts.success(this.t('regears.rejected'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected lineValue(row: RegearBreakdownRow): number {
    return (Number(row.unit_price) || 0) * row.quantity;
  }

  protected formatDate(value: string | null): string {
    if (!value) {
      return '—';
    }
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  /** Number only, for table cells and stat values. Null renders as an em dash in `app-stat`. */
  protected formatAmount(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return String(value);
    }
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }

  protected formatSilver(value: number | string | null): string {
    const amount = this.formatAmount(value);
    return amount === null ? '—' : `${amount} ${this.t('regears.silver')}`;
  }

  protected statusLabel(status: RegearStatus): string {
    switch (status) {
      case 'approved':
        return this.t('regears.status.approved');
      case 'rejected':
        return this.t('regears.status.rejected');
      case 'pending':
        return this.t('regears.status.pending');
      default:
        return this.t('regears.status.available');
    }
  }

  private computeEditableTotal(rows: readonly EditableBreakdownRow[]): number {
    return rows
      .filter((row) => row.included)
      .reduce((acc, row) => acc + (Number(row.unit_price) || 0) * row.quantity, 0);
  }
}
