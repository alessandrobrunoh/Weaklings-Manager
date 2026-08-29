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
  styles: `
    :host {
      display: block;
      width: 100%;
      flex-shrink: 0;
    }
  `,
  template: `
    <header
      class="flex h-16 items-center justify-between gap-3 px-4 sm:px-6"
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

      <!-- Controls group -->
      <div class="flex items-center gap-3 shrink-0">
        <!-- Language picker -->
        <label class="flex items-center gap-1.5" [attr.aria-label]="t('language.label')">
          <select
            class="select text-xs"
            style="width: auto; padding: 0.35rem 0.6rem;"
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
          class="btn btn--ghost shrink-0"
          style="min-width: 36px; padding: 0.45rem"
          (click)="theme.toggle()"
          [attr.aria-label]="t('theme.toggle')"
          [attr.aria-pressed]="theme.isDark()"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" size="1rem" />
        </button>

        <!-- User menu -->
        @if (auth.profile(); as profile) {
          <div class="flex items-center gap-2.5 pl-2 shrink-0" style="border-left: 1px solid var(--color-border)">
            <div class="hidden sm:flex flex-col items-end leading-none whitespace-nowrap">
              <span class="text-xs font-medium" style="color: var(--color-text)">
                {{ profile.username }}
              </span>
              <span
                class="eyebrow text-[9px] mt-0.5"
                style="color: var(--color-text-secondary)"
              >
                {{ profile.highest_role }}
              </span>
            </div>
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
              style="background-color: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border)"
              [attr.aria-label]="profile.username + ' · ' + profile.highest_role"
              [title]="profile.username + ' · ' + profile.highest_role"
            >
              {{ initials(profile.username) }}
            </span>
            <button
              type="button"
              class="btn btn--outline btn--sm shrink-0"
              (click)="onLogout()"
            >
              {{ t('nav.logout') }}
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
