import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type { RegisterableGuild } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon, type IconName } from '../../shared/components/icon/icon';

/** One numbered card in the walkthrough. */
interface Step {
  readonly n: number;
  readonly icon: IconName;
  readonly titleKey: TranslationKey;
  readonly bodyKey: TranslationKey;
}

const STEPS: readonly Step[] = [
  { n: 1, icon: 'discord', titleKey: 'addServer.step1.title', bodyKey: 'addServer.step1.body' },
  { n: 2, icon: 'plus', titleKey: 'addServer.step2.title', bodyKey: 'addServer.step2.body' },
  { n: 3, icon: 'shield', titleKey: 'addServer.step3.title', bodyKey: 'addServer.step3.body' },
  { n: 4, icon: 'sparkles', titleKey: 'addServer.step4.title', bodyKey: 'addServer.step4.body' },
  { n: 5, icon: 'users', titleKey: 'addServer.step5.title', bodyKey: 'addServer.step5.body' },
];

const FAQ: readonly { readonly q: TranslationKey; readonly a: TranslationKey }[] = [
  { q: 'addServer.faq.q1', a: 'addServer.faq.a1' },
  { q: 'addServer.faq.q2', a: 'addServer.faq.a2' },
  { q: 'addServer.faq.q3', a: 'addServer.faq.a3' },
];

/**
 * "Add a server" guide, reached from the `+` orb at the bottom of the server
 * rail — the same place Discord puts it.
 *
 * Walks a guild leader through inviting the bot, registering their Discord
 * server as a tenant, and turning the modules on. The servers the session
 * could still register are listed inline so the walkthrough ends in one click.
 */
