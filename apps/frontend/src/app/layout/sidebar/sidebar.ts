import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';
import { filterNavSections, type NavSection } from '../nav';

export type { NavItem, NavSection } from '../nav';

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
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  `,
  template: `
    <nav class="flex h-full w-full flex-col py-3" [attr.aria-label]="t(ariaLabelKey())">
      <!-- Brand -->
      <div class="px-4 pb-3">
        <a routerLink="/dashboard" class="no-underline block">
          <app-weaklings-logo />
        </a>
      </div>

      <!-- Sections -->
      <div class="flex-1 overflow-y-auto px-3 scrollbar-thin">
        @for (section of visibleSections(); track section.headingKey) {
          <div class="mb-4">
            <p
              [id]="section.headingKey"
              class="eyebrow px-3 pb-1.5 pt-3"
            >
              {{ t(section.headingKey) }}
            </p>
            <ul class="flex flex-col gap-0.5" role="list" [attr.aria-labelledby]="section.headingKey">
              @for (item of section.items; track item.path) {
                <li>
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="nav-link--active"
                    [routerLinkActiveOptions]="{ exact: item.exact === true }"
                    [ariaCurrentWhenActive]="'page'"
                    class="nav-link"
                    (click)="navigate.emit()"
                  >
                    <app-icon [name]="item.icon" size="1.125rem" class="shrink-0" />
                    <span class="truncate">{{ t(item.labelKey) }}</span>
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
  readonly ariaLabelKey = input<TranslationKey>('nav.aria.primary');

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly visibleSections = computed<NavSection[]>(() =>
    filterNavSections(this.sections(), (permission) => this.auth.hasPermission(permission)),
  );
}
