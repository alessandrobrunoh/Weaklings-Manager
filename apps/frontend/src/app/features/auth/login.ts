import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { TranslateService, type Language } from '../../core/services/translate.service';
import { ToastService } from '../../core/services/toast.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
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
  styles: [COMPACT_FEATURE_STYLES],
  imports: [Icon, Select, TooltipDirective, WeaklingsLogo],
  template: `
    <div class="auth-shell">
      <div class="absolute top-4 right-4 flex items-center gap-2">
        <app-select
          class="w-auto text-xs"
          [value]="translate.language()"
          [options]="languageOptions()"
          [ariaLabel]="t('language.label')"
          [appTooltip]="t('language.label')"
          tooltipPosition="bottom"
          (valueChange)="onLanguageChange($event)"
        />
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          (click)="theme.toggle()"
          [appTooltip]="theme.isDark() ? t('theme.toggleLight') : t('theme.toggleDark')"
          tooltipPosition="bottom"
          [attr.aria-label]="t('theme.toggle')"
        >
          <app-icon [name]="theme.isDark() ? 'moon' : 'sun'" />
        </button>
      </div>

      <section class="auth-card" aria-labelledby="login-title">
        <div class="mb-7 flex flex-col items-center text-center">
          <app-weaklings-logo [compact]="true" />
          <h1 id="login-title" class="auth-card__title mt-5">{{ t('app.title') }}</h1>
          <p class="auth-card__subtitle">{{ t('auth.login_subtitle') }}</p>
        </div>

        @if (noTenant()) {
          <p class="mb-4 text-center text-sm text-[var(--color-error)]" role="alert">
            {{ t('auth.no_tenant') }}
          </p>
        }
        @if (sessionUnreachable()) {
          <p class="mb-4 text-center text-sm text-[var(--color-error)]" role="alert">
            {{ t('auth.session_unreachable') }}
          </p>
          <button type="button" class="btn btn--ghost mb-4 w-full" (click)="retrySession()">
            {{ t('common.retry') }}
          </button>
        }

        <button type="button" class="btn btn--primary w-full" (click)="login()">
          <app-icon name="discord" />
          {{ t('auth.login_discord') }}
        </button>

        <p class="mt-6 text-center text-xs text-[var(--color-text-tertiary)]">
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
  private readonly route = inject(ActivatedRoute);
  protected readonly noTenant = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('error') === 'no_tenant')),
    { initialValue: false },
  );
  protected readonly sessionUnreachable = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('error') === 'session_unreachable')),
    { initialValue: false },
  );

  constructor() {
    const next = this.route.snapshot.queryParamMap.get('next');
    if (this.auth.isAuthenticated()) {
      const profile = this.auth.profile();
      const fallback = profile?.tenant_id ? '/dashboard' : '/needs-tenant';
      void this.router.navigateByUrl(next && next.startsWith('/') ? next : fallback);
    }
  }

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected login(): void {
    const next = this.route.snapshot.queryParamMap.get('next');
    this.auth.login(next && next.startsWith('/') ? next : undefined);
  }

  protected async retrySession(): Promise<void> {
    const profile = await this.auth.load();
    if (!profile) {
      return;
    }
    const next = this.route.snapshot.queryParamMap.get('next');
    const fallback = profile.tenant_id ? '/dashboard' : '/needs-tenant';
    await this.router.navigateByUrl(next && next.startsWith('/') ? next : fallback);
  }

  protected languageOptions(): SelectOption[] {
    return this.translate.supportedLanguages.map((lang) => ({
      value: lang,
      label: this.translate.languageLabels[lang],
    }));
  }

  protected onLanguageChange(value: string): void {
    const language = value as Language;
    this.translate.use(language);
    this.toasts.info(this.translate.languageLabels[language]);
  }
}
