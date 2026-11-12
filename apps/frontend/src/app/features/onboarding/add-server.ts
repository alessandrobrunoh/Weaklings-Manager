import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type { RegisterableGuild } from '../../core/models/api.models';
import { discordGuildIconUrl } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon, type IconName } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/** One step of the setup wizard. */
interface Step {
  readonly icon: IconName;
  readonly titleKey: TranslationKey;
  readonly bodyKey: TranslationKey;
}

const STEPS: readonly Step[] = [
  { icon: 'discord', titleKey: 'addServer.step1.title', bodyKey: 'addServer.step1.body' },
  { icon: 'plus', titleKey: 'addServer.step2.title', bodyKey: 'addServer.step2.body' },
  { icon: 'shield', titleKey: 'addServer.step3.title', bodyKey: 'addServer.step3.body' },
  { icon: 'sparkles', titleKey: 'addServer.step4.title', bodyKey: 'addServer.step4.body' },
  { icon: 'users', titleKey: 'addServer.step5.title', bodyKey: 'addServer.step5.body' },
];

const FAQ: readonly { readonly q: TranslationKey; readonly a: TranslationKey }[] = [
  { q: 'addServer.faq.q1', a: 'addServer.faq.a1' },
  { q: 'addServer.faq.q2', a: 'addServer.faq.a2' },
  { q: 'addServer.faq.q3', a: 'addServer.faq.a3' },
];

/**
 * "Add a server" wizard, reached from the `+` orb at the bottom of the server
 * rail. The same place Discord puts it.
 *
 * One step is shown at a time, with a numbered progress indicator. Step 1
 * invites the bot, step 2 lists the Discord servers the session can register
 * (clicking one opens the tenant wizard), and the last steps point at the
 * modules and members. Load failures are shown with a retry, never as an
 * empty list.
 */
