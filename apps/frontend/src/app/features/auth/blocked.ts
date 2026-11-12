import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * "Your access has been blocked" screen.
 *
 * Public route: a blocked member has no usable session, so nothing here needs the API. It is
 * reached from the OAuth callback (login refused), from the route guards and from the
 * `accessBlockedInterceptor` (blocked while signed in). The text is deliberately generic: the
 * officer's reason is never shown to the member.
 */
@Component({
  selector: 'app-blocked',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [Icon, WeaklingsLogo],
  template: `
    <div class="auth-shell">
      <section class="auth-card" aria-labelledby="blocked-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo [compact]="true" />
          <span
            class="mt-5 inline-flex h-12 w-12 items-center justify-center rounded-full"
            style="background: var(--color-error-container); color: var(--color-error)"
          >
            <app-icon name="user-x" size="1.5rem" />
          </span>
          <h1 id="blocked-title" class="auth-card__title mt-4">{{ t('blocked.title') }}</h1>
          <p class="auth-card__subtitle">{{ t('blocked.body') }}</p>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
            {{ t('blocked.help') }}
          </p>
        </div>

        @if (stillBlocked()) {
          <p class="mb-3 text-center text-sm" style="color: var(--color-error)" role="status">
            {{ t('blocked.stillBlocked') }}
          </p>
        }
        @if (logoutError()) {
          <p class="mb-3 text-center text-sm" style="color: var(--color-error)" role="alert">
            {{ logoutError() }}
          </p>
        }

        <div class="flex flex-col gap-2">
          <button type="button" class="btn btn--tonal w-full" [disabled]="checking()" (click)="check()">
            <app-icon name="refresh" size="1rem" />
            {{ t('blocked.check') }}
          </button>
          <button type="button" class="btn btn--ghost w-full" (click)="logout()">
            {{ t('blocked.logout') }}
          </button>
        </div>
      </section>
    </div>
  `,
})
export class Blocked {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly checking = signal(false);
  protected readonly stillBlocked = signal(false);
  protected readonly logoutError = signal<string | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  /** Probes the session again: an officer may have lifted the block meanwhile. */
  protected async check(): Promise<void> {
    if (this.checking()) {
      return;
    }
    this.checking.set(true);
    this.stillBlocked.set(false);
    try {
      const profile = await this.auth.load();
      if (profile) {
        await this.router.navigate(['/dashboard']);
      } else if (this.auth.accessBlocked()) {
        this.stillBlocked.set(true);
      } else {
        // No session left (the block stopped login): sign in again to find out.
        await this.router.navigate(['/login']);
      }
    } finally {
      this.checking.set(false);
    }
  }

  protected async logout(): Promise<void> {
    this.logoutError.set(null);
    try {
      await this.auth.logout();
    } catch {
      this.logoutError.set(this.translate.t('auth.logout_failed'));
      return;
    }
    window.location.href = '/login';
  }
}
