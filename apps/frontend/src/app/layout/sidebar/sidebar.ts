import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { filterNavSections, type NavSection } from '../nav';

export type { NavItem, NavSection } from '../nav';

/**
 * Channel sidebar.
 *
 * Mirrors the Discord client: the active server's name heads the column,
 * nav groups read as collapsible channel categories, and each entry is a
 * channel row that lights up when it is the open route.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, RouterLinkActive, TooltipDirective],
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--color-chrome);
    }
    /* Server header: full-width button, hover tint, hairline under it —
       the one element that carries the server's identity in the chrome. */
    .server-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      height: var(--chrome-height, 3rem);
      padding-inline: 1rem;
      border: 0;
      border-bottom: 1px solid var(--color-border);
      background: transparent;
      color: var(--color-text);
      font-family: var(--font-display);
      font-size: 0.9375rem;
      font-weight: 800;
      letter-spacing: -0.01em;
      text-align: left;
      text-decoration: none;
      transition: background-color 120ms ease;
    }
    .server-header:hover {
      background: var(--color-surface-hover);
    }
    .server-header--collapsed {
      justify-content: center;
      padding-inline: 0;
    }
    .server-header__name {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: uppercase;
    }
    .server-header__badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.5rem;
      height: 1.5rem;
      flex-shrink: 0;
      border-radius: var(--radius-inputs);
      background: var(--color-primary);
      color: var(--color-on-primary);
      font-size: 0.6875rem;
      font-weight: 800;
    }
    .category {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      width: 100%;
      padding: 1rem 0.5rem 0.25rem;
      border: 0;
      background: transparent;
      color: var(--color-text-tertiary);
      font-family: var(--font-sans);
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      cursor: pointer;
      user-select: none;
    }
    .category:hover {
      color: var(--color-text);
    }
    .category__chevron {
      transition: transform 120ms ease;
    }
    .category__chevron--collapsed {
      transform: rotate(-90deg);
    }
    .rail-divider {
      margin: 0.75rem auto;
      width: 1.5rem;
      border-top: 1px solid var(--color-border);
    }
  `,
  template: `
    <nav class="flex h-full w-full flex-col" [attr.aria-label]="t(ariaLabelKey())">
      <!-- Active server -->
      <a
        routerLink="/dashboard"
        class="server-header"
        [class.server-header--collapsed]="collapsed()"
        [appTooltip]="collapsed() ? serverName() : null"
        tooltipPosition="right"
        [attr.aria-label]="serverName()"
        (click)="navigate.emit()"
      >
        <span class="server-header__badge" aria-hidden="true">{{ serverInitial() }}</span>
        @if (!collapsed()) {
          <span class="server-header__name">{{ serverName() }}</span>
          <app-icon name="chevron-down" size="1rem" class="shrink-0 opacity-70" />
        }
      </a>

      <!-- Channel categories -->
      <div class="flex-1 overflow-y-auto px-2 pb-3 scrollbar-thin">
        @for (section of visibleSections(); track section.headingKey) {
          <div>
            @if (!collapsed()) {
              @if (section.headingKey !== 'nav.section.main') {
                <button
                  type="button"
                  class="category"
                  [attr.aria-expanded]="!isCollapsed(section.headingKey)"
                  [attr.aria-controls]="'group-' + section.headingKey"
                  (click)="toggleSection(section.headingKey)"
                >
                  <app-icon
                    name="chevron-down"
                    size="0.75rem"
                    class="category__chevron"
                    [class.category__chevron--collapsed]="isCollapsed(section.headingKey)"
                  />
                  <span>{{ t(section.headingKey) }}</span>
                </button>
              } @else {
                <div class="h-2"></div>
              }
            } @else {
              <div class="rail-divider"></div>
            }
            <ul
              [id]="'group-' + section.headingKey"
              class="flex flex-col gap-0.5"
              role="list"
              [hidden]="!collapsed() && isCollapsed(section.headingKey)"
              [attr.aria-label]="t(section.headingKey)"
            >
              @for (item of section.items; track item.path) {
                <li>
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="nav-link--active"
                    [routerLinkActiveOptions]="{ exact: item.exact === true }"
                    [ariaCurrentWhenActive]="'page'"
                    class="nav-link group"
                    [class.justify-center]="collapsed()"
                    [class.px-0]="collapsed()"
                    [appTooltip]="collapsed() ? t(item.labelKey) : null"
                    tooltipPosition="right"
                    (click)="navigate.emit()"
                  >
                    <app-icon [name]="item.icon" size="1.25rem" class="shrink-0 transition-colors" />
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

      <!-- Collapse toggle (desktop only) -->
      <div class="hidden md:flex px-2 py-2 border-t border-[var(--color-border)]">
        <button
          type="button"
          class="nav-link cursor-pointer"
          [class.justify-center]="collapsed()"
          (click)="toggleCollapse.emit()"
          [appTooltip]="collapsed() ? t('nav.expand') : t('nav.collapse')"
          tooltipPosition="right"
          [attr.aria-label]="collapsed() ? t('nav.expand') : t('nav.collapse')"
        >
          <app-icon [name]="collapsed() ? 'chevron-right' : 'chevrons-left'" size="1.25rem" />
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

  /** Category headings the user folded away, Discord-style. */
  private readonly collapsedSections = signal<ReadonlySet<string>>(new Set());

  protected t = (key: TranslationKey) => this.translate.t(key);

  /**
   * Name of the server currently in scope. Falls back to the product name
   * only while the session has no tenant (e.g. the platform console).
   */
  protected readonly serverName = computed(
    () => this.auth.profile()?.tenant_name?.trim() || this.t('app.title'),
  );

  protected readonly serverInitial = computed(() => this.serverName().charAt(0).toUpperCase());

  protected readonly visibleSections = computed<NavSection[]>(() =>
    filterNavSections(
      this.sections(),
      (permission) => this.auth.hasPermission(permission),
      this.auth.profile()?.is_platform_admin === true,
      (key) => this.auth.profile()?.features?.includes(key) === true,
    ),
  );

  protected isCollapsed(headingKey: string): boolean {
    return this.collapsedSections().has(headingKey);
  }

  protected toggleSection(headingKey: string): void {
    this.collapsedSections.update((current) => {
      const next = new Set(current);
      if (!next.delete(headingKey)) {
        next.add(headingKey);
      }
      return next;
    });
  }
}
