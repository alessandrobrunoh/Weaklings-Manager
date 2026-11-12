import { AUTH_LAYOUT_STYLES } from './auth-layout.styles';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';

import type { RegisterableGuild } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * Shown when the session has no registered tenant. Pick a Discord server
 * to run the onboarding wizard — not the platform admin console.
 */
@Component({
  selector: 'app-needs-tenant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [AUTH_LAYOUT_STYLES],
  imports: [EmptyState, ErrorState, Icon, Loading, WeaklingsLogo],
  template: `
    <div class="auth-page">
      <main class="auth-main">
        <section class="auth-card" aria-labelledby="needs-tenant-title">
          <header class="auth-head">
            <app-weaklings-logo [compact]="true" />
            <p class="auth-brand">{{ t('app.title') }}</p>
            <h1 id="needs-tenant-title" class="auth-title">{{ t('auth.needs_tenant_title') }}</h1>
            <p class="auth-hint">{{ t('auth.needs_tenant_body') }}</p>
          </header>

          @if (loading()) {
            <app-loading variant="lines" [rows]="3" [label]="t('common.loading')" />
          } @else if (loadFailed()) {
            <app-error-state [retryLabel]="t('common.retry')" (retry)="loadGuilds()" />
          } @else if (!hasGuilds()) {
            <app-empty-state icon="shield" [message]="t('auth.needs_tenant_empty')" [compact]="true" />
          } @else {
            <ul class="auth-list" [attr.aria-label]="t('auth.needs_tenant_title')">
              @for (guild of guilds(); track guild.id) {
                <li>
                  <button type="button" class="auth-row" (click)="register(guild)">
                    @if (iconUrl(guild); as src) {
                      <img [src]="src" alt="" class="auth-row__icon" />
                    }
                    <span class="auth-row__name">{{ guild.name }}</span>
                    <span class="auth-row__chevron" aria-hidden="true">
                      <app-icon name="chevron-right" size="1rem" />
                    </span>
                  </button>
                </li>
              }
            </ul>
          }

          <!-- The tenant-less visitor cannot reach the in-app guide (it lives
               behind the tenant guard), so the first step of it comes here. -->
          @if (inviteUrl(); as url) {
            <div class="auth-foot">
              <p class="auth-hint">{{ t('addServer.step1.body') }}</p>
              <a
                class="btn w-full no-underline"
                [class.btn--primary]="!hasGuilds()"
                [class.btn--outline]="hasGuilds()"
                [href]="url"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ t('addServer.inviteCta') }}
              </a>
            </div>
          }

          <div class="auth-foot">
            @if (logoutError()) {
              <p class="auth-alert" role="alert">{{ logoutError() }}</p>
            }
            <button type="button" class="btn btn--ghost w-full" (click)="logout()">
              {{ t('nav.logout') }}
            </button>
          </div>
        </section>
      </main>
    </div>
  `,
})
export class NeedsTenant implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly guilds = signal<RegisterableGuild[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly hasGuilds = computed(() => this.guilds().length > 0);
  protected readonly inviteUrl = signal<string | null>(null);
  protected readonly logoutError = signal<string | null>(null);
  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    void this.loadInvite();
    await this.loadGuilds();
  }

  /** A failed load is an error with a retry, never the empty copy. */
  protected async loadGuilds(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      this.guilds.set(await this.auth.registerableGuilds());
    } catch {
      this.guilds.set([]);
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadInvite(): Promise<void> {
    try {
      this.inviteUrl.set((await this.auth.botInvite()).url);
    } catch {
      this.inviteUrl.set(null);
    }
  }

  protected iconUrl(guild: RegisterableGuild): string | null {
    return discordGuildIconUrl(guild.id, guild.icon_hash);
  }

  protected async register(guild: RegisterableGuild): Promise<void> {
    await this.router.navigate(['/register-tenant'], { queryParams: { guild: guild.id, name: guild.name } });
  }

  protected async logout(): Promise<void> {
    this.logoutError.set(null);
    try {
      await this.auth.logout();
    } catch {
      this.logoutError.set(this.t('auth.logout_failed'));
      return;
    }
    window.location.href = '/login';
  }
}
