import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  GiveawayDetailView,
  GiveawayEntryView,
  GiveawayStatus,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { albionItemQualityLabel } from '../../shared/data/albion-item-quality';

/**
 * Officer detail for one giveaway.
 *
 * The header carries the status, the meta line, the key numbers and the one action that matters
 * while the giveaway is open (drawing a winner). Cancelling sits in the overflow menu. Both state
 * changes confirm in a dialog first, because a draw awards silver to the winner.
 */
@Component({
  selector: 'app-admin-giveaway-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    Dialog,
    EmptyState,
    EntityHeader,
    ErrorState,
    Icon,
    Loading,
    RouterLink,
    StatusChip,
  ],
  template: `
    <a class="mb-3 inline-flex items-center gap-1 text-sm" routerLink="/admin/giveaways">
      <app-icon name="chevron-left" size="0.875rem" />
      {{ t('giveaways.backToList') }}
    </a>

    @if (loading()) {
      <app-loading variant="detail" />
    } @else if (detail(); as giveaway) {
      <app-entity-header
        [title]="giveaway.title"
        [description]="giveaway.description"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <span entityBadges>
          <app-status-chip [value]="giveaway.status" [label]="statusLabel(giveaway.status)" />
        </span>

        <div entityMeta class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>{{ t('giveaways.hostedBy') }} {{ giveaway.created_by_username }}</span>
          <span>{{ t('giveaways.ends') }} {{ formatWhen(giveaway.ends_at) }}</span>
        </div>

        @if (canAct()) {
          <button
            entityPrimary
            type="button"
            class="btn btn--primary"
            [disabled]="acting()"
            (click)="drawConfirmOpen.set(true)"
          >
            {{ t('giveaways.drawNow') }}
          </button>
        }

        <div entitySummary>
          <dl class="grid grid-cols-3 gap-4">
            <div>
              <dt class="text-xs" style="color: var(--color-text-secondary)">{{ t('giveaways.participants') }}</dt>
              <dd class="num m-0 text-xl font-medium">{{ giveaway.entries.length }}</dd>
            </div>
            <div>
              <dt class="text-xs" style="color: var(--color-text-secondary)">{{ t('giveaways.prizes') }}</dt>
              <dd class="num m-0 text-xl font-medium">{{ giveaway.prizes.length }}</dd>
            </div>
            <div>
              <dt class="text-xs" style="color: var(--color-text-secondary)">{{ t('giveaways.winner') }}</dt>
              <dd class="m-0 truncate text-base font-medium">
                {{ giveaway.winner_username ?? t('giveaways.none') }}
              </dd>
            </div>
          </dl>
        </div>
      </app-entity-header>

      <section class="card mb-4 p-4" aria-labelledby="giveaway-prizes-title">
        <h2 id="giveaway-prizes-title" class="section-title mb-3">{{ t('giveaways.prizes') }}</h2>
        @if (giveaway.prizes.length > 0) {
          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">{{ t('giveaways.item') }}</th>
                  <th scope="col">{{ t('giveaways.tier') }}</th>
                  <th scope="col">{{ t('giveaways.quality') }}</th>
                  <th scope="col" class="num">{{ t('giveaways.quantity') }}</th>
                </tr>
              </thead>
              <tbody>
                @for (prize of giveaway.prizes; track prize.id) {
                  <tr>
                    <td>{{ prize.openalbion_item_name }}</td>
                    <td>{{ prize.openalbion_item_tier }}</td>
                    <td>{{ qualityLabel(prize.openalbion_item_quality) }}</td>
                    <td class="num">{{ prize.quantity }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (hasSilver(giveaway) || hasRegear(giveaway)) {
          <dl class="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            @if (hasSilver(giveaway)) {
              <div class="flex justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2">
                <dt>{{ t('giveaways.field.silver') }}</dt>
                <dd class="num m-0">
                  {{ giveaway.silver_amount }}
                  @if (giveaway.silver_transaction_id) {
                    <span class="hint">· {{ t('giveaways.silverTx') }} #{{ giveaway.silver_transaction_id }}</span>
                  }
                </dd>
              </div>
            }
            @if (hasRegear(giveaway)) {
              <div class="flex justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2">
                <dt>{{ t('giveaways.field.regearBonus') }}</dt>
                <dd class="num m-0">+{{ giveaway.regear_request_bonus }}</dd>
              </div>
            }
          </dl>
        }
        @if (giveaway.prizes.length === 0 && !hasSilver(giveaway) && !hasRegear(giveaway)) {
          <app-empty-state compact icon="package" [message]="t('giveaways.prizesEmpty')" />
        }
      </section>

      <section class="card p-4" aria-labelledby="giveaway-entrants-title">
        <h2 id="giveaway-entrants-title" class="section-title mb-3">{{ t('giveaways.participants') }}</h2>
        <app-data-table
          [columns]="entryColumns"
          [rows]="giveaway.entries"
          [trackBy]="trackEntry"
          [syncUrl]="false"
          [mobileLayout]="'stack'"
          [ariaLabel]="t('giveaways.participants')"
          emptyLabel="giveaways.noEntrants"
        >
          <ng-template dataTableCell="entered_at" let-entry>
            {{ formatWhen(entry.entered_at) }}
          </ng-template>
        </app-data-table>
      </section>

      <app-dialog
        [open]="drawConfirmOpen()"
        [title]="t('giveaways.drawConfirm.title')"
        size="sm"
        (closed)="drawConfirmOpen.set(false)"
      >
        <p class="text-sm">{{ t('giveaways.drawConfirm.body') }}</p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="drawConfirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--primary" [disabled]="acting()" (click)="draw()">
            {{ t('giveaways.drawNow') }}
          </button>
        </div>
      </app-dialog>

      <app-dialog
        [open]="cancelConfirmOpen()"
        [title]="t('giveaways.cancelConfirm.title')"
        size="sm"
        (closed)="cancelConfirmOpen.set(false)"
      >
        <p class="text-sm">{{ t('giveaways.cancelConfirm.body') }}</p>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="cancelConfirmOpen.set(false)">
            {{ t('giveaways.cancelConfirm.keep') }}
          </button>
          <button type="button" class="btn btn--danger" [disabled]="acting()" (click)="cancel()">
            {{ t('giveaways.cancelConfirm.confirm') }}
          </button>
        </div>
      </app-dialog>
    } @else if (notFound()) {
      <app-error-state variant="not-found">
        <a class="btn btn--outline btn--sm" routerLink="/admin/giveaways">{{ t('giveaways.backToList') }}</a>
      </app-error-state>
    } @else {
      <app-error-state
        [message]="t('common.error')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    }
  `,
})
export class AdminGiveawayDetail {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly acting = signal(false);
  protected readonly drawConfirmOpen = signal(false);
  protected readonly cancelConfirmOpen = signal(false);
  protected readonly detail = signal<GiveawayDetailView | null>(null);
  protected readonly canManage = computed(() => this.auth.hasPermission('giveaways.manage'));
  /** Draw and cancel are only meaningful while the giveaway is still open. */
  protected readonly canAct = computed(
    () => this.canManage() && this.detail()?.status === 'open',
  );
  protected readonly menuItems = computed<EntityMenuItem[]>(() =>
    this.canAct() ? [{ id: 'cancel', label: this.t('giveaways.cancelGiveaway'), danger: true }] : [],
  );

