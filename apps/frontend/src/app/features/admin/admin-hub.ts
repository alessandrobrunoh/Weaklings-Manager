import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { BankAnalyticsSummary, PaginatedData, SplitSummary } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ADMIN_PANELS } from '../../layout/nav';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import type { AuditLog } from '../audit/audit';

/** One destination on the hub. Permission gating comes from `ADMIN_PANELS` in the nav, by path. */
interface HubEntry {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  readonly hintKey: TranslationKey;
}

interface HubSection {
  readonly headingKey: TranslationKey;
  readonly entries: readonly HubEntry[];
}

/**
 * The hub's information architecture: where an officer goes to do a job.
 * Sections follow the job, not the order the panels were added. A panel is shown only when
 * `ADMIN_PANELS` grants it (permissions, alliance tenants), so an entry here can never widen access.
 */
const HUB_SECTIONS: readonly HubSection[] = [
  {
    headingKey: 'admin.hub.section.access',
    entries: [
      { path: '/users', icon: 'users', labelKey: 'nav.admin.users', hintKey: 'admin.hub.usersHint' },
      { path: '/admin/roles', icon: 'shield', labelKey: 'nav.admin.roles', hintKey: 'admin.hub.rolesHint' },
      { path: '/admin/permissions', icon: 'lock', labelKey: 'nav.admin.permissions', hintKey: 'admin.hub.permissionsHint' },
      { path: '/admin/applications', icon: 'list', labelKey: 'nav.admin.applications', hintKey: 'admin.hub.applicationsHint' },
    ],
  },
  {
    headingKey: 'admin.hub.section.economy',
    entries: [
      { path: '/admin/finance', icon: 'chart', labelKey: 'nav.admin.finance', hintKey: 'admin.hub.financeHint' },
      { path: '/admin/transactions', icon: 'coins', labelKey: 'nav.admin.transactions', hintKey: 'admin.hub.transactionsHint' },
      { path: '/admin/withdrawals', icon: 'bank', labelKey: 'nav.admin.withdrawals', hintKey: 'admin.hub.withdrawalsHint' },
      { path: '/admin/regears', icon: 'settings', labelKey: 'admin.hub.regearSettings', hintKey: 'admin.hub.regearsHint' },
    ],
  },
  {
    headingKey: 'admin.hub.section.activities',
    entries: [
      { path: '/admin/giveaways', icon: 'sparkles', labelKey: 'nav.admin.giveaways', hintKey: 'admin.hub.giveawaysHint' },
      { path: '/admin/islands', icon: 'swords', labelKey: 'nav.admin.islands', hintKey: 'admin.hub.islandsHint' },
      { path: '/admin/progression', icon: 'trophy', labelKey: 'nav.admin.progression', hintKey: 'admin.hub.progressionHint' },
    ],
  },
  {
    headingKey: 'admin.hub.section.setup',
    entries: [
      { path: '/admin/general', icon: 'settings', labelKey: 'nav.admin.general', hintKey: 'admin.hub.generalHint' },
      { path: '/admin/features', icon: 'package', labelKey: 'nav.admin.features', hintKey: 'admin.hub.featuresHint' },
      { path: '/admin/alliance', icon: 'link', labelKey: 'nav.admin.alliance', hintKey: 'admin.hub.allianceHint' },
      { path: '/admin/discord', icon: 'discord', labelKey: 'nav.admin.discord', hintKey: 'admin.hub.discordHint' },
    ],
  },
];

/** Pages outside the admin console that officers reach from here. They carry no admin permission. */
const RELATED_ENTRIES: readonly HubEntry[] = [
  { path: '/regears', icon: 'shield', labelKey: 'admin.hub.regearRequests', hintKey: 'admin.hub.regearRequestsHint' },
  { path: '/comps', icon: 'hammer', labelKey: 'admin.link.comps', hintKey: 'admin.link.compsHint' },
  { path: '/splits', icon: 'coins', labelKey: 'admin.link.splits', hintKey: 'admin.link.splitsHint' },
  { path: '/audit', icon: 'activity', labelKey: 'admin.link.audit', hintKey: 'admin.link.auditHint' },
];

/**
 * Admin console landing page: a finder for the admin panels, grouped by the job they do,
 * with the few figures an officer acts on at the top.
 *
 * Attention figures come from the same endpoints as before and only for the permissions that
 * gate them. A figure with no permission is left out rather than shown as a dash.
 */
