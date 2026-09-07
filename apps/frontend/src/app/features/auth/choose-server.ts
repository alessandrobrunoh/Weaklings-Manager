import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TenantChoice } from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * Public post-OAuth page: pick which registered Discord server to enter
 * when the user belongs to more than one tenant.
 */
@Component({
  selector: 'app-choose-server',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, WeaklingsLogo],
  template: `
    <div class="auth-shell">
      <section class="auth-card" aria-labelledby="choose-server-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo [compact]="true" />
          <h1 id="choose-server-title" class="auth-card__title mt-5">
            {{ t('auth.choose_server_title') }}
          </h1>
          <p class="auth-card__subtitle">{{ t('auth.choose_server_subtitle') }}</p>
        </div>

        @if (loading()) {
          <p class="text-center text-sm text-[var(--color-text-secondary)]">
            {{ t('common.loading') }}
          </p>
        } @else if (tenants().length === 0) {
          <p class="text-center text-sm text-[var(--color-error)]">
            {{ t('auth.choose_server_empty') }}
          </p>
          <button type="button" class="btn btn--primary mt-4 w-full" (click)="auth.login()">
            <app-icon name="discord" />
            {{ t('auth.login_discord') }}
          </button>
        } @else {
          <ul class="flex flex-col gap-2">
            @for (tenant of tenants(); track tenant.id) {
              <li>
                <button
                  type="button"
                  class="btn btn--tonal w-full justify-start"
                  [disabled]="submitting() === tenant.id"
                  (click)="choose(tenant)"
                >
                  {{ tenant.name }}
                </button>
              </li>
            }
          </ul>
        }

        @if (failed()) {
          <p class="mt-4 text-center text-sm text-[var(--color-error)]" role="alert">
            {{ t('auth.choose_server_error') }}
          </p>
        }
      </section>
    </div>
  `,
})
export class ChooseServer implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly tenants = signal<TenantChoice[]>([]);
  protected readonly loading = signal(true);
  protected readonly submitting = signal<string | null>(null);
  protected readonly failed = signal(false);
  protected readonly translate = inject(TranslateService);
  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    try {
      this.tenants.set(await this.auth.pendingTenants());
    } catch {
      await this.router.navigateByUrl('/login');
    } finally {
      this.loading.set(false);
    }
  }

  protected async choose(tenant: TenantChoice): Promise<void> {
    this.failed.set(false);
    this.submitting.set(tenant.id);
    try {
      await this.auth.selectTenant(tenant.id);
      await this.router.navigateByUrl('/dashboard');
    } catch {
      this.failed.set(true);
    } finally {
      this.submitting.set(null);
    }
  }
}
