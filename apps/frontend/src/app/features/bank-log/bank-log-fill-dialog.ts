import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BankLogBestSuggestion,
  BankLogBestSuggestions,
  BankLogCategory,
  BankLogConfirmSuggestionsResult,
  BankLogLinkKind,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { formatSignedSilver, formatSilver, formatSpan, formatUtc, minutesBetween, numeric } from './bank-log-format';
import { BankLogScore, MEDIUM_SCORE } from './bank-log-score';

const CATEGORY_KEYS: Record<BankLogCategory, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  guild_expense: 'bankLog.category.guild_expense',
  donation: 'bankLog.category.donation',
  other: 'bankLog.category.other',
};

const LINK_KIND_KEYS: Record<BankLogLinkKind, TranslationKey> = {
  payout: 'bankLog.category.payout',
  bags: 'bankLog.category.bags',
  loot_sale: 'bankLog.category.loot_sale',
  manual: 'bankLog.links.kind.manual',
};

/**
 * "Fill all suggested": lists the best suggestion of every row, lets the officer untick what is
 * wrong, and confirms the rest in one request. Long shots start unticked.
 */
@Component({
  selector: 'app-bank-log-fill-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, ErrorState, Icon, Loading, BankLogScore],
  styles: `
    :host {
      display: contents;
    }
    .fill {
      display: grid;
      gap: 0.75rem;
      min-width: 0;
    }
    .fill__toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
    }
    .fill__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .fill__table {
      max-height: 26rem;
      overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-inputs);
    }
    .fill__table thead th {
      position: sticky;
      top: 0;
      z-index: 1;
    }
    .fill__table td {
      vertical-align: top;
    }
    .fill__table tbody tr {
      cursor: pointer;
    }
    .fill__table tbody tr.fill__row--off {
      opacity: 0.6;
    }
    .fill__pick {
      width: 2.25rem;
    }
    .fill__score {
      width: 1%;
      white-space: nowrap;
    }
    .fill__amount {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .fill__title {
      font-size: var(--ui-text-sm);
      font-weight: 600;
      color: var(--color-text);
      overflow-wrap: anywhere;
    }
    .fill__sub {
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }
    .fill__in {
      color: var(--color-success);
    }
    .fill__out {
      color: var(--color-error);
    }
    .fill__arrow {
      width: 1.5rem;
      color: var(--color-text-secondary);
    }
    .fill__nowrap {
      white-space: nowrap;
    }
    .fill__note {
      display: flex;
      align-items: flex-start;
      gap: 0.375rem;
      margin: 0;
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
    }
    @media (max-width: 640px) {
      .fill__hide-sm {
        display: none;
      }
      /* Phones: each suggestion becomes a card — tick on the left, score, game row, record. */
      .fill__table thead {
        display: none;
      }
      .fill__table table,
      .fill__table tbody {
        display: block;
      }
      .fill__table tbody tr {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.375rem 0.75rem;
        padding: 0.75rem;
        border-bottom: 1px solid var(--color-border);
      }
      .fill__table tbody tr:last-child {
        border-bottom: 0;
      }
      .fill__table tbody td {
        display: block;
        grid-column: 2;
        width: auto;
        padding: 0;
        border: 0;
      }
      .fill__table tbody td.fill__pick {
        grid-column: 1;
        grid-row: 1 / span 3;
      }
      .fill__table tbody td.fill__hide-sm {
        display: none;
      }
    }
  `,
  template: `
    <app-dialog [title]="t('bankLog.fill.title')" [subtitle]="t('bankLog.fill.subtitle')" size="xl" (closed)="closed.emit()">
      <div class="fill">
        @if (loading()) {
          <app-loading variant="table" />
        } @else if (failed()) {
          <app-error-state [message]="t('bankLog.fill.loadFailed')" [retryLabel]="t('common.retry')" (retry)="load()" />
        } @else if (items().length === 0) {
          <app-empty-state compact icon="sparkles" [message]="t('bankLog.fill.empty')" [hint]="t('bankLog.fill.emptyHint')" />
        } @else {
          <div class="fill__toolbar">
            <span class="text-sm" aria-live="polite">{{ t('bankLog.fill.selected', { selected: picked().length, total: items().length }) }}</span>
            <div class="fill__actions">
              <button type="button" class="btn btn--ghost btn--sm" (click)="pickAll()">{{ t('bankLog.fill.pickAll') }}</button>
              <button type="button" class="btn btn--ghost btn--sm" (click)="pickLikely()">{{ t('bankLog.fill.pickLikely') }}</button>
              <button type="button" class="btn btn--ghost btn--sm" (click)="pickNone()">{{ t('bankLog.fill.pickNone') }}</button>
            </div>
          </div>
          <div class="fill__table scrollbar-thin">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col" class="fill__pick"><span class="sr-only">{{ t('bankLog.entry.pick') }}</span></th>
                  <th scope="col" class="fill__score">{{ t('bankLog.entry.likelihood') }}</th>
                  <th scope="col">{{ t('bankLog.fill.gameRow') }}</th>
                  <th scope="col" class="fill__arrow fill__hide-sm"><span class="sr-only">{{ t('bankLog.fill.becomes') }}</span></th>
                  <th scope="col">{{ t('bankLog.fill.managerRecord') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (item of items(); track item.link.id) {
                  <tr [class.fill__row--off]="!isPicked(item)" (click)="toggle(item)">
                    <td class="fill__pick">
                      <input
                        type="checkbox"
                        class="checkbox"
                        [checked]="isPicked(item)"
                        [attr.aria-label]="rowsTitle(item)"
                        (click)="$event.stopPropagation()"
                        (change)="toggle(item)"
                      />
                    </td>
                    <td class="fill__score"><app-bank-log-score [score]="item.link.score" /></td>
                    <td>
                      <div class="fill__title fill__amount" [class.fill__in]="numeric(item.link.entries_total) >= 0" [class.fill__out]="numeric(item.link.entries_total) < 0">
                        {{ signed(item.link.entries_total) }}
                      </div>
                      <div class="fill__sub">{{ rowsTitle(item) }}</div>
                    </td>
                    <td class="fill__arrow fill__hide-sm"><app-icon name="arrow-right" size="0.875rem" /></td>
                    <td>
                      <div class="fill__title">{{ recordTitle(item) }}</div>
                      <div class="fill__sub">{{ recordSubtitle(item) }}</div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="fill__note">
            <app-icon name="info" size="0.875rem" />
            <span>{{ t('bankLog.fill.lowUnticked', { score: mediumScore }) }}</span>
          </p>
          @if (rowsLeftOut() > 0) {
            <p class="fill__note">
              <app-icon name="alert" size="0.875rem" />
              <span>{{ t('bankLog.fill.leftOut', { count: rowsLeftOut() }) }}</span>
            </p>
          }
        }
      </div>
      <div dialogFooter>
        <button type="button" class="btn btn--ghost" (click)="closed.emit()">{{ t('common.cancel') }}</button>
        <button type="button" class="btn btn--primary" [disabled]="saving() || picked().length === 0" (click)="confirm()">
          {{ t('bankLog.fill.confirm', { count: picked().length }) }}
        </button>
      </div>
    </app-dialog>
  `,
})
export class BankLogFillDialog {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly closed = output<void>();
  /** Links were confirmed: the page reloads. */
  readonly changed = output<void>();

