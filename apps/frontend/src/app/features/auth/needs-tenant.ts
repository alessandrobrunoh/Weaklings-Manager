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
    <div
      class="min-h-dvh flex items-center justify-center p-4 sm:p-6"
      style="background-color: var(--color-bg)"
    >
      <section class="card w-full max-w-md p-6 sm:p-8" aria-labelledby="needs-tenant-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo />
          <h1 id="needs-tenant-title" class="mt-4 text-lg font-semibold">
            {{ t('auth.needs_tenant_title') }}
          </h1>
          <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">
            {{ t('auth.needs_tenant_body') }}
          </p>
        </div>

        @if (loading()) {
          <p class="text-center text-sm" style="color: var(--color-text-secondary)">
            {{ t('common.loading') }}
          </p>
        } @else if (guilds().length === 0) {
          <p class="text-sm text-center" style="color: var(--color-text-secondary)">
            {{ t('auth.needs_tenant_empty') }}
          </p>
        } @else {
          <ul class="flex flex-col gap-2">
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
  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    try {
      this.guilds.set(await this.auth.registerableGuilds());
    } catch {
      this.guilds.set([]);
    } finally {
      this.loading.set(false);
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
