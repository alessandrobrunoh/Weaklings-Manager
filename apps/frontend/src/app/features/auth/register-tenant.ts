import { AUTH_LAYOUT_STYLES } from './auth-layout.styles';
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AlbionAllianceChoice,
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
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { Loading } from '../../shared/components/loading/loading';
import { WeaklingsLogo } from '../../shared/components/weaklings-logo/weaklings-logo';

const REGIONS = [
  { id: 'europe', labelKey: 'register.region.europe' as const },
  { id: 'americas', labelKey: 'register.region.americas' as const },
  { id: 'asia', labelKey: 'register.region.asia' as const },
] as const;

const STEP_COUNT = 3;

/**
 * First-time tenant onboarding wizard. The Discord user who completes it
 * becomes Super Admin of this tenant (`owner_discord_id`), not a platform admin.
 */
@Component({
  selector: 'app-register-tenant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [AUTH_LAYOUT_STYLES],
  imports: [Checkbox, Loading, RouterLink, WeaklingsLogo],
  template: `
    <div class="auth-page">
      <main class="auth-main">
        <section class="auth-card" aria-labelledby="register-title">
          <header class="auth-head">
            <app-weaklings-logo [compact]="true" />
            <p class="auth-brand">{{ t('app.title') }}</p>
            <h1 id="register-title" class="auth-title">{{ t('register.title') }}</h1>
            <p class="auth-hint">{{ t('register.subtitle') }}</p>
          </header>

          @if (alreadyRegistered()) {
            <p class="auth-alert auth-alert--neutral">{{ t('register.already') }}</p>
            <div class="auth-foot">
              <a routerLink="/dashboard" class="btn btn--primary w-full no-underline">
                {{ t('nav.dashboard') }}
              </a>
            </div>
          } @else if (!guildId) {
            <p class="auth-alert" role="alert">{{ t('register.missingGuild') }}</p>
          } @else {
            <div class="auth-steps">
              <p class="auth-steps__label">{{ t('register.step', { current: step(), total: stepCount }) }}</p>
              <ol class="auth-steps__bar" aria-hidden="true">
                @for (n of stepNumbers; track n) {
                  <li
                    class="auth-steps__segment"
                    [class.auth-steps__segment--reached]="n <= step()"
                  ></li>
                }
              </ol>
            </div>

            @if (step() === 1) {
              <form class="auth-stack" ngNativeValidate (submit)="nextFromWelcome($event)">
                <p class="auth-hint">{{ t('register.welcome') }}</p>
                <p class="auth-meta">
                  {{ t('register.discordServer') }}: <span class="num">{{ guildId }}</span>
                </p>
                <p class="hint">{{ t('validation.requiredLegend') }}</p>
                <label class="auth-field" for="tenant-display-name">
                  <span class="label">
                    {{ t('register.displayName') }} <span class="auth-required" aria-hidden="true">*</span>
                  </span>
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
                <fieldset class="auth-choices">
                  <legend class="label">
                    {{ t('register.kind') }} <span class="auth-required" aria-hidden="true">*</span>
                  </legend>
                  <label class="auth-choice" for="kind-guild">
                    <input
                      class="radio"
                      type="radio"
                      name="kind"
                      id="kind-guild"
                      value="guild"
                      required
                      [checked]="kind() === 'guild'"
                      (change)="kind.set('guild')"
                    />
                    <span>{{ t('register.kind.guild') }}</span>
                  </label>
                  <label class="auth-choice" for="kind-alliance">
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
                @if (kind() === 'alliance') {
                  <p class="hint">{{ t('register.memberGuildsAfterAlliance') }}</p>
                }
                <div class="auth-actions">
                  <button type="submit" class="btn btn--primary">{{ t('common.next') }}</button>
                </div>
              </form>
            } @else if (step() === 2 && kind() === 'alliance') {
              <form class="auth-stack" ngNativeValidate (submit)="nextFromAlliance($event)">
                <fieldset class="auth-choices">
                  <legend class="label">{{ t('register.region') }}</legend>
                  @for (region of regions; track region.id) {
                    <label class="auth-choice" [attr.for]="'alliance-region-' + region.id">
                      <input
                        class="radio"
                        type="radio"
                        name="alliance-region"
                        [id]="'alliance-region-' + region.id"
                        [checked]="regionId() === region.id"
                        (change)="selectRegion(region.id)"
                      />
                      <span>{{ t(region.labelKey) }}</span>
                    </label>
                  }
                </fieldset>
                <label class="auth-field" for="albion-alliance-search">
                  <span class="label">{{ t('register.albionAlliance') }}</span>
                  <input
                    id="albion-alliance-search"
                    class="input"
                    type="search"
                    autocomplete="off"
                    [value]="searchQ()"
                    (input)="onAllianceSearch($event)"
                    [attr.placeholder]="t('register.albionAllianceHint')"
                  />
                </label>
                @if (searching()) {
                  <app-loading variant="spinner" [label]="t('common.loading')" />
                }
                @if (allianceHits().length) {
                  <ul class="auth-list" [attr.aria-label]="t('register.albionAlliance')">
                    @for (alliance of allianceHits(); track alliance.id) {
                      <li>
                        <button
                          type="button"
                          class="auth-row"
                          [attr.aria-pressed]="pickedAlliance()?.id === alliance.id"
                          (click)="pickAlliance(alliance)"
                        >
                          <span class="auth-row__name">{{ alliance.name }}</span>
                          <span class="auth-row__meta num">{{ alliance.id }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                }
                @if (pickedAlliance() && attachableGuilds().length === 0 && !searching()) {
                  <p class="hint" role="status">{{ t('register.allianceNeedsGuilds') }}</p>
                }
                @for (guild of attachableGuilds(); track guild.id) {
                  <app-checkbox
                    [inputId]="'member-' + guild.id"
                    [label]="guild.name"
                    [checked]="selectedMemberIds().includes(guild.id)"
                    (checkedChange)="toggleMember(guild.id)"
                  />
                }
                <div class="auth-actions">
                  <button type="button" class="btn btn--ghost" (click)="step.set(1)">
                    {{ t('common.prev') }}
                  </button>
                  <button type="submit" class="btn btn--primary" [disabled]="selectedMemberIds().length === 0">
                    {{ t('common.next') }}
                  </button>
                </div>
              </form>
            } @else if (step() === 2) {
              <form class="auth-stack" ngNativeValidate (submit)="nextFromAlbion($event)">
                <p class="hint">{{ t('validation.requiredLegend') }}</p>
                <fieldset class="auth-choices">
                  <legend class="label">
                    {{ t('register.region') }} <span class="auth-required" aria-hidden="true">*</span>
                  </legend>
                  @for (region of regions; track region.id) {
                    <label class="auth-choice" [attr.for]="'region-' + region.id">
                      <input
                        class="radio"
                        type="radio"
                        name="region"
                        required
                        [id]="'region-' + region.id"
                        [value]="region.id"
                        [checked]="regionId() === region.id"
                        (change)="selectRegion(region.id)"
                      />
                      <span>{{ t(region.labelKey) }}</span>
                    </label>
                  }
                </fieldset>
                <label class="auth-field" for="albion-guild-search">
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
                  <app-loading variant="spinner" [label]="t('common.loading')" />
                }
                @if (guildHits().length) {
                  <ul class="auth-list auth-list--scroll" [attr.aria-label]="t('register.albionGuild')">
                    @for (guild of guildHits(); track guild.id) {
                      <li>
                        <button
                          type="button"
                          class="auth-row"
                          [attr.aria-pressed]="pickedGuild()?.id === guild.id"
                          (click)="pickedGuild.set(guild)"
                        >
                          <span class="auth-row__name">{{ guild.name }}</span>
                          <span class="auth-row__meta num">{{ guild.id }}</span>
                        </button>
                      </li>
                    }
                  </ul>
                }
                <div class="auth-actions">
                  <button type="button" class="btn btn--ghost" (click)="step.set(1)">
                    {{ t('common.prev') }}
                  </button>
                  <button type="submit" class="btn btn--primary" [disabled]="!pickedGuild()">
                    {{ t('common.next') }}
                  </button>
                </div>
              </form>
            } @else {
              <form class="auth-stack" (submit)="submit($event)">
                <dl class="auth-review">
                  <div>
                    <dt>{{ t('register.displayName') }}</dt>
                    <dd>{{ displayName() }}</dd>
                  </div>
                  <div>
                    <dt>{{ t('register.kind') }}</dt>
                    <dd>{{ t(kind() === 'alliance' ? 'register.kind.alliance' : 'register.kind.guild') }}</dd>
                  </div>
                  @if (kind() === 'guild') {
                    <div>
                      <dt>{{ t('register.region') }}</dt>
                      <dd>{{ t(regionLabelKey()) }}</dd>
                    </div>
                    <div>
                      <dt>{{ t('register.albionGuild') }}</dt>
                      <dd>{{ pickedGuild()?.name }} ({{ pickedGuild()?.id }})</dd>
                    </div>
                  } @else {
                    <div>
                      <dt>{{ t('register.albionAlliance') }}</dt>
                      <dd>{{ pickedAlliance()?.name }} ({{ pickedAlliance()?.id }})</dd>
                    </div>
                    <div>
                      <dt>{{ t('register.memberGuilds') }}</dt>
                      <dd>{{ selectedMemberNames() }}</dd>
                    </div>
                  }
                </dl>
                <p class="hint">{{ t('register.superadminHint') }}</p>
                @if (error()) {
                  <p class="auth-alert" role="alert">{{ error() }}</p>
                }
                <div class="auth-actions">
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
      </main>
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
  protected readonly stepCount = STEP_COUNT;
  protected readonly stepNumbers = Array.from({ length: STEP_COUNT }, (_, index) => index + 1);
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
  protected readonly allianceHits = signal<AlbionAllianceChoice[]>([]);
  protected readonly pickedAlliance = signal<AlbionAllianceChoice | null>(null);
  protected readonly alreadyRegistered = signal(false);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) => this.translate.t(key, params);

  protected regionLabelKey(): TranslationKey {
    return REGIONS.find((region) => region.id === this.regionId())?.labelKey ?? 'register.region.europe';
  }

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
  }

  protected onDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  protected nextFromWelcome(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.displayName().trim()) {
      return;
    }
    this.step.set(2);
  }

  protected toggleMember(id: string): void {
    this.selectedMemberIds.update((ids) =>
      ids.includes(id) ? ids.filter((current) => current !== id) : [...ids, id],
    );
  }

  protected nextFromAlliance(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.pickedAlliance() || this.selectedMemberIds().length === 0) {
      return;
    }
    this.step.set(3);
  }

  protected onAllianceSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQ.set(value);
    this.searchAlliances(value);
  }

  protected async pickAlliance(alliance: AlbionAllianceChoice): Promise<void> {
    this.pickedAlliance.set(alliance);
    this.selectedMemberIds.set([]);
    try {
      const guilds = await firstValueFrom(
        this.api.get<AttachableGuild[]>('api/tenants/attachable-guilds', {
          albion_alliance_id: alliance.id,
          region: this.regionId(),
        }),
      );
      this.attachableGuilds.set(guilds ?? []);
    } catch {
      this.attachableGuilds.set([]);
    }
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
    this.searchGuilds(value);
  }

  /** A guild id is only meaningful in the region it was searched in. */
  protected selectRegion(id: 'europe' | 'americas' | 'asia'): void {
    if (this.regionId() === id) {
      return;
    }
    this.regionId.set(id);
    this.pickedGuild.set(null);
    this.pickedAlliance.set(null);
    this.guildHits.set([]);
    this.allianceHits.set([]);
    this.attachableGuilds.set([]);
    this.selectedMemberIds.set([]);
    if (this.kind() === 'alliance') {
      this.searchAlliances(this.searchQ());
    } else {
      this.searchGuilds(this.searchQ());
    }
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
    } catch {
      // The API message is not shown: it is English, server-side text. The localised copy says what to do.
      this.error.set(this.t('register.submitFailed'));
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
      const alliance = this.pickedAlliance();
      if (!alliance) {
        return null;
      }
      return {
        id: this.guildId,
        name,
        kind: 'alliance',
        member_guild_ids: memberGuildIds,
        albion_alliance_id: alliance.id,
        albion_api_region: this.regionId(),
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

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every keystroke and region change so a late response cannot win. */
  private searchGeneration = 0;

  private searchAlliances(raw: string): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    const generation = ++this.searchGeneration;
    const region = this.regionId();
    const q = raw.trim();
    if (q.length < 2) {
      this.allianceHits.set([]);
      this.searching.set(false);
      return;
    }
    this.searchTimer = setTimeout(() => {
      void this.runAllianceSearch(q, region, generation);
    }, 250);
  }

  private async runAllianceSearch(
    q: string,
    region: 'europe' | 'americas' | 'asia',
    generation: number,
  ): Promise<void> {
    this.searching.set(true);
    try {
      const result = await firstValueFrom(
        this.api.get<AlbionAllianceChoice[]>('api/tenants/albion-alliances', { q, region }),
      );
      if (generation !== this.searchGeneration) {
        return;
      }
      this.allianceHits.set(result ?? []);
    } catch {
      if (generation === this.searchGeneration) {
        this.allianceHits.set([]);
      }
    } finally {
      if (generation === this.searchGeneration) {
        this.searching.set(false);
      }
    }
  }

  private searchGuilds(raw: string): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    const generation = ++this.searchGeneration;
    const region = this.regionId();
    const q = raw.trim();
    if (q.length < 2) {
      this.guildHits.set([]);
      this.searching.set(false);
      return;
    }
    this.searchTimer = setTimeout(() => {
      void this.runSearch(q, region, generation);
    }, 250);
  }

  private async runSearch(
    q: string,
    region: 'europe' | 'americas' | 'asia',
    generation: number,
  ): Promise<void> {
    this.searching.set(true);
    try {
      const result = await firstValueFrom(
        this.api.get<AlbionSearchResult>('api/tenants/albion-search', {
          q,
          region,
        }),
      );
      if (generation !== this.searchGeneration) {
        return;
      }
      this.guildHits.set(result.guilds ?? []);
    } catch {
      if (generation !== this.searchGeneration) {
        return;
      }
      this.guildHits.set([]);
    } finally {
      if (generation === this.searchGeneration) {
        this.searching.set(false);
      }
    }
  }
}