  protected readonly numeric = numeric;
  protected readonly mediumScore = MEDIUM_SCORE;

  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly saving = signal(false);
  protected readonly items = signal<BankLogBestSuggestion[]>([]);
  protected readonly rowsLeftOut = signal(0);
  protected readonly pickedIds = signal<ReadonlySet<number>>(new Set());

  protected readonly picked = computed(() => this.items().filter((item) => this.pickedIds().has(item.link.id)));

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const best = await firstValueFrom(this.api.get<BankLogBestSuggestions>('api/bank/log/suggestions/best'));
      this.items.set(best.items);
      this.rowsLeftOut.set(best.rows_left_out);
      this.pickLikely();
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected isPicked(item: BankLogBestSuggestion): boolean {
    return this.pickedIds().has(item.link.id);
  }

  protected toggle(item: BankLogBestSuggestion): void {
    this.pickedIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(item.link.id)) {
        next.delete(item.link.id);
      } else {
        next.add(item.link.id);
      }
      return next;
    });
  }

  protected pickAll(): void {
    this.pickedIds.set(new Set(this.items().map((item) => item.link.id)));
  }

  protected pickLikely(): void {
    this.pickedIds.set(
      new Set(this.items().filter((item) => (item.link.score ?? 0) >= MEDIUM_SCORE).map((item) => item.link.id)),
    );
  }

  protected pickNone(): void {
    this.pickedIds.set(new Set());
  }

  protected async confirm(): Promise<void> {
    const ids = this.picked().map((item) => item.link.id);
    if (ids.length === 0) {
      return;
    }
    this.saving.set(true);
    try {
      const result = await firstValueFrom(
        this.api.post<BankLogConfirmSuggestionsResult>('api/bank/log/suggestions/confirm', { link_ids: ids }),
      );
      this.toasts.success(
        result.skipped > 0
          ? this.t('bankLog.fill.doneSkipped', { confirmed: result.confirmed, skipped: result.skipped })
          : this.t('bankLog.fill.done', { confirmed: result.confirmed }),
      );
      this.changed.emit();
      this.closed.emit();
    } catch (error) {
      this.toasts.error(error instanceof Error && error.message ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** "16 Nov, 23:10 UTC · Galvdon · Payout" (plus the count of grouped rows). */
  protected rowsTitle(item: BankLogBestSuggestion): string {
    const first = item.entries[0];
    if (!first) {
      return '';
    }
    const parts = [this.utc(first.occurred_at), first.player_name, this.t(CATEGORY_KEYS[first.category])];
    if (item.entries.length > 1) {
      parts.push(this.t('bankLog.entry.withRows', { count: item.entries.length - 1 }));
    }
    return parts.join(' · ');
  }

  protected recordTitle(item: BankLogBestSuggestion): string {
    const members = [...new Set(item.link.targets.map((target) => target.member_username).filter(Boolean))];
    if (members.length > 0) {
      return this.t('bankLog.entry.payoutTo', { member: members.join(', ') });
    }
    return `${this.t(LINK_KIND_KEYS[item.link.kind])} · ${item.link.targets.map((target) => target.label).join(', ')}`;
  }

  /** Amount fit and time gap, the two things the score is made of. */
  protected recordSubtitle(item: BankLogBestSuggestion): string {
    const total = item.link.targets.reduce((sum, target) => sum + numeric(target.amount), 0);
    const difference = total - Math.abs(numeric(item.link.entries_total));
    const parts = [this.amount(total)];
    if (Math.abs(difference) < Math.max(1, item.link.targets.length)) {
      parts.push(this.t('bankLog.entry.exactAmount'));
    } else if (item.link.kind === 'bags' && difference > 0) {
      parts.push(this.t('bankLog.entry.partOf', { amount: this.amount(total) }));
    } else {
      parts.push(this.t('bankLog.entry.offBy', { difference: this.signedValue(difference) }));
    }
    const first = item.entries[0];
    const gaps = item.link.targets
      .map((target) => (first ? minutesBetween(first.occurred_at, target.at) : null))
      .filter((minutes): minutes is number => minutes !== null)
      .sort((a, b) => Math.abs(a) - Math.abs(b));
    if (gaps.length > 0) {
      const minutes = gaps[0];
      const span = formatSpan(this.translate.locale(), minutes);
      parts.push(
        Math.abs(minutes) < 1
          ? this.t('bankLog.entry.sameMinute')
          : minutes > 0
            ? this.t('bankLog.entry.after', { span })
            : this.t('bankLog.entry.before', { span }),
      );
    }
    return parts.join(' · ');
  }

  protected amount(value: string | number | null | undefined): string {
    return formatSilver(this.translate.locale(), value);
  }

  protected signed(value: string | number | null | undefined): string {
    return formatSignedSilver(this.translate.locale(), value);
  }

  private signedValue(value: number): string {
    return formatSignedSilver(this.translate.locale(), value);
  }

  protected utc(iso: string | null | undefined): string {
    return formatUtc(this.translate.locale(), iso);
  }
}
