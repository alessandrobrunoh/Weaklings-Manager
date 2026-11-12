import { AUTH_LAYOUT_STYLES } from './auth-layout.styles';
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TenantChoice } from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * Public post-OAuth page: pick which registered Discord server to enter
 * when the user belongs to more than one tenant.
 */
@Component({
  selector: 'app-choose-server',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [AUTH_LAYOUT_STYLES],
  imports: [EmptyState, Icon, Loading, WeaklingsLogo],
  template: `
    <div class="auth-page">
      <main class="auth-main">
        <section class="auth-card" aria-labelledby="choose-server-title">
          <header class="auth-head">
            <app-weaklings-logo [compact]="true" />
            <p class="auth-brand">{{ t('app.title') }}</p>
            <h1 id="choose-server-title" class="auth-title">{{ t('auth.choose_server_title') }}</h1>
            <p class="auth-hint">{{ t('auth.choose_server_subtitle') }}</p>
          </header>

          @if (loading()) {
            <app-loading variant="lines" [rows]="3" [label]="t('common.loading')" />
          } @else if (tenants().length === 0) {
            <app-empty-state icon="shield" [message]="t('auth.choose_server_empty')" [compact]="true" />
            <div class="auth-foot">
              <button type="button" class="btn btn--primary w-full" (click)="auth.login()">
                <app-icon name="discord" />
                {{ t('auth.login_discord') }}
              </button>
            </div>
          } @else {
            <ul class="auth-list" [attr.aria-label]="t('auth.choose_server_title')">
              @for (tenant of tenants(); track tenant.id) {
                <li>
                  <button
                    type="button"
                    class="auth-row"
                    [disabled]="submitting() !== null"
                    (click)="choose(tenant)"
                  >
                    <span class="auth-row__name">{{ tenant.name }}</span>
                    <span class="auth-row__chevron" aria-hidden="true">
                      <app-icon name="chevron-right" size="1rem" />
                    </span>
                  </button>
                </li>
              }
            </ul>
          }

          @if (failed()) {
            <p class="auth-alert mt-4" role="alert">{{ t('auth.choose_server_error') }}</p>
          }
        </section>
      </main>
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
