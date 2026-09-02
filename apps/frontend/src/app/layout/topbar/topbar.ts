import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { Router } from '@angular/router';

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
 * Contains only workspace navigation and personal utility controls. Page titles
 * belong to the contextual page header below, not to this global toolbar.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, Icon, NotificationsPanel, TooltipDirective],
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
      min-block-size: 3.25rem;
      background: var(--color-surface-1);
      border-block-end: 1px solid var(--color-border-strong);
      box-shadow: 0 0.25rem 1rem color-mix(in srgb, var(--color-void) 28%, transparent);
    }
    .topbar__context {
      color: var(--color-text-secondary);
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      line-height: 1;
      text-transform: uppercase;
    }
    .topbar__utilities {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      gap: 0.375rem;
    }
    .topbar .btn--ghost:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .topbar .select {
      min-block-size: 2rem;
      border-color: var(--color-border-strong);
      color: var(--color-text);
    }
  `,
  template: `
    <header
      class="topbar flex items-center justify-between gap-2 px-3 sm:px-4 transition-colors"
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
          <app-icon name="menu" size="1.125rem" />
        </button>
        <span class="topbar__context hidden md:inline">Weaklings Manager</span>
      </div>

      <div class="topbar__utilities">
        <div class="relative hidden items-center lg:flex">
          <select
            class="select select--sm w-auto cursor-pointer font-medium text-xs bg-(--color-surface-2)"
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
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" size="1rem" />
        </button>

        <app-notifications-panel />

        <!-- User profile capsule -->
        @if (auth.profile(); as profile) {
          <div class="flex shrink-0 items-center gap-1">
            <app-avatar
              [userId]="profile.id"
              [avatar]="profile.avatar"
              [username]="profile.username"
              size="sm"
              [appTooltip]="profile.username + ' (' + profile.highest_role + ')'"
              tooltipPosition="bottom"
            />

            <button
              type="button"
              class="btn btn--ghost btn--icon shrink-0 text-xs font-medium"
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
      class="pointer-events-none fixed right-4 top-4 z-50 flex flex-col gap-2"
      role="region"
      aria-live="polite"
      aria-label="Notifications"
    >
      @for (toast of toasts.toasts(); track toast.id) {
        <div
          class="pointer-events-auto flex items-center gap-3 rounded-md px-3 py-2.5 text-sm"
          style="background-color: var(--color-surface); border: 1px solid var(--color-border-strong); box-shadow: var(--shadow-xl)"
        >
          <app-icon [name]="iconFor(toast.kind)" size="1rem" />
          <span style="color: var(--color-text)">{{ toast.message }}</span>
          <button
            type="button"
            class="ml-2 text-xs opacity-60 hover:opacity-100"
            style="background: none; border: none; cursor: pointer; color: var(--color-text-secondary)"
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

