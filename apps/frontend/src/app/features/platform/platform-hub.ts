import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformAdminView, PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PLATFORM_PANELS } from '../../layout/nav';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Control-plane landing page: tenant and platform-admin workspaces.
 */
@Component({
  selector: 'app-platform-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header [title]="t('platform.title')" [subtitle]="t('platform.hub.subtitle')" />

    <app-page-stack>
      <section class="grid gap-4 sm:grid-cols-2" aria-label="Platform summary">
        <article class="card p-4">
          <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
            {{ t('nav.platform.tenants') }}
          </p>
          <p class="mt-1 font-mono text-2xl font-bold">{{ formatCount(tenantCount()) }}</p>
        </article>
        <article class="card p-4">
          <p class="text-[0.6875rem] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
            {{ t('nav.platform.admins') }}
          </p>
          <p class="mt-1 font-mono text-2xl font-bold">{{ formatCount(adminCount()) }}</p>
        </article>
      </section>

      <section class="space-y-4" aria-labelledby="platform-workspaces-heading">
        <h2 id="platform-workspaces-heading" class="eyebrow">
          {{ t('platform.hub.panels') }}
        </h2>
        <div class="grid gap-4 sm:grid-cols-2">
          @for (panel of panels; track panel.path) {
            <a
              [routerLink]="panel.path"
              class="card p-4 flex flex-col justify-between no-underline"
              style="color: var(--color-text)"
            >
              <div class="flex items-center justify-between gap-2 mb-2">
                <div class="flex items-center gap-2.5">
                  <span
                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                    style="background: var(--color-surface-2)"
                    aria-hidden="true"
                  >
                    <app-icon [name]="panel.icon" size="1.125rem" />
                  </span>
                  <span class="font-semibold text-sm">{{ t(panel.labelKey) }}</span>
                </div>
                <app-icon name="chevron-right" size="1rem" style="color: var(--color-text-tertiary)" />
              </div>
              <p class="text-xs leading-relaxed" style="color: var(--color-text-secondary)">
                {{ t(panel.hintKey) }}
              </p>
            </a>
          }
        </div>
      </section>
    </app-page-stack>
  `,
})
export class PlatformHub {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  protected readonly panels = PLATFORM_PANELS;
  protected readonly tenantCount = signal<number | null>(null);
  protected readonly adminCount = signal<number | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected formatCount(value: number | null): string {
    return value === null ? '—' : String(value);
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
  }
}