@Component({
  selector: 'app-admin-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Loading, NgTemplateOutlet, PageHeader, PageStack, RouterLink, SummaryBand],
  styles: `
    .hub-entry-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      flex-shrink: 0;
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      color: var(--color-text);
    }
  `,
  template: `
    <app-page-header [title]="t('admin.title')" [subtitle]="t('admin.hub.subtitle')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="refreshNow()">
        <app-icon name="refresh" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      @if (!ready()) {
        <app-loading variant="summary" />
      } @else if (attentionItems().length > 0) {
        <section class="space-y-2" aria-labelledby="admin-hub-attention">
          <h2 id="admin-hub-attention" class="section-title section-title--sm">{{ t('admin.hub.section.attention') }}</h2>
          <app-summary-band [ariaLabel]="t('admin.hub.section.attention')" [items]="attentionItems()" />
        </section>
      }

      @for (section of sections(); track section.headingKey; let i = $index) {
        <section class="space-y-2" [attr.aria-labelledby]="'admin-hub-section-' + i">
          <h2 [id]="'admin-hub-section-' + i" class="section-title section-title--sm">{{ t(section.headingKey) }}</h2>
          <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            @for (entry of section.entries; track entry.path) {
              <li>
                <ng-container [ngTemplateOutlet]="entryLink" [ngTemplateOutletContext]="{ $implicit: entry }" />
              </li>
            }
          </ul>
        </section>
      }

      @if (auth.hasPermission('audit.view')) {
        <section class="space-y-2" aria-labelledby="admin-hub-activity">
          <div class="flex items-center justify-between gap-3">
            <h2 id="admin-hub-activity" class="section-title section-title--sm">{{ t('admin.hub.recentActivity') }}</h2>
            <a routerLink="/audit" class="text-xs no-underline hover:underline" style="color: var(--color-primary)">
              {{ t('admin.hub.viewAudit') }}
            </a>
          </div>

          <div class="card p-4">
            @if (recentAudit().length === 0) {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('admin.hub.noRecentActivity') }}</p>
            } @else {
              <ul class="divide-y" style="border-color: var(--color-border)">
                @for (log of recentAudit(); track log.id) {
                  <li class="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-2">
                        <span
                          class="rounded px-1.5 py-0.5 font-mono text-xs font-semibold"
                          [style.backgroundColor]="actionBadgeBg(log.action)"
                          [style.color]="actionBadgeFg(log.action)"
                        >
                          {{ formatActionName(log.action) }}
                        </span>
                        @if (log.entity_type) {
                          <span class="text-xs" style="color: var(--color-text-secondary)">
                            {{ log.entity_type }} #{{ log.entity_id }}
                          </span>
                        }
                      </div>
                      <p class="mt-1 truncate text-xs" style="color: var(--color-text-secondary)">
                        @if (log.user_id) {
                          {{ t('admin.hub.actorUser', { id: log.user_id }) }}
                        } @else {
                          {{ t('admin.hub.actorSystem') }}
                        }
                      </p>
                    </div>
                    <time class="shrink-0 text-end text-xs tabular-nums" style="color: var(--color-text-secondary)" [attr.datetime]="log.created_at">
                      {{ formatRelative(log.created_at) }}
                    </time>
                  </li>
                }
              </ul>
            }
          </div>
        </section>
      }

      <section class="space-y-2" aria-labelledby="admin-hub-related">
        <h2 id="admin-hub-related" class="section-title section-title--sm">{{ t('admin.hub.section.related') }}</h2>
        <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          @for (entry of relatedEntries; track entry.path) {
            <li>
              <ng-container [ngTemplateOutlet]="entryLink" [ngTemplateOutletContext]="{ $implicit: entry }" />
            </li>
          }
        </ul>
      </section>
    </app-page-stack>

    <ng-template #entryLink let-entry>
      <a
        [routerLink]="entry.path"
        class="card card--interactive flex h-full items-center gap-3 p-3 no-underline"
        style="color: var(--color-text)"
      >
        <span class="hub-entry-icon" aria-hidden="true">
          <app-icon [name]="entry.icon" size="1rem" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium">{{ t(entry.labelKey) }}</span>
          <span class="block truncate text-xs" style="color: var(--color-text-secondary)">{{ t(entry.hintKey) }}</span>
        </span>
        <app-icon name="chevron-right" size="0.875rem" aria-hidden="true" style="color: var(--color-text-secondary)" />
      </a>
    </ng-template>
  `,
})
export class AdminHub {
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);

  protected readonly loading = signal(false);
  protected readonly ready = signal(false);
  protected readonly bankSummary = signal<BankAnalyticsSummary | null>(null);
  protected readonly pendingRegearsCount = signal<number | null>(null);
  protected readonly pendingSplitsCount = signal<number | null>(null);
  protected readonly pendingWithdrawalsCount = signal<number | null>(null);
  protected readonly recentAudit = signal<ReadonlyArray<AuditLog>>([]);

  /** Panels this user may open, after permission and tenant-kind gating from the nav. */
  private readonly visiblePaths = computed(() => {
    const paths = new Set<string>();
    for (const panel of ADMIN_PANELS) {
      if (panel.hiddenForAlliance && this.auth.profile()?.tenant_kind === 'alliance') {
        continue;
      }
      if (!panel.permissions?.length || panel.permissions.some((permission) => this.auth.hasPermission(permission))) {
        paths.add(panel.path);
      }
    }
    return paths;
  });

  protected readonly sections = computed(() =>
    HUB_SECTIONS.map((section) => ({
      headingKey: section.headingKey,
      entries: section.entries.filter((entry) => this.visiblePaths().has(entry.path)),
    })).filter((section) => section.entries.length > 0),
  );

  protected readonly relatedEntries = RELATED_ENTRIES;

  protected readonly attentionItems = computed<readonly SummaryItem[]>(() => {
    const items: SummaryItem[] = [];
    if (this.auth.hasPermission('bank.withdraw.accept')) {
      items.push(this.queueItem('admin.stat.pendingWithdrawals', this.pendingWithdrawalsCount()));
    }
    if (this.auth.hasPermission('regear.adjudicate')) {
      items.push(this.queueItem('admin.stat.pendingRegears', this.pendingRegearsCount()));
    }
    items.push(this.queueItem('admin.stat.pendingSplits', this.pendingSplitsCount()));
    if (this.auth.hasPermission('bank.view_others')) {
      const summary = this.bankSummary();
      items.push({
        label: this.t('admin.stat.openLiability'),
        value: summary ? this.formatCompact(summary.outstanding_total) : null,
        hint: summary ? this.t('admin.hub.attention.openRequests', { count: summary.outstanding_count ?? 0 }) : undefined,
      });
    }
    return items;
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
      firstValueFrom(this.api.get<PaginatedData<SplitSummary>>('api/splits', { status: 'pending', page: 1, limit: 1 }))
        .then((res) => this.pendingSplitsCount.set(res.total_items))
        .catch(() => this.pendingSplitsCount.set(null)),
    ];

    if (this.auth.hasPermission('bank.view_others')) {
      requests.push(
        firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary'))
          .then((res) => this.bankSummary.set(res))
          .catch(() => this.bankSummary.set(null)),
      );
    }

    // Officers only hold `bank.withdraw.accept`, not the admin-only
    // `bank.view_others` the full ledger summary requires above — so the
    // withdrawal queue count is fetched separately with the permission that
    // actually gates it, or every Officer's queue card would read zero.
    if (this.auth.hasPermission('bank.withdraw.accept')) {
      requests.push(
        firstValueFrom(
          this.api.get<PaginatedData<unknown>>('api/bank/transactions', {
            global: true,
            status: 'requested',
            page: 1,
            limit: 1,
          }),
        )
          .then((res) => this.pendingWithdrawalsCount.set(res.total_items))
          .catch(() => this.pendingWithdrawalsCount.set(null)),
      );
    }

    if (this.auth.hasPermission('regear.adjudicate')) {
      requests.push(
        firstValueFrom(this.api.get<PaginatedData<unknown>>('api/regear/requests', { page: 1, limit: 1 }))
          .then((res) => this.pendingRegearsCount.set(res.total_items))
          .catch(() => this.pendingRegearsCount.set(null)),
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
    this.ready.set(true);
  }

  private queueItem(labelKey: TranslationKey, count: number | null): SummaryItem {
    return {
      label: this.t(labelKey),
      value: count,
      tone: count !== null && count > 0 ? 'warning' : 'default',
      hint: count === null ? undefined : this.t(count > 0 ? 'admin.hub.attention.waiting' : 'admin.hub.attention.none'),
    };
  }

  private getLocale(): string {
    return this.translate.locale();
  }

  protected formatCompact(value: number | string | null | undefined): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num) || num === 0) return '0';
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(2)}B`;
    }
    if (abs >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    }
    if (abs >= 1_000) {
      return `${(num / 1_000).toFixed(1)}k`;
    }
    return num.toLocaleString(this.getLocale());
  }

  protected formatActionName(action: string): string {
    return action.replace(/_/g, ' ');
  }

  protected actionBadgeBg(action: string): string {
    if (action.includes('ACCEPT') || action.includes('CREATE') || action.includes('APPROVED')) {
      return 'var(--color-success-container)';
    }
    if (action.includes('REJECT') || action.includes('DELETE') || action.includes('WARN')) {
      return 'var(--color-error-container)';
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
      return 'var(--color-error)';
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
