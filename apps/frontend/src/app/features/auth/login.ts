import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService } from '../../core/services/translate.service';
import { ToastService } from '../../core/services/toast.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * Public login landing page.
 *
 * Shown to unauthenticated visitors. After a successful Discord login the
 * backend redirects to `/dashboard`, so this page only triggers the OAuth
 * flow via `AuthService.login()` and offers theme/language controls.
 *
 * If a logged-in user lands here, they are sent straight to `/dashboard`.
 */
@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, WeaklingsLogo],
  template: `
    <div
      class="min-h-dvh flex items-center justify-center p-4 sm:p-6"
      style="background-color: var(--color-bg)"
    >
      <div class="absolute top-4 right-4 flex items-center gap-2">
        <select
          class="select"
          style="width: auto; padding: 0.4rem 0.6rem; font-size: 0.8125rem"
          [value]="translate.language()"
          (change)="onLanguageChange($event)"
          [attr.aria-label]="t('language.label')"
        >
          @for (lang of translate.supportedLanguages; track lang) {
            <option [value]="lang">{{ translate.languageLabels[lang] }}</option>
          }
        </select>
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          (click)="theme.toggle()"
          [attr.aria-label]="t('theme.toggle')"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" />
        </button>
      </div>

      <section class="card w-full max-w-md p-6 sm:p-8" aria-labelledby="login-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo />
          <h1 id="login-title" class="sr-only">{{ t('app.title') }}</h1>
          <p class="mt-1 text-sm" style="color: var(--color-text-secondary)">
            {{ t('auth.login_subtitle') }}
          </p>
        </div>

        <button type="button" class="btn btn--primary w-full" (click)="login()">
          <app-icon name="discord" />
          {{ t('auth.login_discord') }}
        </button>

        <p class="mt-6 text-center text-xs" style="color: var(--color-text-disabled)">
          {{ t('app.tagline') }}
        </p>
      </section>
    </div>
  `,
})
export class Login {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly translate = inject(TranslateService);
  private readonly toasts = inject(ToastService);
  private readonly router = inject(Router);

  constructor() {
    if (this.auth.isAuthenticated()) {
      void this.router.navigateByUrl('/dashboard');
    }
  }

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected login(): void {
    this.auth.login();
  }

  protected onLanguageChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as 'en' | 'it' | 'es';
    this.translate.use(value);
    this.toasts.info(this.translate.languageLabels[value]);
  }
}
