import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BankAnalyticsSummary,
  EventView,
  PaginatedData,
  PermissionMatrix,
  SplitSummary,
  UserProfile,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ADMIN_ELSEWHERE_LINKS, ADMIN_PANELS } from '../../layout/nav';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import type { AuditLog } from '../audit/audit';

/**
 * Admin console landing page & command center.
 *
 * Displays live administrative KPIs, urgent action queues (regears, splits, withdrawals),
 * categorized management workspaces, and recent audit activity.
 */
@Component({
  selector: 'app-admin-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink, StatCard, TooltipDirective],
  styles: `
    .admin-card-hover {
      transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
    }
    .admin-card-hover:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .admin-queue-card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      border: 1px solid var(--color-border);
      border-radius: 8px;
      padding: 1rem;
      background: var(--color-surface);
      position: relative;
      overflow: clip;
    }
    .admin-queue-card::before {
      content: '';
      position: absolute;
      inset-inline-start: 0;
      inset-block: 0;
      inline-size: 3px;
    }
    .admin-queue-card--warning::before {
      background: var(--color-warning);
    }
    .admin-queue-card--primary::before {
      background: var(--color-primary);
    }
    .admin-queue-card--success::before {
      background: var(--color-success);
    }
  `,
  template: `
    <app-page-header
      [title]="t('admin.title')"
      [subtitle]="t('admin.hub.subtitle')"
    >
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading()"
        (click)="refreshNow()"
        [appTooltip]="'Aggiorna statistiche e code'"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <!-- Core Administrative KPIs -->
      <section class="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Admin KPI summary">
        <app-stat-card
          [label]="t('admin.stat.totalMembers')"
          [value]="formatCount(totalMembers())"
          icon="users"
          tone="primary"
        />
        <app-stat-card
          [label]="t('admin.stat.ledgerVolume')"
          [value]="formatAmount(bankSummary()?.ledger_volume)"
          [sub]="formatCountHint(bankSummary()?.transaction_count, 'transazioni')"
          icon="bank"
          tone="neutral"
        />
        <app-stat-card
          [label]="t('admin.stat.openLiability')"
          [value]="formatAmount(bankSummary()?.outstanding_total)"
          [sub]="formatCountHint(bankSummary()?.outstanding_count, 'richieste')"
          icon="bank"
          tone="warning"
        />
        <app-stat-card
          [label]="t('admin.stat.paidOut')"
          [value]="formatAmount(bankSummary()?.paid_out_total)"
          [sub]="formatCountHint(bankSummary()?.paid_out_count, 'liquidati')"
          icon="bank"
          tone="success"
        />
        <app-stat-card
          [label]="t('admin.stat.totalRoles')"
          [value]="formatCount(matrix()?.roles?.length ?? (auth.hasPermission('roles.manage') ? visiblePanels().length : null))"
          icon="shield"
          tone="primary"
        />
        <app-stat-card
          [label]="t('admin.stat.totalEvents')"
          [value]="formatCount(totalEvents())"
          icon="calendar"
          tone="neutral"
        />
      </section>

      <!-- Urgent Officer Action Queues -->
      @if (hasPendingQueues()) {
        <section aria-labelledby="admin-queues-heading">
          <div class="flex items-center justify-between mb-2">
            <h2 id="admin-queues-heading" class="eyebrow flex items-center gap-1.5">
              <span class="inline-block h-2 w-2 rounded-full" style="background-color: var(--color-warning)"></span>
              {{ t('admin.hub.quickQueues') }}
            </h2>
          </div>
          <div class="grid gap-3 sm:grid-cols-3">
            <!-- Pending Regears Queue -->
            <div class="admin-queue-card admin-queue-card--warning">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <span class="text-xs font-semibold uppercase tracking-wider block" style="color: var(--color-warning)">
                    {{ t('admin.stat.pendingRegears') }}
                  </span>
                  <div class="text-xl font-bold mt-0.5 tabular-nums">
                    {{ formatCount(pendingRegearsCount()) }}
                  </div>
                </div>
                <span class="p-1.5 rounded" style="background: var(--color-warning-container); color: var(--color-warning)">
                  <app-icon name="shield" size="1.125rem" />
                </span>
              </div>
              <p class="text-xs mb-3" style="color: var(--color-text-secondary)">
                Richieste di risarcimento equipaggiamento in attesa di approvazione.
              </p>
              <a
                routerLink="/regears"
                class="btn btn--sm btn--outline justify-center text-xs font-medium no-underline"
              >
                {{ t('admin.hub.goToQueue') }} →
              </a>
            </div>

            <!-- Pending Splits Queue -->
            <div class="admin-queue-card admin-queue-card--primary">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <span class="text-xs font-semibold uppercase tracking-wider block" style="color: var(--color-primary)">
                    {{ t('admin.stat.pendingSplits') }}
                  </span>
                  <div class="text-xl font-bold mt-0.5 tabular-nums">
                    {{ formatCount(pendingSplitsCount()) }}
                  </div>
                </div>
                <span class="p-1.5 rounded" style="background: var(--color-primary-container); color: var(--color-primary)">
                  <app-icon name="swords" size="1.125rem" />
                </span>
              </div>
              <p class="text-xs mb-3" style="color: var(--color-text-secondary)">
                Divisioni bottino aperte che richiedono calcolo e distribuzione quote.
              </p>
              <a
                routerLink="/splits"
                class="btn btn--sm btn--outline justify-center text-xs font-medium no-underline"
              >
                {{ t('admin.hub.goToQueue') }} →
              </a>
            </div>

            <!-- Pending Withdrawals Queue -->
            <div class="admin-queue-card admin-queue-card--success">
              <div class="flex items-start justify-between gap-2 mb-2">
                <div>
                  <span class="text-xs font-semibold uppercase tracking-wider block" style="color: var(--color-success)">
                    {{ t('admin.stat.pendingWithdrawals') }}
                  </span>
                  <div class="text-xl font-bold mt-0.5 tabular-nums">
                    {{ formatCount(bankSummary()?.requested_count ?? null) }}
                  </div>
                </div>
                <span class="p-1.5 rounded" style="background: var(--color-success-container); color: var(--color-success)">
                  <app-icon name="bank" size="1.125rem" />
                </span>
              </div>
              <p class="text-xs mb-3" style="color: var(--color-text-secondary)">
                Prelievi richiesti dai membri pronti per essere liquidati in game.
              </p>
              <a
                routerLink="/bank"
                class="btn btn--sm btn--outline justify-center text-xs font-medium no-underline"
              >
                {{ t('admin.hub.goToQueue') }} →
              </a>
            </div>
          </div>
        </section>
      }

      <!-- Categorized Admin Panels Grid -->
      <section class="space-y-4" aria-labelledby="admin-workspaces-heading">
        <h2 id="admin-workspaces-heading" class="eyebrow">
          {{ t('admin.hub.panels') }}
        </h2>
        
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          @for (panel of visiblePanels(); track panel.path) {
            <a
              [routerLink]="panel.path"
              class="card p-4 flex flex-col justify-between no-underline admin-card-hover"
              style="color: var(--color-text)"
            >
              <div>
                <div class="flex items-center justify-between gap-2 mb-2">
                  <div class="flex items-center gap-2.5">
                    <span
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                      style="background: var(--color-surface-2); color: var(--color-text)"
                      aria-hidden="true"
                    >
                      <app-icon [name]="panel.icon" size="1.125rem" />
                    </span>
                    <span class="font-semibold text-sm">{{ t(panel.labelKey) }}</span>
                  </div>
                  <app-icon name="chevron-right" size="1rem" style="color: var(--color-text-tertiary)" aria-hidden="true" />
                </div>
                <p class="text-xs leading-relaxed mt-1" style="color: var(--color-text-secondary)">
                  {{ t(panel.hintKey) }}
                </p>
              </div>
            </a>
          }
        </div>
      </section>

      <!-- Two-Column Section: Recent Audit Feed & Quick Shortcuts -->
      <section class="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <!-- Recent Audit Events (2 cols) -->
        <div class="card p-4 lg:col-span-2">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <span class="inline-block h-2 w-2 rounded-full" style="background-color: var(--color-primary)"></span>
              <h2 class="eyebrow">
                {{ t('admin.hub.recentActivity') }}
              </h2>
            </div>
            @if (auth.hasPermission('audit.view')) {
              <a
                routerLink="/audit"
                class="text-xs font-medium no-underline hover:underline"
                style="color: var(--color-text-secondary)"
              >
                {{ t('admin.hub.viewAudit') }} →
              </a>
            }
          </div>

          @if (recentAudit().length === 0) {
            <div class="py-6 text-center" style="color: var(--color-text-secondary)">
              <app-icon name="activity" size="1.75rem" class="opacity-40 mx-auto mb-1.5" />
              <p class="text-xs">{{ t('admin.hub.noRecentActivity') }}</p>
            </div>
          } @else {
            <div class="divide-y divide-[var(--color-border)]">
              @for (log of recentAudit(); track log.id) {
                <div class="py-2.5 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span
                        class="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded"
                        [style.backgroundColor]="actionBadgeBg(log.action)"
                        [style.color]="actionBadgeFg(log.action)"
                      >
                        {{ formatActionName(log.action) }}
                      </span>
                      @if (log.entity_type) {
                        <span class="text-xs text-[var(--color-text-tertiary)]">
                          {{ log.entity_type }} #{{ log.entity_id }}
                        </span>
                      }
                    </div>
                    <div class="text-xs truncate mt-1" style="color: var(--color-text-secondary)">
                      @if (log.user_id) {
                        <span>Utente #{{ log.user_id }}</span>
                      } @else {
                        <span>Sistema automatico</span>
                      }
                    </div>
                  </div>
                  <div class="text-[11px] tabular-nums text-end shrink-0" style="color: var(--color-text-tertiary)">
                    {{ formatRelative(log.created_at) }}
                  </div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Quick Shortcuts -->
        <div class="card p-4 flex flex-col justify-between">
          <div>
            <h2 class="eyebrow mb-3">{{ t('admin.hub.elsewhere') }}</h2>
            <div class="flex flex-col gap-2">
              @for (link of elsewhereLinks; track link.path) {
                <a
                  class="flex items-center justify-between gap-2.5 rounded-md p-2.5 no-underline border transition-colors hover:bg-[var(--color-surface-hover)]"
                  style="color: var(--color-text); border-color: var(--color-border); background: var(--color-surface-2)"
                  [routerLink]="link.path"
                >
                  <div class="min-w-0">
                    <div class="font-medium text-xs truncate">{{ t(link.labelKey) }}</div>
                    <div class="text-[11px] truncate mt-0.5" style="color: var(--color-text-secondary)">{{ t(link.hintKey) }}</div>
                  </div>
                  <app-icon name="chevron-right" size="0.875rem" style="color: var(--color-text-secondary)" />
                </a>
              }
            </div>
          </div>
        </div>
      </section>
    </app-page-stack>
  `,
})
export class AdminHub {
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(false);
  protected readonly totalMembers = signal<number | null>(null);
  protected readonly bankSummary = signal<BankAnalyticsSummary | null>(null);
  protected readonly pendingRegearsCount = signal<number | null>(null);
  protected readonly pendingSplitsCount = signal<number | null>(null);
  protected readonly totalEvents = signal<number | null>(null);
  protected readonly matrix = signal<PermissionMatrix | null>(null);
  protected readonly recentAudit = signal<ReadonlyArray<AuditLog>>([]);

