import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformAdminView, PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SummaryBand } from '../../shared/components/summary-band/summary-band';

/** One place an operator can go from the hub. */
interface HubEntry {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  /** One line: what the operator does on that page. */
  readonly hintKey: TranslationKey;
}

/** A named group of hub entries, ordered by how often operators reach for them. */
interface HubGroup {
  readonly id: string;
  readonly titleKey: TranslationKey;
  readonly hintKey: TranslationKey;
  readonly entries: readonly HubEntry[];
}

/**
 * Control-plane landing page: what the platform operator can run, grouped by purpose.
 *
 * The summary band only shows counts this page already fetches. Routes and guards are unchanged:
 * the whole `/platform` tree sits behind `platformGuard`.
 */
@Component({
  selector: 'app-platform-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Loading, PageHeader, PageStack, RouterLink, SummaryBand],
  template: `
    <app-page-header [title]="t('platform.title')" [subtitle]="t('platform.hub.subtitle')" />

    <app-page-stack>
      @if (loaded()) {
        <app-summary-band [ariaLabel]="t('platform.hub.summary')" [items]="summary()" />
      } @else {
        <app-loading variant="summary" [label]="t('common.loading')" />
      }

      @for (group of groups; track group.id) {
        <section class="space-y-2" [attr.aria-labelledby]="'platform-hub-' + group.id">
          <div>
            <h2 class="section-title section-title--sm" [id]="'platform-hub-' + group.id">
              {{ t(group.titleKey) }}
            </h2>
            <p class="hint">{{ t(group.hintKey) }}</p>
          </div>

          <ul class="card divide-y p-0" style="border-color: var(--color-border)">
            @for (entry of group.entries; track entry.path + entry.labelKey) {
              <li>
                <a
                  [routerLink]="entry.path"
                  class="flex items-center gap-3 px-4 py-3 no-underline hover:bg-[var(--color-surface-2)]"
                  style="color: var(--color-text)"
                >
                  <span
                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
                    style="background: var(--color-surface-2); color: var(--color-primary)"
                    aria-hidden="true"
                  >
                    <app-icon [name]="entry.icon" size="1.125rem" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-semibold">{{ t(entry.labelKey) }}</span>
                    <span class="block text-sm" style="color: var(--color-text-secondary)">
                      {{ t(entry.hintKey) }}
                    </span>
                  </span>
                  <app-icon
                    name="chevron-right"
                    size="1rem"
                    class="shrink-0"
                    style="color: var(--color-text-tertiary)"
                  />
                </a>
              </li>
            }
          </ul>
        </section>
      }
    </app-page-stack>
  `,
})
export class PlatformHub {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  /** Groups are fixed; every entry points at a route that already exists. */
  protected readonly groups: readonly HubGroup[] = [
    {
      id: 'tenants',
      titleKey: 'platform.hub.groupTenants',
      hintKey: 'platform.hub.groupTenantsHint',
      entries: [
        {
          path: '/platform/tenants',
          icon: 'dashboard',
          labelKey: 'nav.platform.tenants',
          hintKey: 'platform.hub.tenantsHint',
        },
      ],
    },
    {
      id: 'access',
      titleKey: 'platform.hub.groupAccess',
      hintKey: 'platform.hub.groupAccessHint',
      entries: [
        {
          path: '/platform/admins',
          icon: 'shield',
          labelKey: 'nav.platform.admins',
          hintKey: 'platform.hub.adminsHint',
        },
      ],
    },
    {
      id: 'config',
      titleKey: 'platform.hub.groupConfig',
      hintKey: 'platform.hub.groupConfigHint',
      entries: [
        {
          path: '/platform/ranks',
          icon: 'trophy',
          labelKey: 'nav.platform.ranks',
          hintKey: 'platform.hub.ranksHint',
        },
        {
          // Flags are stored per tenant, so this entry opens the tenant list to pick one.
          path: '/platform/tenants',
          icon: 'settings',
          labelKey: 'nav.platform.features',
          hintKey: 'platform.hub.flagsHint',
        },
      ],
    },
  ];

  protected readonly tenantCount = signal<number | null>(null);
  protected readonly adminCount = signal<number | null>(null);
  /** False until both counts have settled, so the band shows a skeleton rather than dashes. */
  protected readonly loaded = signal(false);

  protected readonly summary = computed(() => [
    { label: this.t('nav.platform.tenants'), value: this.tenantCount() },
    { label: this.t('nav.platform.admins'), value: this.adminCount() },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    await Promise.allSettled([
      firstValueFrom(this.api.get<PlatformTenant[]>('api/platform/tenants'))
        .then((rows) => this.tenantCount.set(rows.length))
        .catch(() => this.tenantCount.set(null)),
      firstValueFrom(this.api.get<PlatformAdminView[]>('api/platform/admins'))
        .then((rows) => this.adminCount.set(rows.length))
        .catch(() => this.adminCount.set(null)),
    ]);
    this.loaded.set(true);
  }
}
