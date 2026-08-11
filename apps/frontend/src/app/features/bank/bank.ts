import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BalanceSummary,
  PaginatedData,
  TransactionStatus,
  TransactionView,
  WithdrawRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

const PAGE_SIZE = 10;

/**
 * Guild Bank ledger page.
 *
 * Surfaces the caller's pending/requested totals (live-computed by the backend
 * from the `transactions` table) plus a paginated, filterable transaction list.
 * Members can request withdrawals; officers/admins can accept (pay out) them.
 */
@Component({
  selector: 'app-bank',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, EmptyState, Loading],
  template: `
    <app-page-header [title]="t('bank.title')" [subtitle]="t('bank.subtitle')">
      @if (viewMode() === 'personal') {
        <button type="button" class="btn btn--tonal" (click)="requestWithdrawal()">
          {{ t('bank.withdraw.request') }}
        </button>
      } @else if (canAccept()) {
        <div class="flex gap-2">
          <button type="button" class="btn btn--outline" (click)="rejectWithdrawals()">
            {{ t('bank.withdraw.reject') }}
          </button>
          <button type="button" class="btn btn--primary" (click)="acceptWithdrawals()">
            {{ t('bank.withdraw.accept') }}
          </button>
        </div>
      }
    </app-page-header>

    <!-- Balance cards -->
    <div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div class="card p-5">
        <p
          class="text-xs font-medium uppercase tracking-wider"
          style="color: var(--color-text-secondary)"
        >
          {{ t('bank.balance.pending') }}
        </p>
        <p class="mt-1 text-2xl font-semibold" style="color: var(--color-text)">
          {{ formatAmount(balance()?.pending_total) }}
        </p>
        <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
          {{ balance()?.pending_count ?? 0 }} {{ t('common.total') }}
        </p>
      </div>
      <div class="card p-5">
        <p
          class="text-xs font-medium uppercase tracking-wider"
          style="color: var(--color-text-secondary)"
        >
          {{ t('bank.balance.requested') }}
        </p>
        <p class="mt-1 text-2xl font-semibold" style="color: var(--color-text)">
          {{ formatAmount(balance()?.requested_total) }}
        </p>
        <p class="mt-1 text-xs" style="color: var(--color-text-secondary)">
          {{ balance()?.requested_count ?? 0 }} {{ t('common.total') }}
        </p>
      </div>
    </div>

    <!-- Transactions -->
    <section class="card p-5">
      <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <h2 class="text-base font-semibold" style="color: var(--color-text)">
            {{ t('bank.transactions.title') }}
          </h2>
          @if (canAccept()) {
            <div class="flex rounded-md border p-1 ml-0 sm:ml-4" style="border-color: var(--color-border)">
              <button
                class="px-3 py-1 text-xs rounded"
                [class]="viewMode() === 'personal' ? 'bg-surface-active font-medium' : 'text-secondary hover:bg-surface-hover'"
                (click)="setViewMode('personal')"
              >
                {{ t('bank.view.personal') }}
              </button>
              <button
                class="px-3 py-1 text-xs rounded"
                [class]="viewMode() === 'guild' ? 'bg-surface-active font-medium' : 'text-secondary hover:bg-surface-hover'"
                (click)="setViewMode('guild')"
              >
                {{ t('bank.view.guild') }}
              </button>
            </div>
          }
        </div>
        <label class="flex items-center gap-2">
          <span class="label" style="margin-bottom: 0">{{ t('common.status') }}</span>
          <select
            class="select"
            style="width: auto"
            [value]="statusFilter()"
            (change)="onStatusChange($event)"
          >
            <option value="">{{ t('common.all') }}</option>
            <option value="pending">{{ t('bank.balance.pending') }}</option>
            <option value="requested">{{ t('bank.balance.requested') }}</option>
            <option value="withdrawn">{{ t('bank.balance.payouts') }}</option>
          </select>
        </label>
      </div>

      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (transactions().length === 0) {
        <app-empty-state [message]="t('bank.transactions.empty')" icon="bank" />
      } @else {
        <div class="overflow-x-auto">
          <table class="table">
            <thead>
              <tr>
                @if (viewMode() === 'guild') {
                  <th>{{ t('common.player') }}</th>
                }
                <th>{{ t('common.status') }}</th>
                <th>{{ t('common.amount') }}</th>
                <th>{{ t('common.date') }}</th>
                @if (viewMode() === 'guild') {
                  <th></th>
                }
              </tr>
            </thead>
            <tbody>
              @for (tx of transactions(); track tx.id) {
                <tr>
                  @if (viewMode() === 'guild') {
                    <td class="font-medium text-sm">{{ tx.to_username }}</td>
                  }
                  <td>
                    <span class="chip" [class]="statusChip(tx.status)">
                      {{ tx.status }}
                    </span>
                  </td>
                  <td style="font-variant-numeric: tabular-nums">
                    {{ formatAmount(tx.amount) }}
                  </td>
                  <td style="color: var(--color-text-secondary)">
                    {{ formatDate(tx.created_at) }}
                  </td>
                  @if (viewMode() === 'guild') {
                    <td>
                      @if (tx.status === 'requested') {
                        <div class="flex gap-2 justify-end">
                          <button class="btn btn--outline btn--sm text-success" (click)="acceptSingle(tx.id)">{{ t('common.accept') }}</button>
                          <button class="btn btn--outline btn--sm text-error" (click)="rejectSingle(tx.id)">{{ t('common.reject') }}</button>
                        </div>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="mt-4 flex items-center justify-between">
          <p class="text-xs" style="color: var(--color-text-secondary)">
            {{ t('common.page') }} {{ page() }} {{ t('common.of') }} {{ totalPages() }}
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn--outline"
              [disabled]="page() <= 1"
              (click)="prev()"
            >
              {{ t('common.prev') }}
            </button>
            <button
              type="button"
              class="btn btn--outline"
              [disabled]="page() >= totalPages()"
              (click)="next()"
            >
              {{ t('common.next') }}
            </button>
          </div>
        </div>
      }
    </section>
  `,
})
export class Bank {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly balance = signal<BalanceSummary | null>(null);
  protected readonly transactions = signal<TransactionView[]>([]);
  protected readonly loading = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly statusFilter = signal<TransactionStatus | ''>('');
  protected readonly viewMode = signal<'personal' | 'guild'>('personal');

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected canAccept(): boolean {
    return this.auth.hasPermission('bank.withdraw.accept');
  }

