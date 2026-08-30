import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ADMIN_PANELS } from '../../layout/nav';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';

/**
 * Admin console landing page.
 *
 * Lists the panels this session can open: roles, permissions, Discord,
 * season XP, regears, and islands.
 */
@Component({
  selector: 'app-admin-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, RouterLink],
  template: `
    <app-page-header
      [title]="t('admin.title')"
      [subtitle]="t('admin.hub.subtitle')"
      [actions]="false"
    />

    <section class="card p-5">
      <h2 class="eyebrow mb-1">{{ t('admin.hub.panels') }}</h2>
      <ul class="mt-3 flex flex-col gap-1" role="list">
        @for (panel of visiblePanels(); track panel.path) {
          <li>
            <a
              class="flex items-center justify-between gap-3 rounded-2xl px-3 py-2 no-underline"
              style="color: var(--color-text)"
              [routerLink]="panel.path"
            >
              <span class="flex items-start gap-3">
                <app-icon [name]="panel.icon" size="1.125rem" class="mt-0.5 shrink-0" />
                <span>
                  {{ t(panel.labelKey) }}
                  <span class="block text-xs" style="color: var(--color-text-secondary)">
                    {{ t(panel.hintKey) }}
                  </span>
                </span>
              </span>
              <app-icon name="chevron-right" size="1rem" />
            </a>
          </li>
        }
      </ul>
    </section>
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

  protected t = (key: TranslationKey) => this.translate.t(key);
}
