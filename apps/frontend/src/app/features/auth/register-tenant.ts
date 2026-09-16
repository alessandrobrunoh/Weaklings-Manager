import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionGuild,
  AlbionSearchResult,
  AttachableGuild,
  RegisterTenantRequest,
  TenantStatus,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

const REGIONS = [
  { id: 'europe', labelKey: 'register.region.europe' as const },
  { id: 'americas', labelKey: 'register.region.americas' as const },
  { id: 'asia', labelKey: 'register.region.asia' as const },
] as const;

/**
 * First-time tenant onboarding wizard. The Discord user who completes it
 * becomes Super Admin of this tenant (`owner_discord_id`), not a platform admin.
 */
@Component({
  selector: 'app-register-tenant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RouterLink, WeaklingsLogo],
  template: `
    <div class="auth-shell">
      <section class="auth-card auth-card--wide" aria-labelledby="register-title">
        <div class="mb-6 flex flex-col items-center text-center">
          <app-weaklings-logo [compact]="true" />
          <h1 id="register-title" class="auth-card__title mt-5">
            {{ t('register.title') }}
          </h1>
          <p class="auth-card__subtitle">{{ t('register.subtitle') }}</p>
        </div>

        @if (alreadyRegistered()) {
          <p class="text-sm text-center">{{ t('register.already') }}</p>
          <a routerLink="/dashboard" class="btn btn--primary mt-4 w-full no-underline">
            {{ t('nav.dashboard') }}
          </a>
        } @else if (!guildId) {
          <p class="text-sm text-center" style="color: var(--color-danger)">
            {{ t('register.missingGuild') }}
          </p>
        } @else {
          <ol class="flex gap-2 mb-6 text-xs" aria-label="Steps">
            @for (n of [1, 2, 3]; track n) {
              <li
                class="flex-1 rounded-full py-1 text-center"
                [class.bg-[var(--color-primary)]]="step() === n"
                [class.text-[var(--color-on-primary)]]="step() === n"
                [class.bg-[var(--color-surface-2)]]="step() !== n"
              >
                {{ n }}
              </li>
            }
          </ol>

          @if (step() === 1) {
            <form class="grid gap-4" (submit)="nextFromWelcome($event)">
              <p class="text-sm">{{ t('register.welcome') }}</p>
              <p class="font-mono text-sm">{{ guildId }}</p>
              <label class="block" for="tenant-display-name">
                <span class="label">{{ t('register.displayName') }}</span>
                <input
                  id="tenant-display-name"
                  class="input"
                  name="name"
                  type="text"
                  required
                  autocomplete="organization"
                  [value]="displayName()"
                  (input)="onDisplayName($event)"
                />
              </label>
              <fieldset class="grid gap-2">
                <legend class="label">{{ t('register.kind') }}</legend>
                <label class="flex items-center gap-2" for="kind-guild">
                  <input
                    class="radio"
                    type="radio"
                    name="kind"
                    id="kind-guild"
                    value="guild"
                    [checked]="kind() === 'guild'"
                    (change)="kind.set('guild')"
                  />
                  <span>{{ t('register.kind.guild') }}</span>
                </label>
                <label class="flex items-center gap-2" for="kind-alliance">
                  <input
                    class="radio"
                    type="radio"
                    name="kind"
                    id="kind-alliance"
                    value="alliance"
                    [checked]="kind() === 'alliance'"
                    (change)="kind.set('alliance')"
                  />
                  <span>{{ t('register.kind.alliance') }}</span>
                </label>
              </fieldset>
              @if (kind() === 'alliance' && attachableGuilds().length === 0) {
                <p class="text-sm" role="status">{{ t('register.allianceNeedsGuilds') }}</p>
              } @else if (kind() === 'alliance') {
                <p class="text-sm">{{ t('register.memberGuildsHint') }}</p>
              }
              <button
                type="submit"
                class="btn btn--primary"
                [disabled]="kind() === 'alliance' && attachableGuilds().length === 0"
              >
                {{ t('common.next') }}
              </button>
            </form>
          } @else if (step() === 2 && kind() === 'alliance') {
            <form class="grid gap-4" (submit)="nextFromMembers($event)">
              <fieldset class="grid gap-2">
                <legend class="label">{{ t('register.memberGuilds') }}</legend>
                @for (guild of attachableGuilds(); track guild.id) {
                  <label class="flex items-center gap-2" [attr.for]="'member-' + guild.id">
                    <input
                      class="checkbox"
                      type="checkbox"
                      [id]="'member-' + guild.id"
                      [checked]="selectedMemberIds().includes(guild.id)"
                      (change)="toggleMember(guild.id)"
                    />
                    <span>{{ guild.name }}</span>
                  </label>
                }
              </fieldset>
              <div class="flex gap-2">
                <button type="button" class="btn btn--ghost" (click)="step.set(1)">
                  {{ t('common.prev') }}
                </button>
                <button type="submit" class="btn btn--primary" [disabled]="selectedMemberIds().length === 0">
                  {{ t('common.next') }}
                </button>
              </div>
            </form>
          } @else if (step() === 2) {
            <form class="grid gap-4" (submit)="nextFromAlbion($event)">
              <fieldset class="grid gap-2">
                <legend class="label">{{ t('register.region') }}</legend>
                @for (region of regions; track region.id) {
                  <label class="flex items-center gap-2" [attr.for]="'region-' + region.id">
                    <input
                      class="radio"
                      type="radio"
                      name="region"
                      [id]="'region-' + region.id"
                      [value]="region.id"
                      [checked]="regionId() === region.id"
                      (change)="regionId.set(region.id)"
                    />
                    <span>{{ t(region.labelKey) }}</span>
                  </label>
                }
              </fieldset>
              <label class="block" for="albion-guild-search">
                <span class="label">{{ t('register.albionGuild') }}</span>
                <input
                  id="albion-guild-search"
                  class="input"
                  name="q"
                  type="search"
                  autocomplete="off"
                  [value]="searchQ()"
                  (input)="onSearchInput($event)"
                  [attr.placeholder]="t('register.albionGuildHint')"
                />
              </label>
              @if (searching()) {
                <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('common.loading') }}</p>
              }
              @if (guildHits().length) {
                <ul class="grid gap-1 max-h-48 overflow-y-auto">
                  @for (guild of guildHits(); track guild.id) {
                    <li>
                      <button
                        type="button"
                        class="btn btn--tonal w-full justify-start"
                        [class.ring-1]="pickedGuild()?.id === guild.id"
                        (click)="pickedGuild.set(guild)"
                      >
                        {{ guild.name }}
                        <span class="font-mono text-xs opacity-70">{{ guild.id }}</span>
                      </button>
                    </li>
                  }
                </ul>
              }
              <div class="flex gap-2">
                <button type="button" class="btn btn--ghost" (click)="step.set(1)">
                  {{ t('common.prev') }}
                </button>
                <button type="submit" class="btn btn--primary" [disabled]="!pickedGuild()">
                  {{ t('common.next') }}
                </button>
              </div>
            </form>
          } @else {
            <form class="grid gap-4" (submit)="submit($event)">
              <dl class="grid gap-2 text-sm">
                <div>
                  <dt class="label">{{ t('register.displayName') }}</dt>
                  <dd>{{ displayName() }}</dd>
                </div>
                <div>
                  <dt class="label">{{ t('register.kind') }}</dt>
                  <dd>{{ t(kind() === 'alliance' ? 'register.kind.alliance' : 'register.kind.guild') }}</dd>
                </div>
                @if (kind() === 'guild') {
                  <div>
                    <dt class="label">{{ t('register.region') }}</dt>
                    <dd>{{ regionId() }}</dd>
                  </div>
                  <div>
                    <dt class="label">{{ t('register.albionGuild') }}</dt>
                    <dd>{{ pickedGuild()?.name }} ({{ pickedGuild()?.id }})</dd>
                  </div>
                } @else {
                  <div>
                    <dt class="label">{{ t('register.memberGuilds') }}</dt>
                    <dd>{{ selectedMemberNames() }}</dd>
                  </div>
                }
              </dl>
              <p class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('register.superadminHint') }}
              </p>
              @if (error()) {
                <p class="text-sm" style="color: var(--color-danger)" role="alert">{{ error() }}</p>
              }
              <div class="flex gap-2">
                <button type="button" class="btn btn--ghost" (click)="step.set(2)">
                  {{ t('common.prev') }}
                </button>
                <button type="submit" class="btn btn--primary" [disabled]="submitting()">
                  {{ submitting() ? t('common.loading') : t('register.submit') }}
                </button>
              </div>
            </form>
          }
        }
      </section>
    </div>
  `,
})
export class RegisterTenant implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  protected readonly regions = REGIONS;
  protected readonly guildId = this.route.snapshot.queryParamMap.get('guild') ?? '';
  protected readonly queryName = this.route.snapshot.queryParamMap.get('name') ?? '';
  protected readonly step = signal(1);
  protected readonly kind = signal<'guild' | 'alliance'>('guild');
  protected readonly attachableGuilds = signal<AttachableGuild[]>([]);
  protected readonly selectedMemberIds = signal<string[]>([]);
  protected readonly displayName = signal('');
  protected readonly regionId = signal<'europe' | 'americas' | 'asia'>('europe');
  protected readonly searchQ = signal('');
  protected readonly searching = signal(false);
  protected readonly guildHits = signal<AlbionGuild[]>([]);
  protected readonly pickedGuild = signal<AlbionGuild | null>(null);
  protected readonly alreadyRegistered = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected t = (key: TranslationKey) => this.translate.t(key);

  async ngOnInit(): Promise<void> {
    const profile = this.auth.profile() ?? (await this.auth.load());
    if (!profile) {
      const next = `/register-tenant?guild=${encodeURIComponent(this.guildId)}`;
      await this.router.navigate(['/login'], { queryParams: { next } });
      return;
    }
    if (!this.guildId) {
      await this.router.navigateByUrl('/needs-tenant');
      return;
    }
    try {
      const status = await firstValueFrom(
        this.api.get<TenantStatus>(`api/tenants/${this.guildId}/status`),
      );
      if (status.registered) {
        this.alreadyRegistered.set(true);
        return;
      }
      this.displayName.set(status.name || this.queryName);
    } catch {
      this.displayName.set(this.queryName);
    }
    await this.loadAttachableGuilds();
  }

  protected onDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  protected nextFromWelcome(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.displayName().trim()) {
      return;
    }
    if (this.kind() === 'alliance') {
      if (this.attachableGuilds().length === 0) {
        return;
      }
      this.step.set(2);
      return;
    }
    this.step.set(2);
  }

  protected toggleMember(id: string): void {
    this.selectedMemberIds.update((ids) =>
      ids.includes(id) ? ids.filter((current) => current !== id) : [...ids, id],
    );
  }

  protected nextFromMembers(event: SubmitEvent): void {
    event.preventDefault();
    if (this.selectedMemberIds().length === 0) {
      return;
    }
    this.step.set(3);
  }

  protected selectedMemberNames(): string {
    const selected = new Set(this.selectedMemberIds());
    return this.attachableGuilds()
      .filter((guild) => selected.has(guild.id))
      .map((guild) => guild.name)
      .join(', ');
  }

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQ.set(value);
    void this.searchGuilds(value);
  }

  protected nextFromAlbion(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.pickedGuild()) {
      return;
    }
    this.step.set(3);
  }

  protected async submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!this.guildId) {
      return;
    }
    const body = this.registerBody();
    if (!body) {
      return;
    }
    this.submitting.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.api.post('api/tenants/register', body));
      await this.auth.switchTenant(this.guildId);
      await this.router.navigateByUrl('/dashboard');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.t('common.error'));
    } finally {
      this.submitting.set(false);
    }
  }

  private registerBody(): RegisterTenantRequest | null {
    const name = this.displayName().trim();
    if (!name) {
      return null;
    }
    if (this.kind() === 'alliance') {
      const memberGuildIds = this.selectedMemberIds();
      if (memberGuildIds.length === 0) {
        return null;
      }
      return {
        id: this.guildId,
        name,
        kind: 'alliance',
        member_guild_ids: memberGuildIds,
      };
    }
    const guild = this.pickedGuild();
    if (!guild) {
      return null;
    }
    return {
      id: this.guildId,
      name,
      kind: 'guild',
      albion_guild_id: guild.id,
      albion_api_region: this.regionId(),
    };
  }

  private async loadAttachableGuilds(): Promise<void> {
    try {
      const guilds = await firstValueFrom(
        this.api.get<AttachableGuild[]>('api/tenants/attachable-guilds'),
      );
      this.attachableGuilds.set(guilds ?? []);
    } catch {
      this.attachableGuilds.set([]);
    }
  }

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private async searchGuilds(raw: string): Promise<void> {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    const q = raw.trim();
    if (q.length < 2) {
      this.guildHits.set([]);
      return;
    }
    this.searchTimer = setTimeout(() => {
      void this.runSearch(q);
    }, 250);
  }

  private async runSearch(q: string): Promise<void> {
    this.searching.set(true);
    try {
      const result = await firstValueFrom(
        this.api.get<AlbionSearchResult>('api/tenants/albion-search', {
          q,
          region: this.regionId(),
        }),
      );
      this.guildHits.set(result.guilds ?? []);
    } catch {
      this.guildHits.set([]);
    } finally {
      this.searching.set(false);
    }
  }
}