  protected readonly entryColumns: DataTableColumn<GiveawayEntryView>[] = [
    {
      key: 'username',
      label: 'giveaways.entrant',
      sortable: true,
      searchable: true,
      accessor: (entry) => entry.username,
    },
    {
      key: 'entered_at',
      label: 'giveaways.enteredAt',
      sortable: true,
      accessor: (entry) => entry.entered_at,
    },
  ];

  protected readonly trackEntry = (entry: GiveawayEntryView): number => entry.id;

  constructor() {
    void this.load();
  }

  protected t(key: TranslationKey): string {
    return this.i18n.t(key);
  }

  protected qualityLabel(quality: number): string {
    return albionItemQualityLabel(quality);
  }

  protected statusLabel(status: GiveawayStatus): string {
    return this.t(`giveaways.status.${status}` as TranslationKey);
  }

  protected formatWhen(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(this.i18n.locale());
  }

  protected hasSilver(giveaway: GiveawayDetailView): boolean {
    return Number(giveaway.silver_amount ?? 0) > 0;
  }

  protected hasRegear(giveaway: GiveawayDetailView): boolean {
    return (giveaway.regear_request_bonus ?? 0) > 0;
  }

  protected onMenu(id: string): void {
    if (id === 'cancel') {
      this.cancelConfirmOpen.set(true);
    }
  }

  protected async draw(): Promise<void> {
    const id = this.detail()?.id;
    if (!id) return;
    this.acting.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.post<GiveawayDetailView>(`api/giveaways/${id}/draw`)));
      this.drawConfirmOpen.set(false);
      this.toasts.success(this.t('giveaways.drawn'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    const id = this.detail()?.id;
    if (!id) return;
    this.acting.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.post<GiveawayDetailView>(`api/giveaways/${id}/cancel`)));
      this.cancelConfirmOpen.set(false);
      this.toasts.success(this.t('giveaways.cancelled'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  protected async load(): Promise<void> {
    const id = Number(this.route.snapshot.paramMap.get('giveawayId'));
    this.loading.set(true);
    this.notFound.set(false);
    try {
      this.detail.set(await firstValueFrom(this.api.get<GiveawayDetailView>(`api/giveaways/${id}`)));
    } catch (error) {
      this.detail.set(null);
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      }
    } finally {
      this.loading.set(false);
    }
  }
}
