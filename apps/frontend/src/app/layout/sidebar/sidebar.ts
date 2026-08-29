import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/** Single entry in the sidebar. */
export interface NavItem {
  readonly path: string;
  readonly icon: IconName;
  readonly labelKey: TranslationKey;
  /** Restrict visibility by permission keys (OR); undefined = everyone authenticated. */
  readonly permissions?: readonly string[];
}

/** Group of nav entries with a small heading label. */
export interface NavSection {
  readonly headingKey: TranslationKey;
  readonly items: NavItem[];
}

/**
 * Left-hand navigation rail.
 *
 * Renders grouped links from a static definition; the `authGuard` is what
 * actually prevents unauthorized access — this list only hides links the
 * user cannot reach, so it must stay in sync with route guards.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, RouterLinkActive, WeaklingsLogo],
  template: `
    <nav class="flex h-full flex-col" [attr.aria-label]="'Primary'">
      <!-- Brand -->
      <a routerLink="/dashboard" class="mb-4 px-3 py-3 no-underline">
        <app-weaklings-logo />
      </a>

      <!-- Sections -->
      <div class="flex-1 overflow-y-auto px-3 scrollbar-thin">
        @for (section of visibleSections(); track section.headingKey) {
          <div class="mb-4">
            <p
              [id]="section.headingKey"
              class="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider"
              style="color: var(--color-text-secondary)"
            >
              {{ t(section.headingKey) }}
            </p>
            <ul class="flex flex-col gap-0.5" role="list" [attr.aria-labelledby]="section.headingKey">
              @for (item of section.items; track item.path) {
                <li>
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="nav-link--active"
                    [ariaCurrentWhenActive]="'page'"
                    class="nav-link"
                    (click)="navigate.emit()"
                  >
                    <app-icon [name]="item.icon" size="1.125rem" />
                    <span>{{ t(item.labelKey) }}</span>
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </div>
    </nav>
  `,
})
export class Sidebar {
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);

  /** Emits when any link is clicked — used to auto-close the mobile drawer. */
  readonly navigate = output<void>();

  readonly sections = input.required<NavSection[]>();

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly visibleSections = computed<NavSection[]>(() => {
    return this.sections()
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          if (!item.permissions?.length) {
            return true;
          }
          return item.permissions.some((permission) => this.auth.hasPermission(permission));
        }),
      }))
      .filter((section) => section.items.length > 0);
  });
}
