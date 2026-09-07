import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';

import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Avatar } from '../../shared/components/avatar/avatar';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { NotificationsPanel } from './notifications-panel';

/** Static nav definition, also reused by the shell as the source of truth. */
import type { NavSection } from '../sidebar/sidebar';

/**
 * Channel header.
 *
 * Discord puts the open channel on the left of this bar and the utility
 * icons on the right; the equivalent here is the open route, prefixed by
 * the server it belongs to on wide screens.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Icon, NotificationsPanel, RouterLink, TooltipDirective],
  styles: `
    :host {
      display: block;
      width: 100%;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 30;
    }
    .topbar {
      height: var(--chrome-height, 3rem);
      background: var(--color-chrome);
      border-bottom: 1px solid var(--color-border);
    }
    .topbar__route {
      display: flex;
      min-width: 0;
      align-items: center;
      gap: 0.375rem;
      font-family: var(--font-sans);
      font-size: 0.9375rem;
      font-weight: 700;
      color: var(--color-text);
      letter-spacing: -0.005em;
    }
    .topbar__server {
      color: var(--color-text-tertiary);
      font-weight: 500;
    }
    .topbar__sep {
      width: 1px;
      height: 1.25rem;
      background: var(--color-border);
    }
    .topbar__utilities {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 0.25rem;
    }
  `,
  template: `
    <header
      class="topbar flex items-center justify-between gap-3 px-3 sm:px-4"
      aria-label="Application toolbar"
    >
      <div class="flex min-w-0 items-center gap-2">
        <!-- Mobile menu toggle -->
        <button
          type="button"
          class="btn btn--ghost btn--icon md:hidden"
          (click)="menuToggle.emit()"
          [appTooltip]="t('nav.openMenu')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('nav.openMenu')"
        >
          <app-icon name="menu" size="1.25rem" />
        </button>

        <!-- Open route, in the position Discord gives the open channel -->
        <div class="topbar__route">
          <app-icon
            name="hash"
            size="1.25rem"
            class="shrink-0 text-[var(--color-text-tertiary)]"
          />
          <span class="truncate">{{ currentRouteTitle() }}</span>
          @if (serverName(); as server) {
            <span class="topbar__sep hidden lg:block mx-2" aria-hidden="true"></span>
            <span class="topbar__server hidden truncate lg:inline">{{ server }}</span>
          }
        </div>
      </div>

      <div class="topbar__utilities">
        <!-- Language selector -->
        <div class="relative hidden items-center sm:flex">
          <select
            class="select select--sm cursor-pointer w-auto"
            [value]="translate.language()"
            (change)="onLanguageChange($event)"
            [appTooltip]="t('language.label')"
            tooltipPosition="bottom"
            [attr.aria-label]="t('language.label')"
          >
            @for (lang of translate.supportedLanguages; track lang) {
              <option [value]="lang">{{ translate.languageLabels[lang] }}</option>
            }
          </select>
        </div>

        <!-- Theme toggle -->
        <button
          type="button"
          class="btn btn--ghost btn--icon shrink-0"
          (click)="theme.toggle()"
          [appTooltip]="theme.isDark() ? t('theme.toggleLight') : t('theme.toggleDark')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('theme.toggle')"
          [attr.aria-pressed]="theme.isDark()"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" size="1.125rem" />
        </button>

        <!-- Notifications panel -->
        <app-notifications-panel />

        <!-- User profile capsule & logout button -->
        @if (auth.profile(); as profile) {
          <div class="ml-1 flex shrink-0 items-center gap-2 border-l border-[var(--color-border)] pl-2">
            <a
              routerLink="/profile"
              class="inline-flex rounded-full transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
              [appTooltip]="profile.username + (profile.highest_role ? ' (' + profile.highest_role + ')' : '')"
              tooltipPosition="bottom"
              aria-label="User profile"
            >
              <app-avatar
                [userId]="profile.id"
                [avatar]="profile.avatar"
                [username]="profile.username"
                size="sm"
              />
            </a>

            <div class="hidden min-w-0 flex-col leading-tight xl:flex">
              <span class="max-w-[110px] truncate text-xs font-semibold text-[var(--color-text)]">{{ profile.username }}</span>
              <span class="max-w-[110px] truncate text-[10px] text-[var(--color-text-tertiary)]">{{ profile.highest_role }}</span>
            </div>

            <button
              type="button"
              class="btn btn--ghost btn--icon shrink-0 hover:text-[var(--color-error)]"
              (click)="onLogout()"
              [appTooltip]="t('nav.logout')"
              tooltipPosition="bottom"
              [attr.aria-label]="t('nav.logout')"
            >
              <app-icon name="logout" size="1.125rem" />
            </button>
          </div>
        } @else {
          <button type="button" class="btn btn--primary btn--sm" (click)="auth.login()">
            {{ t('auth.login_discord') }}
          </button>
        }
      </div>
    </header>

    <!-- Toasts -->
    <div
      class="pointer-events-none fixed right-4 top-4 z-50 flex w-full max-w-sm flex-col gap-2"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      @for (toast of toasts.toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-center justify-between gap-3 rounded-[var(--radius-cards)] border bg-[var(--color-surface)] px-3.5 py-2.5 shadow-[var(--shadow-xl)]"
          [style.borderColor]="toastBorderColor(toast.kind)"
        >
          <div class="flex min-w-0 items-center gap-2.5">
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-inputs)] text-xs"
              [class]="toastIconClasses(toast.kind)"
            >
              <app-icon [name]="iconFor(toast.kind)" size="0.875rem" />
            </span>
            <span class="truncate text-xs font-medium text-[var(--color-text)]">{{ toast.message }}</span>
          </div>
          <button
            type="button"
            class="p-1 text-xs text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text)]"
            (click)="toasts.dismiss(toast.id)"
            aria-label="Dismiss"
          >
            <app-icon name="close" size="0.875rem" />
          </button>
        </div>
      }
    </div>
  `,
})
export class Topbar {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly translate = inject(TranslateService);
  protected readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly currentUrl = signal(this.router.url);
  protected readonly isDashboard = computed(() => this.checkIsDashboard(this.currentUrl()));

  /** Server currently in scope, shown next to the route on wide screens. */
  protected readonly serverName = computed(() => this.auth.profile()?.tenant_name?.trim() ?? '');

  protected readonly currentRouteTitle = computed(() => {
    const url = this.currentUrl();
    const path = url.split('?')[0].split('#')[0];
    if (path === '' || path === '/' || path === '/dashboard') return this.t('nav.dashboard');
    if (path.startsWith('/season')) return this.t('nav.season');
    if (path.startsWith('/events')) return this.t('nav.events');
    if (path.startsWith('/comps')) return this.t('nav.comps');
    if (path.startsWith('/battles')) return this.t('nav.battles');
    if (path.startsWith('/fights')) return 'Fights';
    if (path.startsWith('/intel')) return this.t('nav.intel');
    if (path.startsWith('/bank')) return this.t('nav.bank');
    if (path.startsWith('/splits')) return this.t('nav.splits');
    if (path.startsWith('/regears')) return this.t('nav.regears');
    if (path.startsWith('/siphoned')) return this.t('nav.siphoned');
    if (path.startsWith('/users')) return this.t('nav.users');
    if (path.startsWith('/warns')) return this.t('nav.warns');
    if (path.startsWith('/admin')) return this.t('nav.admin');
    if (path.startsWith('/platform')) return this.t('nav.platform');
    if (path.startsWith('/audit')) return this.t('nav.audit');
    if (path.startsWith('/add-server')) return this.t('addServer.title');
    if (path.startsWith('/profile')) return 'Profile';
    if (path.startsWith('/settings')) return 'Settings';
    return this.t('app.title');
  });

  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((event) => {
        this.currentUrl.set(event.urlAfterRedirects);
      });
  }

  private checkIsDashboard(url: string): boolean {
    const path = url.split('?')[0].split('#')[0];
    return path === '' || path === '/' || path === '/dashboard';
  }

  readonly menuToggle = output<void>();

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected iconFor(kind: 'success' | 'error' | 'info'): IconName {
    if (kind === 'success') {
      return 'check';
    }
    if (kind === 'error') {
      return 'alert';
    }
    return 'info';
  }

  protected toastBorderColor(kind: 'success' | 'error' | 'info'): string {
    if (kind === 'success') return 'color-mix(in srgb, var(--color-success) 30%, transparent)';
    if (kind === 'error') return 'color-mix(in srgb, var(--color-error) 30%, transparent)';
    return 'color-mix(in srgb, var(--color-info) 30%, transparent)';
  }

  protected toastIconClasses(kind: 'success' | 'error' | 'info'): string {
    if (kind === 'success') return 'bg-[var(--color-success-container)] text-[var(--color-success)]';
    if (kind === 'error') return 'bg-[var(--color-error-container)] text-[var(--color-error)]';
    return 'bg-[var(--color-info-container)] text-[var(--color-info)]';
  }

  protected onLanguageChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as Language;
    this.translate.use(value);
  }

  protected async onLogout(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}

/** Re-export so shell can import the type from a single place. */
export type { NavSection };
