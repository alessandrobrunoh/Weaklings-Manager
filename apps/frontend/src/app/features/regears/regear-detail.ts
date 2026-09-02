import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AcceptRegearRequest,
  RegearBreakdownRow,
  RegearDeathView,
  RegearStatus,
  RejectRegearRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

/** Editing copy of a breakdown row used in the officer accept dialog. */
interface EditableBreakdownRow extends RegearBreakdownRow {
  /** Editable unit_price as a string for the input binding. */
  unit_price_input: string;
}

/**
 * View-first regear death page.
 *
 * Shows player, event, battle, amounts, notes and the item breakdown. Members
 * request from here; officers accept/reject pending rows through `app-dialog`.
 * There is no generic "edit the death" form — adjudication is the only write.
 */
@Component({
  selector: 'app-regear-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Dialog, EmptyState, ErrorState, Loading, PageHeader, PageStack, Icon, TooltipDirective],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else if (!death()) {
      <app-empty-state icon="shield" [message]="t('regears.detail.notFound')" />
    } @else if (death(); as current) {
      <app-page-header [title]="current.player_name" [subtitle]="current.event_title">
        <a class="btn btn--ghost" routerLink="/regears">← {{ t('regears.detail.back') }}</a>
        @if (canRequest()) {
          <button
            type="button"
            class="btn btn--primary"
            (click)="requestRegear()"
            [disabled]="acting()"
          >
            {{ t('regears.request') }}
          </button>
        }
        @if (canAdjudicatePending()) {
          <button type="button" class="btn btn--outline" (click)="openAcceptDialog()" [disabled]="acting()">
            {{ t('regears.accept') }}
          </button>
          <button type="button" class="btn btn--danger" (click)="openRejectDialog()" [disabled]="acting()">
            {{ t('regears.reject') }}
          </button>
        }
      </app-page-header>

      <app-page-stack>
        <section class="card p-5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl">
          <dl class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <dt class="text-xs text-[var(--color-text-secondary)] font-semibold uppercase">{{ t('common.player') }}</dt>
              <dd class="font-bold text-base text-[var(--color-text)] mt-0.5">{{ current.player_name }}</dd>
            </div>
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <dt class="text-xs text-[var(--color-text-secondary)] font-semibold uppercase">{{ t('regears.event') }}</dt>
              <dd class="font-bold text-sm text-[var(--color-text)] mt-0.5 truncate">{{ current.event_title }}</dd>
            </div>
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <dt class="text-xs text-[var(--color-text-secondary)] font-semibold uppercase">{{ t('regears.battle') }}</dt>
              <dd class="mt-0.5">
                <a [routerLink]="['/battles', current.albionbb_battle_id]" class="font-bold text-sm text-[var(--color-primary)] hover:underline">
                  Battle #{{ current.albionbb_battle_id }}
                </a>
              </dd>
            </div>
            <div class="p-3 bg-[var(--color-surface-2)] rounded-lg">
              <dt class="text-xs text-[var(--color-text-secondary)] font-semibold uppercase">{{ t('common.status') }}</dt>
              <dd class="mt-0.5">
                <span class="chip" [class]="statusChipClass(current.status)">{{
                  statusLabel(current.status)
                }}</span>
              </dd>
            </div>
          </dl>

          <div class="grid gap-3 sm:grid-cols-3 mt-4 pt-4 border-t border-[var(--color-border)] text-sm">
            <div>
              <span class="text-xs text-[var(--color-text-secondary)] block">{{ t('regears.killedAt') }}</span>
              <span class="font-medium">{{ formatDate(current.killed_at) }}</span>
            </div>
            <div>
              <span class="text-xs text-[var(--color-text-secondary)] block">{{ t('regears.estimate') }}</span>
              <span class="font-bold text-base">{{ formatSilver(current.auto_estimate_total) }}</span>
            </div>
            @if (current.final_amount !== null) {
              <div>
                <span class="text-xs text-[var(--color-text-secondary)] block">{{ t('regears.final') }}</span>
                <span class="font-bold text-base text-[var(--color-success)]">
                  {{ formatSilver(current.final_amount) }}
                </span>
              </div>
            }
          </div>

          @if (current.officer_note) {
            <div class="mt-4 p-3 bg-[var(--color-surface-2)] rounded-lg text-xs border border-[var(--color-border)]">
              <span class="font-bold text-[var(--color-text)]">{{ t('regears.officerNote') }}:</span>
              <span class="text-[var(--color-text-secondary)] ml-1">{{ current.officer_note }}</span>
            </div>
          }
        </section>

        <!-- ITEM BREAKDOWN TABLE WITH ALBION SPRITES -->
        <section class="card p-5">
          <h2 class="mb-4 text-base font-bold text-[var(--color-text)]">{{ t('regears.detail.breakdown') }}</h2>
          <div class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th class="text-left">{{ t('regears.slot') }}</th>
                  <th class="text-left">{{ t('regears.item') }}</th>
                  <th class="text-right">{{ t('regears.unitPrice') }}</th>
                  <th class="text-right">{{ t('regears.qty') }}</th>
                  <th class="text-center">{{ t('regears.included') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (row of breakdown(); track row.item_id + row.slot) {
                  <tr>
                    <td>
                      <span class="chip text-xs font-bold uppercase">{{ row.slot }}</span>
                    </td>
                    <td>
                      <div class="flex items-center gap-2.5">
                        <img
                          [src]="itemIconUrl(row.item_id)"
                          [alt]="row.item_id"
                          class="h-8 w-8 object-contain bg-[var(--color-surface-2)] rounded p-0.5 border border-[var(--color-border)]"
                          loading="lazy"
                        />
                        <span class="font-mono text-xs font-semibold text-[var(--color-text)]">{{ row.item_id }}</span>
                      </div>
                    </td>
                    <td class="text-right font-mono font-medium">{{ formatSilver(row.unit_price) }}</td>
                    <td class="text-right font-mono font-bold">{{ row.quantity }}</td>
                    <td class="text-center">
                      @if (row.included) {
                        <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-[var(--color-success-subtle)] text-[var(--color-success)]">✓ Included</span>
                      } @else {
                        <span class="text-xs text-[var(--color-text-tertiary)] font-bold">— Excluded</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      </app-page-stack>
    }

    @if (acceptOpen()) {
      <app-dialog
        [title]="t('regears.acceptTitle')"
        size="lg"
        (closed)="closeAcceptDialog()"
      >
        <p class="mb-3 text-sm text-[var(--color-text-secondary)]">
          {{ t('regears.acceptHint') }}
        </p>
        <div class="mb-3 max-h-80 overflow-y-auto">
          <table class="table">
            <thead>
              <tr>
                <th class="text-left">{{ t('regears.slot') }}</th>
                <th class="text-left">{{ t('regears.item') }}</th>
                <th class="text-right">{{ t('regears.unitPrice') }}</th>
                <th class="text-center">{{ t('regears.included') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (row of acceptRows(); track row.item_id + row.slot; let i = $index) {
                <tr>
                  <td class="font-bold uppercase text-xs">{{ row.slot }}</td>
                  <td>
                    <div class="flex items-center gap-2">
                      <img
                        [src]="itemIconUrl(row.item_id)"
                        [alt]="row.item_id"
                        class="h-7 w-7 object-contain bg-[var(--color-surface-2)] rounded p-0.5 border border-[var(--color-border)]"
                        loading="lazy"
                      />
                      <span class="font-mono text-xs">{{ row.item_id }}</span>
                    </div>
                  </td>
                  <td class="text-right">
                    <input
                      class="input input--sm w-32 text-right font-mono"
                      type="number"
                      min="0"
                      [value]="row.unit_price_input"
                      (input)="updateEditablePrice(i, $event)"
                    />
                  </td>
                  <td class="text-center">
                    <input
                      type="checkbox"
                      class="checkbox"
                      [checked]="row.included"
                      (change)="toggleEditableIncluded(i, $event)"
                    />
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <div class="mb-3 flex items-center justify-between">
          <span style="color: var(--color-text-secondary)">{{ t('common.total') }}</span>
          <strong class="text-lg">{{ formatSilver(acceptTotal()) }}</strong>
        </div>
        <label class="mb-1 block">
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
            [disabled]="acting()"
          >
            {{ t('regears.confirmAccept') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (rejectOpen()) {
      <app-dialog [title]="t('regears.rejectTitle')" (closed)="closeRejectDialog()">
        <p class="mb-2 text-sm" style="color: var(--color-error)">
          {{ t('regears.rejectWarning') }}
        </p>
        <label class="mb-1 block">
          <span class="label">{{ t('regears.rejectReason') }}</span>
          <textarea
            class="textarea"
            rows="3"
            [value]="rejectNote()"
            (input)="onRejectNote($event)"
          ></textarea>
        </label>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeRejectDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            (click)="confirmReject()"
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

  protected readonly acceptTotal = computed(() => this.computeEditableTotal(this.acceptRows()));

  protected itemIconUrl(itemId: string): string {
    return `https://render.albiononline.com/v1/item/${itemId}.png`;
  }

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

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const deathId = Number(this.route.snapshot.paramMap.get('deathId'));
    if (!Number.isFinite(deathId) || deathId <= 0) {
      this.death.set(null);
      return;
    }
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const death = await firstValueFrom(
        this.api.get<RegearDeathView>(`api/regear/deaths/${deathId}`),
      );
      this.death.set(death);
    } catch (error) {
      this.death.set(null);
      this.loadFailed.set(true);
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.loading.set(false);
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
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
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
      death.auto_estimate_breakdown.map((row) => ({
        ...row,
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
      rows.map((row, i) =>
        i === index ? { ...row, unit_price_input: value, unit_price: Number(value) || 0 } : row,
      ),
    );
  }

  protected toggleEditableIncluded(index: number, event: Event): void {
    const included = (event.target as HTMLInputElement).checked;
    this.acceptRows.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, included } : row)),
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
    this.acting.set(true);
    try {
      const rows = this.acceptRows();
      const payload: AcceptRegearRequest = {
        final_amount: this.computeEditableTotal(rows),
        breakdown: rows.map(({ unit_price_input: _ignored, ...row }) => row),
        note: this.acceptNote().trim() || undefined,
      };
      const updated = await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${death.id}/accept`, payload),
      );
      this.death.set(updated);
      this.closeAcceptDialog();
      this.toasts.success(this.t('regears.accepted'));
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
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

  protected async confirmReject(): Promise<void> {
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
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.acting.set(false);
    }
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

  protected formatSilver(value: number | string | null): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return String(value);
    }
    return `${numeric.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${this.t('regears.silver')}`;
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

  protected statusChipClass(status: RegearDeathView['status']): string {
    switch (status) {
      case 'approved':
        return 'chip--success';
      case 'rejected':
        return 'chip--error';
      case 'pending':
        return 'chip--warning';
      default:
        return '';
    }
  }

  private computeEditableTotal(rows: readonly EditableBreakdownRow[]): number {
    return rows
      .filter((row) => row.included)
      .reduce((acc, row) => acc + (Number(row.unit_price) || 0) * row.quantity, 0);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return this.t('common.error');
  }
}
