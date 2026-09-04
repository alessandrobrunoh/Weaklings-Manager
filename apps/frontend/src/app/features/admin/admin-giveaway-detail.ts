import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { GiveawayDetailView, GiveawayStatus } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { albionItemQualityLabel } from '../../shared/data/albion-item-quality';

/**
 * Officer detail for one giveaway: prizes, winner, and the full entry list.
 */
@Component({
  selector: 'app-admin-giveaway-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header [title]="title()" [subtitle]="t('giveaways.detail')">
      <a routerLink="/admin/giveaways" class="btn btn--outline btn--sm">{{ t('nav.admin.giveaways') }}</a>
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading />
      } @else if (detail(); as giveaway) {
        <section class="card p-5 grid gap-3">
          <p class="text-sm" style="color: var(--color-text-secondary)">
            {{ t('giveaways.hostedBy') }} {{ giveaway.created_by_username }}
            · {{ t('giveaways.ends') }} {{ formatWhen(giveaway.ends_at) }}
            · {{ statusLabel(giveaway.status) }}
          </p>
          @if (giveaway.description) {
            <p>{{ giveaway.description }}</p>
          }
          <ul class="grid gap-1 text-sm">
            @for (prize of giveaway.prizes; track prize.id) {
              <li>
                {{ prize.openalbion_item_name }}
                · {{ prize.openalbion_item_tier }}
                · {{ qualityLabel(prize.openalbion_item_quality) }}
                · ×{{ prize.quantity }}
              </li>
            }
            @if (giveaway.silver_amount && +giveaway.silver_amount > 0) {
              <li>{{ giveaway.silver_amount }} silver</li>
            }
          </ul>
          <p class="text-sm">
            {{ t('giveaways.winner') }}:
            {{ giveaway.winner_username ?? t('giveaways.none') }}
            @if (giveaway.silver_transaction_id) {
              · {{ t('giveaways.silverTx') }} #{{ giveaway.silver_transaction_id }}
            }
          </p>
          @if (giveaway.status === 'open' && canManage()) {
            <div class="flex gap-2">
              <button type="button" class="btn btn--primary btn--sm" [disabled]="acting()" (click)="draw()">
                {{ t('giveaways.drawNow') }}
              </button>
              <button type="button" class="btn btn--outline btn--sm" [disabled]="acting()" (click)="cancel()">
                {{ t('giveaways.cancelGiveaway') }}
              </button>
            </div>
          }
        </section>
        <section class="card p-5">
          <h2 class="eyebrow mb-3">{{ t('giveaways.participants') }} ({{ giveaway.entries.length }})</h2>
          @if (giveaway.entries.length === 0) {
            <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('giveaways.none') }}</p>
          } @else {
            <ul class="grid gap-1 text-sm">
              @for (entry of giveaway.entries; track entry.id) {
                <li>{{ entry.username }} · {{ formatWhen(entry.entered_at) }}</li>
              }
            </ul>
          }
        </section>
      }
    </app-page-stack>
  `,
})
export class AdminGiveawayDetail {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  protected readonly loading = signal(true);
  protected readonly acting = signal(false);
  protected readonly detail = signal<GiveawayDetailView | null>(null);
  protected readonly canManage = computed(() => this.auth.hasPermission('giveaways.manage'));
  protected readonly title = computed(() => this.detail()?.title ?? this.t('giveaways.detail'));

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
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  protected async draw(): Promise<void> {
    const id = this.detail()?.id;
    if (!id) return;
    this.acting.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.post<GiveawayDetailView>(`api/giveaways/${id}/draw`)));
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
      this.toasts.success(this.t('giveaways.cancelled'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.acting.set(false);
    }
  }

  private async load(): Promise<void> {
    const id = Number(this.route.snapshot.paramMap.get('giveawayId'));
    this.loading.set(true);
    try {
      this.detail.set(await firstValueFrom(this.api.get<GiveawayDetailView>(`api/giveaways/${id}`)));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