  protected readonly visiblePanels = computed(() =>
    ADMIN_PANELS.filter((panel) => {
      if (!panel.permissions?.length) {
        return true;
      }
      return panel.permissions.some((permission) => this.auth.hasPermission(permission));
    }),
  );

  protected readonly elsewhereLinks = ADMIN_ELSEWHERE_LINKS;

  protected readonly hasPendingQueues = computed(() => {
    const regears = this.pendingRegearsCount() ?? 0;
    const splits = this.pendingSplitsCount() ?? 0;
    const withdrawals = Number(this.bankSummary()?.requested_count ?? 0);
    return regears > 0 || splits > 0 || withdrawals > 0;
  });

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.loadOverview();
  }

  protected async refreshNow(): Promise<void> {
    this.loading.set(true);
    try {
      await this.loadOverview();
    } finally {
      this.loading.set(false);
    }
  }

  private async loadOverview(): Promise<void> {
    const requests: Promise<unknown>[] = [
      firstValueFrom(this.api.get<PaginatedData<UserProfile>>('api/users', { page: 1, limit: 1 }))
        .then((res) => this.totalMembers.set(res.total_items))
        .catch(() => this.totalMembers.set(null)),

      firstValueFrom(this.api.get<PaginatedData<SplitSummary>>('api/splits', { status: 'pending', page: 1, limit: 1 }))
        .then((res) => this.pendingSplitsCount.set(res.total_items))
        .catch(() => this.pendingSplitsCount.set(null)),

      firstValueFrom(this.api.get<PaginatedData<EventView>>('api/events', { page: 1, limit: 1 }))
        .then((res) => this.totalEvents.set(res.total_items))
        .catch(() => this.totalEvents.set(null)),
    ];

    if (this.auth.hasPermission('bank.view_others')) {
      requests.push(
        firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary'))
          .then((res) => this.bankSummary.set(res))
          .catch(() => this.bankSummary.set(null)),
      );
    }

    if (this.auth.hasPermission('regear.adjudicate')) {
      requests.push(
        firstValueFrom(this.api.get<PaginatedData<unknown>>('api/regear/requests', { page: 1, limit: 1 }))
          .then((res) => this.pendingRegearsCount.set(res.total_items))
          .catch(() => this.pendingRegearsCount.set(null)),
      );
    }

    if (this.auth.hasPermission('permissions.reload')) {
      requests.push(
        firstValueFrom(this.api.get<PermissionMatrix>('api/admin/permissions'))
          .then((res) => this.matrix.set(res))
          .catch(() => this.matrix.set(null)),
      );
    }

    if (this.auth.hasPermission('audit.view')) {
      requests.push(
        firstValueFrom(this.api.get<PaginatedData<AuditLog>>('api/audit', { page: 1, limit: 5 }))
          .then((res) => this.recentAudit.set(res.items))
          .catch(() => this.recentAudit.set([])),
      );
    }

    await Promise.allSettled(requests);
  }

  private getLocale(): string {
    const lang = this.translate.language();
    if (lang === 'it') return 'it-IT';
    if (lang === 'es') return 'es-ES';
    return 'en-US';
  }

  protected formatCount(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString(this.getLocale());
  }

  protected formatAmount(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === '') return '—';
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return '—';
    return num.toLocaleString(this.getLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  protected formatCountHint(count: number | null | undefined, unit: string): string {
    if (count === null || count === undefined) return '';
    return `${count.toLocaleString(this.getLocale())} ${unit}`;
  }

  protected formatActionName(action: string): string {
    return action.replace(/_/g, ' ');
  }

  protected actionBadgeBg(action: string): string {
    if (action.includes('ACCEPT') || action.includes('CREATE') || action.includes('APPROVED')) {
      return 'var(--color-success-container)';
    }
    if (action.includes('REJECT') || action.includes('DELETE') || action.includes('WARN')) {
      return 'rgba(239, 68, 68, 0.15)';
    }
    if (action.includes('UPDATE') || action.includes('SET') || action.includes('REQUEST')) {
      return 'var(--color-warning-container)';
    }
    return 'var(--color-surface-2)';
  }

  protected actionBadgeFg(action: string): string {
    if (action.includes('ACCEPT') || action.includes('CREATE') || action.includes('APPROVED')) {
      return 'var(--color-success)';
    }
    if (action.includes('REJECT') || action.includes('DELETE') || action.includes('WARN')) {
      return '#ef4444';
    }
    if (action.includes('UPDATE') || action.includes('SET') || action.includes('REQUEST')) {
      return 'var(--color-warning)';
    }
    return 'var(--color-text-secondary)';
  }

  protected formatRelative(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const diffMs = date.getTime() - Date.now();
    const diffDays = Math.round(diffMs / 86_400_000);
    const rtf = new Intl.RelativeTimeFormat(this.getLocale(), { numeric: 'auto' });
    if (Math.abs(diffDays) >= 1) return rtf.format(diffDays, 'day');
    const diffHours = Math.round(diffMs / 3_600_000);
    if (Math.abs(diffHours) >= 1) return rtf.format(diffHours, 'hour');
    const diffMinutes = Math.round(diffMs / 60_000);
    return rtf.format(diffMinutes, 'minute');
  }
}

