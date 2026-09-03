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
 * Top application bar.
 *
 * Precision midnight Linear design aligning with the Weaklings dashboard.
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
      height: 3.5rem;
      background: color-mix(in srgb, var(--color-surface) 95%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--color-border);
    }
    .topbar__utilities {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 0.5rem;
    }
  `,
  template: `
    <header
      class="topbar flex items-center justify-between gap-3 px-4 sm:px-6 transition-colors"
      [class.md:hidden]="isDashboard()"
      aria-label="Application toolbar"
    >
      <div class="flex min-w-0 items-center gap-3">
        <!-- Mobile menu toggle -->
        <button
          type="button"
          class="btn btn--ghost btn--icon md:hidden text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          (click)="menuToggle.emit()"
          [appTooltip]="t('nav.openMenu')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('nav.openMenu')"
        >
          <app-icon name="menu" size="1.125rem" />
        </button>

        <!-- Route Context / Breadcrumb -->
        <div class="hidden sm:flex items-center gap-2 text-xs font-semibold select-none">
          <span class="text-[var(--color-text-tertiary)] font-normal">Weaklings</span>
          <span class="text-[var(--color-text-disabled)]">/</span>
          <span class="text-[var(--color-text)] tracking-wide">{{ currentRouteTitle() }}</span>
        </div>
      </div>

      <div class="topbar__utilities">
        <!-- Language selector -->
        <div class="relative hidden items-center sm:flex">
          <select
            class="cursor-pointer font-medium text-xs bg-[color-mix(in_srgb,var(--color-paper)_4%,transparent)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] rounded-[var(--radius-buttons)] px-2.5 py-1.5 transition-all outline-none"
            [value]="translate.language()"
            (change)="onLanguageChange($event)"
            [appTooltip]="t('language.label')"
            tooltipPosition="bottom"
            [attr.aria-label]="t('language.label')"
          >
            @for (lang of translate.supportedLanguages; track lang) {
              <option [value]="lang" class="bg-[var(--color-surface-2)] text-[var(--color-text)]">{{ translate.languageLabels[lang] }}</option>
            }
          </select>
        </div>

        <!-- Theme toggle -->
        <button
          type="button"
          class="btn btn--ghost btn--icon shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          (click)="theme.toggle()"
          [appTooltip]="theme.isDark() ? t('theme.toggleLight') : t('theme.toggleDark')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('theme.toggle')"
          [attr.aria-pressed]="theme.isDark()"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" size="1rem" />
        </button>

        <app-notifications-panel />

        <!-- User profile capsule -->
        @if (auth.profile(); as profile) {
          <div class="flex shrink-0 items-center gap-2 pl-2.5 border-l border-[var(--color-border)]">
            <a
              routerLink="/profile"
              class="inline-flex rounded-[var(--radius-pills)] transition-transform hover:scale-105"
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

            <div class="hidden xl:flex flex-col min-w-0 leading-tight">
              <span class="text-xs font-medium text-[var(--color-text)] truncate max-w-[100px]">{{ profile.username }}</span>
              <span class="text-[10px] text-[var(--color-text-tertiary)] truncate max-w-[100px]">{{ profile.highest_role }}</span>
            </div>

            <button
              type="button"
              class="btn btn--ghost btn--icon shrink-0 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
              (click)="onLogout()"
              [appTooltip]="t('nav.logout')"
              tooltipPosition="bottom"
              [attr.aria-label]="t('nav.logout')"
            >
              <app-icon name="logout" size="0.95rem" />
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
      class="pointer-events-none fixed right-4 top-4 z-50 flex flex-col gap-2 max-w-sm w-full"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      @for (toast of toasts.toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-center justify-between gap-3 rounded-[var(--radius-cards)] px-3.5 py-2.5 shadow-2xl border transition-all bg-[var(--color-surface)]"
          [style.borderColor]="toastBorderColor(toast.kind)"
        >
          <div class="flex items-center gap-2.5 min-w-0">
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs"
              [class]="toastIconClasses(toast.kind)"
            >
              <app-icon [name]="iconFor(toast.kind)" size="0.875rem" />
            </span>
            <span class="text-xs font-medium text-[var(--color-text)] truncate">{{ toast.message }}</span>
          </div>
          <button
            type="button"
            class="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] transition-colors p-1"
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
    if (path.startsWith('/audit')) return this.t('nav.audit');
    if (path.startsWith('/profile')) return 'Profile';
    if (path.startsWith('/settings')) return 'Settings';
    return 'Weaklings';
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
    return 'bg-[color-mix(in_srgb,var(--color-info)_15%,transparent)] text-[var(--color-info)]';
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

