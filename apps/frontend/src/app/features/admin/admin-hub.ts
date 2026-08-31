import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ADMIN_ELSEWHERE_LINKS, ADMIN_PANELS } from '../../layout/nav';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';

/**
 * Admin console landing page.
 *
 * Lists the panels this session can open: roles, permissions, Discord,
 * season XP, regears, and islands.
 */
@Component({
  selector: 'app-admin-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink, StatCard],
  template: `
    <app-page-header
      [title]="t('admin.title')"
      [subtitle]="t('admin.hub.subtitle')"
    />

    <app-page-stack>
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Admin summary">
        <app-stat-card
          [label]="t('admin.stat.panels')"
          [value]="visiblePanels().length"
          icon="hammer"
          tone="primary"
        />
        <app-stat-card
          [label]="t('admin.stat.roles')"
          value="RBAC"
          icon="users"
          tone="warning"
        />
        <app-stat-card
          [label]="t('admin.stat.audit')"
          value="System"
          icon="activity"
          tone="neutral"
        />
        <app-stat-card
          [label]="t('admin.stat.integrations')"
          value="Discord"
          icon="discord"
          tone="success"
        />
      </section>

      <section class="card overflow-hidden" aria-labelledby="admin-panels-heading">
        <header class="px-4 py-3" style="border-bottom: 1px solid var(--color-border)">
          <h2 id="admin-panels-heading" class="eyebrow">{{ t('admin.hub.panels') }}</h2>
        </header>
        <div>
          @for (panel of visiblePanels(); track panel.path) {
            <a
              class="flex items-center gap-3 px-4 py-3 no-underline transition-colors hover:bg-[var(--color-surface-hover)]"
              style="color: var(--color-text); border-bottom: 1px solid var(--color-border)"
              [routerLink]="panel.path"
            >
              <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style="background: var(--color-surface-2); color: var(--color-text-secondary)" aria-hidden="true">
                <app-icon [name]="panel.icon" size="1rem" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ t(panel.labelKey) }}</span>
                <span class="mt-0.5 block truncate text-xs" style="color: var(--color-text-secondary)">{{ t(panel.hintKey) }}</span>
              </span>
              <app-icon name="chevron-right" size="1rem" style="color: var(--color-text-tertiary)" aria-hidden="true" />
            </a>
          }
        </div>
      </section>

      <section class="card p-4">
        <h2 class="eyebrow mb-3">{{ t('admin.hub.elsewhere') }}</h2>
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          @for (link of elsewhereLinks; track link.path) {
            <a
              class="flex items-center justify-between gap-3 rounded-md p-2.5 no-underline border transition-colors hover:bg-surface-2"
              style="color: var(--color-text); border-color: var(--color-border); background: var(--color-surface-1)"
              [routerLink]="link.path"
            >
              <div>
                <div class="font-medium text-sm">{{ t(link.labelKey) }}</div>
                <div class="text-xs" style="color: var(--color-text-secondary)">{{ t(link.hintKey) }}</div>
              </div>
              <app-icon name="chevron-right" size="1rem" style="color: var(--color-text-secondary)" />
            </a>
          }
        </div>
      </section>
    </app-page-stack>
  `,
})
export class AdminHub {
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);

  protected readonly visiblePanels = computed(() =>
    ADMIN_PANELS.filter((panel) => {
      if (!panel.permissions?.length) {
        return true;
      }
      return panel.permissions.some((permission) => this.auth.hasPermission(permission));
    }),
  );

  protected readonly elsewhereLinks = ADMIN_ELSEWHERE_LINKS;

  protected t = (key: TranslationKey) => this.translate.t(key);
}
