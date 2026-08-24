import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';

/** Static nav definition, also reused by the shell as the source of truth. */
import type { NavSection } from '../sidebar/sidebar';

/**
 * Top application bar.
 *
 * Contains the menu toggle (mobile), the language picker, the theme toggle,
 * and the user menu (avatar + name + sign-out). Purely presentational;
 * it delegates actions to the relevant services.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <header
      class="flex h-16 items-center gap-3 px-4"
      style="background-color: var(--color-surface); border-bottom: 1px solid var(--color-border)"
    >
      <!-- Mobile menu toggle -->
      <button
        type="button"
        class="btn btn--ghost md:hidden"
        style="min-width: 40px; padding: 0.5rem"
        (click)="menuToggle.emit()"
        [attr.aria-label]="t('nav.openMenu')"
      >
        <app-icon name="menu" />
      </button>

      <div class="flex-1"></div>

      <!-- Language picker: visible at every width. It used to be hidden
           below sm, and there is no language control anywhere in the sidebar
           or drawer either — a mobile user could not change language at all. -->
      <label class="flex items-center gap-2" [attr.aria-label]="t('language.label')">
        <select
          class="select"
          style="width: auto; padding: 0.4rem 0.6rem; font-size: 0.8125rem"
          [value]="translate.language()"
          (change)="onLanguageChange($event)"
        >
          @for (lang of translate.supportedLanguages; track lang) {
            <option [value]="lang">{{ translate.languageLabels[lang] }}</option>
          }
        </select>
      </label>

      <!-- Theme toggle -->
      <button
        type="button"
        class="btn btn--ghost"
        style="min-width: 40px; padding: 0.5rem"
        (click)="theme.toggle()"
        [attr.aria-label]="t('theme.toggle')"
        [attr.aria-pressed]="theme.isDark()"
      >
        <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" />
      </button>

      <!-- User menu -->
      @if (auth.profile(); as profile) {
        <div class="flex items-center gap-2">
          <span class="hidden sm:flex flex-col items-end leading-tight">
            <span class="text-sm font-medium" style="color: var(--color-text)">
              {{ profile.username }}
            </span>
            <span
              class="text-[11px] font-semibold uppercase tracking-wide"
              style="color: var(--color-primary)"
            >
              {{ profile.highest_role }}
            </span>
          </span>
          <span
            class="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
            style="background-color: var(--color-primary-container); color: var(--color-primary)"
            [attr.aria-label]="profile.username + ' · ' + profile.highest_role"
            [title]="profile.username + ' · ' + profile.highest_role"
          >
            {{ initials(profile.username) }}
          </span>
          <button
            type="button"
            class="btn btn--outline"
            style="padding: 0.4rem 0.9rem"
            (click)="onLogout()"
          >
            {{ t('nav.logout') }}
          </button>
        </div>
      } @else {
        <button type="button" class="btn btn--primary" (click)="auth.login()">
          {{ t('auth.login_discord') }}
        </button>
      }
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
          class="pointer-events-auto flex items-center gap-3 rounded-lg px-4 py-3 text-sm shadow-md"
          style="background-color: var(--color-surface); border: 1px solid var(--color-border)"
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

  /** Emits when the mobile menu button is clicked. */
  readonly menuToggle = output<void>();

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('');
  }

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
