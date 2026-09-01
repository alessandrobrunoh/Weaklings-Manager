import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';
import { filterNavSections, type NavSection } from '../nav';

export type { NavItem, NavSection } from '../nav';

/**
 * Left-hand navigation rail.
 *
 * Renders grouped links with tooltip support for compact mode.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, RouterLinkActive, TooltipDirective, WeaklingsLogo],
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
    <nav class="flex h-full w-full flex-col py-1.5" [attr.aria-label]="t(ariaLabelKey())">
      <!-- Brand -->
      <div class="flex h-11 items-center px-3" [class.justify-center]="collapsed()">
        <a routerLink="/dashboard" class="no-underline block" aria-label="Weaklings Manager dashboard" [appTooltip]="collapsed() ? 'Weaklings Manager' : null" tooltipPosition="right">
          <app-weaklings-logo [compact]="collapsed()" [dense]="!collapsed()" />
        </a>
      </div>

      <!-- Sections -->
      <div class="flex-1 overflow-y-auto px-2 pb-2 scrollbar-thin">
        @for (section of visibleSections(); track section.headingKey) {
          <div class="mb-2">
            @if (!collapsed()) {
              <p
                [id]="section.headingKey"
                class="eyebrow px-2 pb-1 pt-3 text-[10px]"
              >
                {{ t(section.headingKey) }}
              </p>
            } @else {
              <div class="my-2 mx-auto w-6 border-t" style="border-color: var(--color-border)"></div>
            }
            <ul
              class="flex flex-col gap-0.5"
              role="list"
              [attr.aria-labelledby]="collapsed() ? null : section.headingKey"
              [attr.aria-label]="collapsed() ? t(section.headingKey) : null"
            >
              @for (item of section.items; track item.path) {
                <li>
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="nav-link--active"
                    [routerLinkActiveOptions]="{ exact: item.exact === true }"
                    [ariaCurrentWhenActive]="'page'"
                    class="nav-link"
                    [class.justify-center]="collapsed()"
                    [class.px-0]="collapsed()"
                    [appTooltip]="collapsed() ? t(item.labelKey) : null"
                    tooltipPosition="right"
                    (click)="navigate.emit()"
                  >
                    <app-icon [name]="item.icon" size="1rem" class="shrink-0" />
                    @if (!collapsed()) {
                      <span class="truncate">{{ t(item.labelKey) }}</span>
                    }
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </div>

      <!-- Bottom Collapse Toggle (Desktop only) -->
      <div class="hidden md:flex px-2 pt-2 border-t" style="border-color: var(--color-border)">
        <button
          type="button"
          class="btn btn--ghost btn--sm w-full flex items-center gap-2 text-xs"
          [class.justify-center]="collapsed()"
          (click)="toggleCollapse.emit()"
          [appTooltip]="collapsed() ? t('nav.expand') : t('nav.collapse')"
          tooltipPosition="right"
          [attr.aria-label]="collapsed() ? t('nav.expand') : t('nav.collapse')"
        >
          <app-icon [name]="collapsed() ? 'chevron-right' : 'chevron-left'" size="1rem" />
          @if (!collapsed()) {
            <span class="truncate">{{ t('nav.collapse') }}</span>
          }
        </button>
      </div>
    </nav>
  `,
})
export class Sidebar {
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);

  /** Emits when any link is clicked — used to auto-close the mobile drawer. */
  readonly navigate = output<void>();

  /** Emits when user clicks the collapse button. */
  readonly toggleCollapse = output<void>();

  readonly sections = input.required<NavSection[]>();
  readonly ariaLabelKey = input<TranslationKey>('nav.aria.primary');
  readonly collapsed = input<boolean>(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly visibleSections = computed<NavSection[]>(() =>
    filterNavSections(this.sections(), (permission) => this.auth.hasPermission(permission)),
  );
}
