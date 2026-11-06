import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { EventDetailView, SplitSummary } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { EmptyState } from '../../../shared/components/empty-state/empty-state';
import { Icon } from '../../../shared/components/icon/icon';
import { StatusChip } from '../../../shared/components/status-chip/status-chip';
import { formatAmount, formatDate, netOfSplit } from './event-detail.utils';

/** Loot and splits tab of the event detail page: split totals and the split list with unlink. */
@Component({
  selector: 'app-event-splits-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, Icon, RouterLink, StatusChip],
  template: `
    @let detail = event();
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
                >{{ t('splits.netPaid') }}:</span
              >
              <strong class="text-sm font-mono font-bold text-[var(--color-success)]">
                {{ formatAmount(detail.split_stats.completed_net_value) }} silver
              </strong>
            </div>
            @if (canEdit()) {
              <button
                type="button"
                class="btn btn--primary btn--sm text-xs"
                (click)="addSplit.emit()"
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
                  @if (split.origin_read_only) {
                    <span class="chip chip--neutral text-xs">{{ t('splits.readOnlyCopy') }}</span>
                  }
                  @if (split.island_name) {
                    <span class="chip chip--tonal text-xs font-mono">
                      {{ cityLabel(split.island_city) }} &middot; {{ split.island_name }} &middot;
                      {{ split.island_tab_name }}
                    </span>
                  }
                  <span class="text-xs text-[var(--color-text-secondary)]">
                    &middot; {{ formatDate(split.created_at) }}
                  </span>
                </div>

                <div class="flex items-center gap-2">
                  <a class="btn btn--outline btn--sm text-xs" [routerLink]="['/splits', split.id]">
                    {{ t('common.open') }} &rarr;
                  </a>
                  @if (canEdit()) {
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm text-[var(--color-danger)]"
                      (click)="unlinkSplit.emit(split.id)"
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
  `,
})
export class EventSplitsTab {
  private readonly translate = inject(TranslateService);

  readonly event = input.required<EventDetailView>();
  readonly canEdit = input.required<boolean>();
  readonly addSplit = output<void>();
  readonly unlinkSplit = output<number>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
  protected readonly formatAmount = formatAmount;
  protected readonly formatDate = formatDate;
  protected readonly netOfSplit = (split: SplitSummary): number => netOfSplit(split);

  protected cityLabel(city: string | null | undefined): string {
    if (!city) return '';
    return this.t(`splits.city.${city}` as TranslationKey);
  }
}