@Component({
  selector: 'app-add-server',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [EmptyState, ErrorState, Icon, Loading, PageHeader, RouterLink],
  styles: [COMPACT_FEATURE_STYLES, `
    :host {
      display: block;
    }
    .steps {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      list-style: none;
      margin: 0;
      padding: 0;
    }
    /* Numbered dots are the tap targets of the progress indicator (44px square). */
    .step-dot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.75rem;
      height: 2.75rem;
      border-radius: var(--radius-pills);
      border: 1px solid var(--color-border-strong);
      background: var(--color-surface);
      color: var(--color-text-secondary);
      font-family: var(--font-display);
      font-weight: 700;
      font-size: var(--ui-text-sm);
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .step-dot:hover {
      background: var(--color-surface-hover);
    }
    .step-dot--done {
      color: var(--color-success);
      border-color: var(--color-success);
    }
    .step-dot--current {
      background: var(--color-primary-container);
      border-color: var(--color-primary);
      color: var(--color-primary);
    }
    .progress {
      height: 0.375rem;
      border-radius: var(--radius-pills);
      background: var(--color-surface-2);
      overflow: hidden;
    }
    .progress__fill {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--color-primary);
      transition: width 200ms ease;
    }
    .step-panel {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding: 1.25rem;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface-2);
    }
    .step__title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0;
      font-size: var(--ui-text-md);
      font-weight: 700;
      color: var(--color-text);
    }
    .step__body {
      margin: 0.375rem 0 0;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-sm);
      line-height: 1.5;
    }
    .step-nav {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid var(--color-border);
    }
    .guild-row {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      min-height: 2.75rem;
      padding: 0.5rem 0.75rem;
      border-radius: var(--radius-inputs);
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      color: var(--color-text);
      text-align: left;
      cursor: pointer;
      transition: background-color 120ms ease, border-color 120ms ease;
    }
    .guild-row:hover {
      background: var(--color-surface-hover);
      border-color: var(--color-border-strong);
    }
    .guild-row__avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
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
    .guild-row__action {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      flex-shrink: 0;
      font-size: var(--ui-text-sm);
      font-weight: 600;
      color: var(--color-primary);
    }
    .faq {
      border-top: 1px solid var(--color-border);
    }
    .faq summary {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      min-height: 2.75rem;
      cursor: pointer;
      font-size: var(--ui-text-sm);
      font-weight: 600;
      color: var(--color-text);
      list-style: none;
    }
    .faq summary::-webkit-details-marker {
      display: none;
    }
    .faq__answer {
      margin: 0 0 0.75rem;
      font-size: var(--ui-text-sm);
      line-height: 1.5;
      color: var(--color-text-secondary);
    }
    @media (prefers-reduced-motion: reduce) {
      .step-dot,
      .guild-row,
      .progress__fill {
        transition: none;
      }
    }
  `],
  template: `
    <div class="flex flex-col gap-6 pb-8">
      <app-page-header [title]="t('addServer.title')" [subtitle]="t('addServer.intro')" />

      <section class="card p-5" aria-labelledby="add-server-requirements">
        <h2 id="add-server-requirements" class="section-title section-title--sm">
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

      <section class="card flex flex-col gap-4 p-5" aria-labelledby="add-server-steps-title">
        <h2 id="add-server-steps-title" class="section-title">{{ t('addServer.stepsTitle') }}</h2>

        <nav [attr.aria-label]="t('addServer.progressLabel')">
          <ol class="steps">
            @for (step of steps; track step.titleKey; let i = $index) {
              <li>
                <button
                  type="button"
                  class="step-dot"
                  [class.step-dot--done]="i < current()"
                  [class.step-dot--current]="i === current()"
                  [attr.aria-current]="i === current() ? 'step' : null"
                  [attr.aria-label]="stepLabel(i)"
                  (click)="goTo(i)"
                >
                  @if (i < current()) {
                    <app-icon name="check" size="1rem" />
                  } @else {
                    {{ i + 1 }}
                  }
                </button>
              </li>
            }
          </ol>
        </nav>

        <div class="flex flex-col gap-2">
          <div
            class="progress"
            role="progressbar"
            [attr.aria-label]="t('addServer.progressLabel')"
            aria-valuemin="1"
            [attr.aria-valuemax]="steps.length"
            [attr.aria-valuenow]="current() + 1"
            [attr.aria-valuetext]="progressText()"
          >
            <span class="progress__fill" [style.width.%]="progressPercent()"></span>
          </div>
          <p class="text-sm font-medium text-[var(--color-text-secondary)]">{{ progressText() }}</p>
        </div>

        <article class="step-panel" aria-labelledby="add-server-step-title">
          <div>
            <h3 id="add-server-step-title" class="step__title">
              <app-icon [name]="activeStep().icon" size="1rem" class="text-[var(--color-primary)]" />
              {{ t(activeStep().titleKey) }}
            </h3>
            <p class="step__body">{{ t(activeStep().bodyKey) }}</p>
          </div>

          @switch (current()) {
            @case (0) {
              @if (inviteUrl(); as url) {
                <div>
                  <a class="btn btn--tonal btn--sm" [href]="url" target="_blank" rel="noopener noreferrer">
                    <app-icon name="discord" size="1rem" />
                    {{ t('addServer.inviteCta') }}
                    <app-icon name="arrow-right" size="0.875rem" />
                  </a>
                </div>
              } @else if (inviteError()) {
                <app-error-state
                  [message]="t('addServer.inviteUnavailable')"
                  [retryLabel]="t('common.retry')"
                  (retry)="retryInvite()"
                />
              } @else {
                <p class="text-sm text-[var(--color-text-tertiary)]" aria-live="polite">
                  {{ t('common.loading') }}
                </p>
              }
            }

            @case (1) {
              @if (loadingGuilds()) {
                <app-loading variant="lines" [rows]="3" />
              } @else if (guildsFailed()) {
                <app-error-state
                  [message]="t('addServer.guildsError')"
                  [retryLabel]="t('common.retry')"
                  (retry)="reloadGuilds()"
                />
              } @else if (guilds().length === 0) {
                <app-empty-state compact icon="users" [message]="t('addServer.noGuilds')" />
              } @else {
                <div class="flex flex-col gap-2">
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
                          <span class="guild-row__action">
                            {{ t('addServer.registerAction') }}
                            <app-icon name="arrow-right" size="0.875rem" />
                          </span>
                        </button>
                      </li>
                    }
                  </ul>
                </div>
              }
            }

            @case (3) {
              <div class="flex flex-wrap gap-2">
                <a class="btn btn--tonal btn--sm" routerLink="/admin/features">{{ t('nav.admin.features') }}</a>
                <a class="btn btn--tonal btn--sm" routerLink="/admin/roles">{{ t('nav.admin.roles') }}</a>
                <a class="btn btn--tonal btn--sm" routerLink="/admin/discord">{{ t('nav.admin.discord') }}</a>
              </div>
            }
          }

          <div class="step-nav">
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="current() === 0"
              (click)="previous()"
            >
              {{ t('addServer.back') }}
            </button>
            @if (isLast()) {
              <a class="btn btn--primary btn--sm" routerLink="/dashboard">{{ t('addServer.finish') }}</a>
            } @else {
              <button type="button" class="btn btn--primary btn--sm" (click)="next()">
                {{ t('common.next') }}
              </button>
            }
          </div>
        </article>
      </section>

      <section class="card p-5" aria-labelledby="add-server-faq">
        <h2 id="add-server-faq" class="section-title section-title--sm">{{ t('addServer.faq.title') }}</h2>
        <div class="mt-3 flex flex-col">
          @for (entry of faq; track entry.q) {
            <details class="faq">
              <summary>{{ t(entry.q) }}</summary>
              <p class="faq__answer">{{ t(entry.a) }}</p>
            </details>
          }
        </div>
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

  /** Index of the step on screen (0-based). */
  protected readonly current = signal(0);
  protected readonly activeStep = computed(() => STEPS[this.current()]);
  protected readonly isLast = computed(() => this.current() === STEPS.length - 1);
  protected readonly progressPercent = computed(() => ((this.current() + 1) / STEPS.length) * 100);
  protected readonly progressText = computed(() =>
    this.t('addServer.progress', { current: this.current() + 1, total: STEPS.length }),
  );

  protected readonly guilds = signal<RegisterableGuild[]>([]);
  protected readonly loadingGuilds = signal(true);
  protected readonly guildsFailed = signal(false);
  protected readonly inviteUrl = signal<string | null>(null);
  protected readonly inviteError = signal(false);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadGuilds(), this.loadInvite()]);
  }

  protected goTo(index: number): void {
    if (index >= 0 && index < STEPS.length) {
      this.current.set(index);
    }
  }

  protected next(): void {
    this.goTo(this.current() + 1);
  }

  protected previous(): void {
    this.goTo(this.current() - 1);
  }

  protected stepLabel(index: number): string {
    const step = STEPS[index];
    return this.t('addServer.stepAria', { n: index + 1, title: this.t(step.titleKey) });
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

  protected async reloadGuilds(): Promise<void> {
    this.loadingGuilds.set(true);
    this.guildsFailed.set(false);
    await this.loadGuilds();
  }

  protected async retryInvite(): Promise<void> {
    this.inviteError.set(false);
    await this.loadInvite();
  }

  private async loadGuilds(): Promise<void> {
    try {
      this.guilds.set(await this.auth.registerableGuilds());
    } catch {
      this.guilds.set([]);
      this.guildsFailed.set(true);
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
