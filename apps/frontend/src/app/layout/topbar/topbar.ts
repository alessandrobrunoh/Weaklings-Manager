import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { NotificationsPanel } from './notifications-panel';

/** Static nav definition, also reused by the shell as the source of truth. */
import type { NavSection } from '../sidebar/sidebar';

/**
 * Top application bar.
 *
 * Contains the menu toggle (mobile), desktop collapse toggle, live UTC clock,
 * language picker, theme toggle, and user profile capsule with tooltips.
 */
@Component({
  selector: 'app-topbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NotificationsPanel, TooltipDirective],
  styles: `
    :host {
      display: block;
      width: 100%;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      z-index: 30;
    }
  `,
  template: `
    <header
      class="flex h-14 items-center justify-between gap-3 px-4 sm:px-6 backdrop-blur-md transition-colors"
      style="background-color: color-mix(in srgb, var(--color-surface) 92%, transparent); border-bottom: 1px solid var(--color-border)"
    >
      <div class="flex items-center gap-2">
        <!-- Mobile menu toggle -->
        <button
          type="button"
          class="btn btn--ghost md:hidden"
          style="min-width: 36px; padding: 0.4rem"
          (click)="menuToggle.emit()"
          [appTooltip]="t('nav.openMenu')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('nav.openMenu')"
        >
          <app-icon name="menu" size="1.125rem" />
        </button>

        <!-- Desktop sidebar collapse toggle -->
        <button
          type="button"
          class="btn btn--ghost hidden md:inline-flex"
          style="min-width: 34px; height: 34px; padding: 0.35rem"
          (click)="collapseToggle.emit()"
          [appTooltip]="isSidebarCollapsed() ? 'Espandi barra laterale' : 'Comprimi barra laterale'"
          tooltipPosition="bottom"
          [attr.aria-label]="isSidebarCollapsed() ? 'Expand sidebar' : 'Collapse sidebar'"
        >
          <app-icon [name]="isSidebarCollapsed() ? 'chevron-right' : 'chevron-left'" size="0.95rem" />
        </button>
      </div>

      <!-- Center / Right controls -->
      <div class="flex items-center gap-2.5 sm:gap-3 shrink-0">
        <!-- Albion Server UTC Clock -->
        <div
          class="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs mono"
          style="background-color: var(--color-surface-2); border: 1px solid var(--color-border); color: var(--color-text-secondary)"
          [appTooltip]="'Albion Online Server Time (UTC)'"
          tooltipPosition="bottom"
        >
          <span class="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style="background-color: var(--color-success)"></span>
          <span>{{ utcTime() }}</span>
        </div>

        <!-- Language picker -->
        <div class="relative flex items-center">
          <select
            class="select text-xs cursor-pointer font-medium"
            style="width: auto; height: 32px; padding: 0.25rem 0.6rem; border-radius: 6px; background-color: var(--color-surface-2); border-color: var(--color-border)"
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
          class="btn btn--ghost shrink-0"
          style="min-width: 34px; height: 34px; padding: 0.35rem; border-radius: 6px;"
          (click)="theme.toggle()"
          [appTooltip]="theme.isDark() ? 'Attiva tema chiaro' : 'Attiva tema scuro'"
          tooltipPosition="bottom"
          [attr.aria-label]="t('theme.toggle')"
          [attr.aria-pressed]="theme.isDark()"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" size="1rem" />
        </button>

        <app-notifications-panel />

        <!-- User profile capsule -->
        @if (auth.profile(); as profile) {
          <div
            class="flex items-center gap-2 pl-2 sm:pl-3 shrink-0"
            style="border-left: 1px solid var(--color-border)"
          >
            <div
              class="hidden sm:flex flex-col items-end leading-none whitespace-nowrap cursor-default"
              [appTooltip]="profile.username + ' · ' + profile.highest_role"
              tooltipPosition="bottom"
            >
              <span class="text-xs font-semibold" style="color: var(--color-text)">
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
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold select-none cursor-default"
              style="background-color: var(--color-surface-2); color: var(--color-text); border: 1px solid var(--color-border)"
              [appTooltip]="profile.username + ' (' + profile.highest_role + ')'"
              tooltipPosition="bottom"
            >
              {{ initials(profile.username) }}
            </span>

            <button
              type="button"
              class="btn btn--ghost shrink-0 text-xs font-medium"
              style="min-width: 32px; height: 32px; padding: 0.3rem"
              (click)="onLogout()"
              [appTooltip]="t('nav.logout')"
              tooltipPosition="bottom"
              [attr.aria-label]="t('nav.logout')"
            >
              <app-icon name="close" size="0.875rem" />
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
  private readonly destroyRef = inject(DestroyRef);

  readonly menuToggle = output<void>();
  readonly collapseToggle = output<void>();
  readonly isSidebarCollapsed = input<boolean>(false);

  protected readonly utcTime = signal(this.getUtcTimeString());

  constructor() {
    if (typeof window !== 'undefined') {
      const timer = setInterval(() => {
        this.utcTime.set(this.getUtcTimeString());
      }, 1000);
      this.destroyRef.onDestroy(() => clearInterval(timer));
    }
  }

  private getUtcTimeString(): string {
    const d = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
  }

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