  protected onStatusChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as TransactionStatus | '';
    this.statusFilter.set(value);
    this.page.set(1);
    void this.loadTransactions();
  }

  protected setViewMode(mode: 'personal' | 'guild'): void {
    if (this.viewMode() === mode) return;
    this.viewMode.set(mode);
    this.page.set(1);
    if (mode === 'guild') {
      this.statusFilter.set('requested');
    }
    void this.loadTransactions();
  }

  protected async next(): Promise<void> {
    if (this.page() >= this.totalPages()) {
      return;
    }
    this.page.update((p) => p + 1);
    await this.loadTransactions();
  }

  protected async prev(): Promise<void> {
    if (this.page() <= 1) {
      return;
    }
    this.page.update((p) => p - 1);
    await this.loadTransactions();
  }

  protected async requestWithdrawal(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw', 'bank.withdraw.request', { all: true });
  }

  protected async acceptWithdrawals(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', { all: true });
  }

  protected async rejectWithdrawals(): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', { all: true });
  }

  protected async acceptSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/accept', 'bank.withdraw.accept', { transaction_ids: [id] });
  }

  protected async rejectSingle(id: number): Promise<void> {
    await this.mutate('api/bank/transactions/withdraw/reject', 'bank.withdraw.reject', { transaction_ids: [id] });
  }

  protected formatAmount(value: number | undefined | null): string {
    if (value === undefined || value === null) {
      return '—';
    }
    return value.toLocaleString();
  }

  protected formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  protected statusChip(status: TransactionStatus): string {
    if (status === 'pending') {
      return 'chip chip--warning';
    }
    if (status === 'withdrawn') {
      return 'chip chip--success';
    }
    return 'chip';
  }

  private async load(): Promise<void> {
    await Promise.all([this.loadBalance(), this.loadTransactions()]);
  }

  private async loadBalance(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.get<BalanceSummary>('api/bank/balance'));
      this.balance.set(data);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  private async loadTransactions(): Promise<void> {
    this.loading.set(true);
    try {
      const filter = this.statusFilter();
      const params: Record<string, string | number | boolean> = {
        page: this.page(),
        limit: PAGE_SIZE,
      };
      if (filter) {
        params['status'] = filter;
      }
      if (this.viewMode() === 'guild') {
        params['global'] = true;
      }
      const data = await firstValueFrom(
        this.api.get<PaginatedData<TransactionView>>('api/bank/transactions', params),
      );
      this.transactions.set(data.items);
      this.totalPages.set(data.total_pages);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async mutate(path: string, successKey: TranslationKey, body: WithdrawRequest): Promise<void> {
    try {
      await firstValueFrom(this.api.post<TransactionView[]>(path, body));
      this.toasts.success(this.translate.t(successKey));
      await this.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }
}
