import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';

import type { RegisterableGuild } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

/**
 * Shown when the session has no registered tenant. Pick a Discord server
 * to run the onboarding wizard — not the platform admin console.
 */
@Component({
  selector: 'app-needs-tenant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [WeaklingsLogo],
  template: `
    <div class="auth-shell">
      <section class="auth-card" aria-labelledby="needs-tenant-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo [compact]="true" />
          <h1 id="needs-tenant-title" class="auth-card__title mt-5">
            {{ t('auth.needs_tenant_title') }}
          </h1>
          <p class="auth-card__subtitle">{{ t('auth.needs_tenant_body') }}</p>
        </div>

        @if (loading()) {
          <p class="text-center text-sm text-[var(--color-text-secondary)]">
            {{ t('common.loading') }}
          </p>
        } @else if (guilds().length === 0) {
          <p class="text-center text-sm text-[var(--color-text-secondary)]">
            {{ t('auth.needs_tenant_empty') }}
          </p>
        } @else {
          <ul class="flex flex-col gap-2" role="list">
            @for (guild of guilds(); track guild.id) {
              <li>
                <button
                  type="button"
                  class="btn btn--tonal w-full justify-start gap-3"
                  (click)="register(guild)"
                >
                  @if (iconUrl(guild); as src) {
                    <img [src]="src" alt="" class="h-8 w-8 rounded-full" />
                  }
                  <span class="truncate">{{ guild.name }}</span>
                </button>
              </li>
            }
          </ul>
        }

        <!-- The tenant-less visitor cannot reach the in-app guide (it lives
             behind the tenant guard), so the first step of it comes here. -->
        <div class="mt-6 border-t border-[var(--color-border)] pt-5">
          <p class="text-sm text-[var(--color-text-secondary)]">{{ t('addServer.step1.body') }}</p>
          @if (inviteUrl(); as url) {
            <a class="btn btn--tonal mt-3 w-full" [href]="url" target="_blank" rel="noopener noreferrer">
              {{ t('addServer.inviteCta') }}
            </a>
          }
        </div>

        <button type="button" class="btn btn--ghost mt-4 w-full" (click)="logout()">
          {{ t('nav.logout') }}
        </button>
      </section>
    </div>
  `,
})
export class NeedsTenant implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly guilds = signal<RegisterableGuild[]>([]);
  protected readonly loading = signal(true);
  protected readonly inviteUrl = signal<string | null>(null);
  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    void this.loadInvite();
    try {
      this.guilds.set(await this.auth.registerableGuilds());
    } catch {
      this.guilds.set([]);
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
    await this.auth.logout();
    window.location.href = '/login';
  }
}