@Component({
  selector: 'app-add-server',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink],
  styles: `
    :host {
      display: block;
    }
    /* A self-contained stage, the way DESIGN.md differentiates sections:
       the card carries its own gradient, the page ground never changes. */
    .hero {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-panels);
      padding: clamp(1.75rem, 4vw, 3rem);
      background: var(--gradient-brand);
      color: #ffffff;
    }
    .hero__title {
      font-family: var(--font-display);
      font-weight: 800;
      text-transform: uppercase;
      font-size: clamp(2rem, 5vw, 3.5rem);
      line-height: 0.92;
      letter-spacing: -0.01em;
      margin: 0.75rem 0 0;
      max-width: 20ch;
    }
    .hero__body {
      margin: 1rem 0 0;
      max-width: 46ch;
      font-size: 1rem;
      line-height: 1.5;
      color: rgb(255 255 255 / 88%);
    }
    .hero__orb {
      position: absolute;
      inset-block-start: -30%;
      inset-inline-end: -6%;
      width: 22rem;
      height: 22rem;
      border-radius: 50%;
      background: radial-gradient(circle at 30% 30%, rgb(255 255 255 / 28%), transparent 62%);
      pointer-events: none;
    }
    .hero__cta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-top: 1.75rem;
    }
    /* The white filled secondary DESIGN.md pairs with the blurple primary. */
    .btn--snow {
      background: #ffffff;
      color: #23272a;
      border-color: #ffffff;
    }
    .btn--snow:hover:not(:disabled) {
      background: #e9eaf6;
      border-color: #e9eaf6;
    }
    .step__index {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      flex-shrink: 0;
      border-radius: var(--radius-inputs);
      background: var(--color-primary-container);
      color: var(--color-primary);
      font-family: var(--font-display);
      font-weight: 800;
      font-size: 1rem;
    }
    .step__title {
      margin: 0;
      font-size: 1rem;
      font-weight: 700;
      color: var(--color-text);
    }
    .step__body {
      margin: 0.375rem 0 0;
      color: var(--color-text-secondary);
      font-size: 0.875rem;
      line-height: 1.5;
    }
    .guild-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      padding: 0.625rem 0.75rem;
      border-radius: var(--radius-inputs);
      background: var(--color-surface-2);
      border: 1px solid transparent;
      color: var(--color-text);
      text-align: left;
      cursor: pointer;
      transition:
        background-color 120ms ease,
        border-color 120ms ease;
    }
    .guild-row:hover {
      background: var(--color-surface-hover);
      border-color: var(--color-border-strong);
    }
    .guild-row__avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.5rem;
      height: 2.5rem;
      flex-shrink: 0;
      border-radius: var(--radius-pills);
      overflow: hidden;
      background: var(--color-chrome);
      font-weight: 700;
    }
    .guild-row__avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
  `,
  template: `
    <div class="flex flex-col gap-6 pb-8">
      <!-- Hero -->
      <section class="hero" aria-labelledby="add-server-title">
        <span class="hero__orb" aria-hidden="true"></span>
        <p class="eyebrow" style="color: rgb(255 255 255 / 78%)">{{ t('addServer.eyebrow') }}</p>
        <h1 id="add-server-title" class="hero__title">{{ t('addServer.heroTitle') }}</h1>
        <p class="hero__body">{{ t('addServer.heroBody') }}</p>
        <div class="hero__cta">
          <a
            class="btn btn--snow"
            [href]="inviteUrl() ?? '#'"
            target="_blank"
            rel="noopener noreferrer"
            [attr.aria-disabled]="inviteUrl() ? null : 'true'"
          >
            <app-icon name="discord" size="1.125rem" />
            {{ t('addServer.inviteCta') }}
          </a>
          <a class="btn btn--outline" style="border-color: rgb(255 255 255 / 55%); color: #fff" href="#add-server-steps">
            {{ t('addServer.stepsCta') }}
          </a>
        </div>
      </section>

      <!-- Requirements -->
      <section class="card p-5" aria-labelledby="add-server-requirements">
        <h2 id="add-server-requirements" class="text-sm font-bold uppercase tracking-wide text-[var(--color-text-tertiary)]">
          {{ t('addServer.requirements.title') }}
        </h2>
        <ul class="mt-3 grid gap-2 sm:grid-cols-3" role="list">
          @for (key of requirementKeys; track key) {
            <li class="flex items-start gap-2 text-sm text-[var(--color-text-secondary)]">
              <app-icon name="check" size="1rem" class="mt-0.5 shrink-0 text-[var(--color-success)]" />
              <span>{{ t(key) }}</span>
            </li>
          }
        </ul>
      </section>

      <!-- Steps -->
      <section
        id="add-server-steps"
        class="grid items-start gap-4 lg:grid-cols-2"
        aria-labelledby="add-server-steps-title"
      >
        <h2 id="add-server-steps-title" class="sr-only">{{ t('addServer.stepsTitle') }}</h2>
        @for (step of steps; track step.n) {
          <article class="card flex items-start gap-3 p-5">
            <span class="step__index" aria-hidden="true">{{ step.n }}</span>
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <app-icon [name]="step.icon" size="1rem" class="text-[var(--color-primary)]" />
                <h3 class="step__title">{{ t(step.titleKey) }}</h3>
              </div>
              <p class="step__body">{{ t(step.bodyKey) }}</p>

              @if (step.n === 1) {
                <a
                  class="btn btn--primary btn--sm mt-3"
                  [href]="inviteUrl() ?? '#'"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ t('addServer.inviteCta') }}
                  <app-icon name="arrow-right" size="0.875rem" />
                </a>
                @if (inviteError()) {
                  <p class="mt-2 text-xs text-[var(--color-error)]" role="alert">
                    {{ t('addServer.inviteUnavailable') }}
                  </p>
                }
              }

              @if (step.n === 2) {
                <div class="mt-3">
                  @if (loadingGuilds()) {
                    <p class="text-sm text-[var(--color-text-tertiary)]">{{ t('common.loading') }}</p>
                  } @else if (guilds().length === 0) {
                    <p class="text-sm text-[var(--color-text-tertiary)]">{{ t('addServer.noGuilds') }}</p>
                  } @else {
                    <p class="label">{{ t('addServer.yourServers') }}</p>
                    <ul class="grid gap-2" role="list">
                      @for (guild of guilds(); track guild.id) {
                        <li>
                          <button type="button" class="guild-row" (click)="register(guild)">
                            <span class="guild-row__avatar" aria-hidden="true">
                              @if (iconUrl(guild); as src) {
                                <img [src]="src" alt="" />
                              } @else {
                                {{ initial(guild.name) }}
                              }
                            </span>
                            <span class="min-w-0 flex-1 truncate text-sm font-semibold">{{ guild.name }}</span>
                            <span class="chip chip--info">{{ t('addServer.registerAction') }}</span>
                          </button>
                        </li>
                      }
                    </ul>
                  }
                </div>
              }

              @if (step.n === 4) {
                <div class="mt-3 flex flex-wrap gap-2">
                  <a class="btn btn--tonal btn--sm" routerLink="/admin/features">{{ t('nav.admin.features') }}</a>
                  <a class="btn btn--tonal btn--sm" routerLink="/admin/roles">{{ t('nav.admin.roles') }}</a>
                  <a class="btn btn--tonal btn--sm" routerLink="/admin/discord">{{ t('nav.admin.discord') }}</a>
                </div>
              }
            </div>
          </article>
        }
      </section>

      <!-- FAQ -->
      <section class="card p-5" aria-labelledby="add-server-faq">
        <h2 id="add-server-faq" class="heading-sm">{{ t('addServer.faq.title') }}</h2>
        <dl class="mt-4 grid gap-4">
          @for (entry of faq; track entry.q) {
            <div>
              <dt class="text-sm font-semibold text-[var(--color-text)]">{{ t(entry.q) }}</dt>
              <dd class="mt-1 text-sm leading-relaxed text-[var(--color-text-secondary)]">{{ t(entry.a) }}</dd>
            </div>
          }
        </dl>
      </section>
    </div>
  `,
})
export class AddServer implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly steps = STEPS;
  protected readonly faq = FAQ;
  protected readonly requirementKeys: readonly TranslationKey[] = [
    'addServer.requirements.manageGuild',
    'addServer.requirements.albionGuild',
    'addServer.requirements.oneTenant',
  ];

  protected readonly guilds = signal<RegisterableGuild[]>([]);
  protected readonly loadingGuilds = signal(true);
  protected readonly inviteUrl = signal<string | null>(null);
  protected readonly inviteError = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadGuilds(), this.loadInvite()]);
  }

  protected iconUrl(guild: RegisterableGuild): string | null {
    return discordGuildIconUrl(guild.id, guild.icon_hash);
  }

  protected initial(name: string): string {
    const trimmed = name.trim();
    return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
  }

  protected async register(guild: RegisterableGuild): Promise<void> {
    await this.router.navigate(['/register-tenant'], {
      queryParams: { guild: guild.id, name: guild.name },
    });
  }

  private async loadGuilds(): Promise<void> {
    try {
      this.guilds.set(await this.auth.registerableGuilds());
    } catch {
      this.guilds.set([]);
    } finally {
      this.loadingGuilds.set(false);
    }
  }

  private async loadInvite(): Promise<void> {
    try {
      this.inviteUrl.set((await this.auth.botInvite()).url);
    } catch {
      this.inviteError.set(true);
    }
  }
}
