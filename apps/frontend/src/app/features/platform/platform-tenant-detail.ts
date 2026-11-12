import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  PlatformTenant,
  TenantFeaturesView,
  TenantRankView,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import {
  EntityHeader,
  type EntityMenuItem,
} from '../../shared/components/entity-header/entity-header';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

const REGIONS = [
  { id: 'europe', labelKey: 'register.region.europe' as const },
  { id: 'americas', labelKey: 'register.region.americas' as const },
  { id: 'asia', labelKey: 'register.region.asia' as const },
] as const;

type TenantTab = 'overview' | 'access' | 'albion' | 'features';
const TENANT_TABS: readonly TenantTab[] = ['overview', 'access', 'albion', 'features'];

/**
 * One tenant on the control plane. The header carries the status and the one next action (resume
 * when suspended); suspending sits in the overflow menu behind a confirmation. The body is split
 * into tabs: the record and display name, SuperAdmin and rank, the Albion guild link, and the
 * tenant's feature flags (loaded the first time the tab opens).
 */
@Component({
  selector: 'app-platform-tenant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Checkbox,
    Dialog,
    EmptyState,
    EntityHeader,
    ErrorState,
    Icon,
    Loading,
    PageStack,
    RouterLink,
    Select,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .tenant-section {
      display: grid;
      gap: 0.875rem;
      max-width: 40rem;
      padding: var(--card-padding);
    }
    .tenant-section > .section-title,
    .tenant-section > .hint {
      margin: 0;
    }
    .tenant-facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      gap: 0.75rem 1.5rem;
      margin: 0;
    }
    .tenant-facts dd {
      margin: 0;
      font-size: var(--ui-text-sm);
      overflow-wrap: anywhere;
    }
    .tenant-radios {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.25rem;
    }
    .tenant-radio {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: var(--ui-text-sm);
    }
    .tenant-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .tenant-back {
      align-self: flex-start;
      text-decoration: none;
    }
  `,
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (notFound()) {
      <app-error-state variant="not-found">
        <a class="btn btn--outline btn--sm no-underline" routerLink="/platform/tenants">
          <app-icon name="chevron-left" size="0.875rem" />
          {{ t('nav.platform.tenants') }}
        </a>
      </app-error-state>
    } @else if (loadFailed()) {
      <app-error-state
        [message]="t('platform.tenant.error.load')"
        [retryLabel]="t('common.retry')"
        (retry)="load()"
      />
    } @else if (tenant(); as row) {
      <a class="btn btn--ghost btn--sm tenant-back" routerLink="/platform/tenants">
        <app-icon name="chevron-left" size="0.875rem" />
        {{ t('nav.platform.tenants') }}
      </a>

      <app-entity-header
        [title]="row.name"
        [description]="t('platform.tenant.subtitle')"
        [menuItems]="menuItems()"
        [menuLabel]="t('entityHeader.moreActions')"
        (menuSelect)="onMenu($event)"
      >
        <app-status-chip entityBadges [value]="row.status" [label]="statusLabel(row.status)" />

        <div entityMeta>
          <span class="font-mono">{{ row.slug }}</span>
          <span class="font-mono">{{ row.id }}</span>
        </div>

        @if (row.status === 'suspended') {
          <button
            entityPrimary
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="busy()"
            (click)="setStatus('active')"
          >
            {{ t('platform.tenants.resume') }}
          </button>
        }

        <div entitySummary>
          <app-summary-band [items]="summary()" [ariaLabel]="t('platform.tenant.summary')" />
        </div>
      </app-entity-header>

      <app-page-stack>
        <app-tabs
          [options]="tabOptions()"
          [active]="tab()"
          [ariaLabel]="t('platform.tenant.sections')"
          (activeChange)="onTabChange($event)"
        />

        <!-- ================= OVERVIEW ================= -->
        @if (tab() === 'overview') {
          <section
            class="card tenant-section"
            [attr.aria-label]="t('platform.tenant.tab.overview')"
          >
            <h2 class="section-title">{{ t('platform.tenant.section.record') }}</h2>
            <dl class="tenant-facts">
              <div>
                <dt class="label">{{ t('platform.tenants.id') }}</dt>
                <dd class="font-mono">{{ row.id }}</dd>
              </div>
              <div>
                <dt class="label">{{ t('platform.tenants.slug') }}</dt>
                <dd class="font-mono">{{ row.slug }}</dd>
              </div>
              <div>
                <dt class="label">{{ t('platform.tenants.schema') }}</dt>
                <dd class="font-mono">{{ row.schema_name }}</dd>
              </div>
              <div>
                <dt class="label">{{ t('platform.tenants.created') }}</dt>
                <dd>{{ row.created_at ?? '—' }}</dd>
              </div>
              <div>
                <dt class="label">{{ t('platform.tenants.suspendedAt') }}</dt>
                <dd>{{ row.suspended_at ?? '—' }}</dd>
              </div>
              <div>
                <dt class="label">{{ t('platform.tenants.icon') }}</dt>
                <dd class="font-mono">{{ row.icon_hash || '—' }}</dd>
              </div>
            </dl>
          </section>

          <form class="card tenant-section" (submit)="onSaveName($event)">
            <h2 class="section-title">{{ t('platform.tenant.rename') }}</h2>
            <p class="hint">{{ t('platform.tenant.section.nameHint') }}</p>
            <label class="block" for="tenant-name">
              <span class="label">
                {{ t('platform.tenant.rename') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input
                id="tenant-name"
                class="input"
                name="name"
                type="text"
                required
                autocomplete="off"
                [value]="nameDraft()"
                (input)="onText(nameDraft, $event)"
              />
            </label>
            <div class="tenant-actions">
              <span class="hint">{{ t('validation.requiredLegend') }}</span>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }

        <!-- ================= ACCESS ================= -->
        @if (tab() === 'access') {
          <form class="card tenant-section" (submit)="onSaveAccess($event)">
            <h2 class="section-title">{{ t('platform.tenant.section.access') }}</h2>
            <p class="hint">{{ t('platform.tenant.section.accessHint') }}</p>
            <label class="block" for="tenant-owner">
              <span class="label">
                {{ t('platform.tenants.superadmin') }}
                <span style="color: var(--color-error)" aria-hidden="true">*</span>
              </span>
              <input
                id="tenant-owner"
                class="input"
                name="owner_discord_id"
                type="text"
                inputmode="numeric"
                required
                autocomplete="off"
                [value]="ownerDraft()"
                (input)="onText(ownerDraft, $event)"
              />
            </label>
            <div>
              <span class="label" id="tenant-rank-label">{{ t('platform.tenants.rank') }}</span>
              <app-select
                class="mt-1"
                [options]="rankOptions()"
                [value]="rankDraft()"
                [ariaLabelledBy]="'tenant-rank-label'"
                (valueChange)="rankDraft.set($event)"
              />
            </div>
            <app-checkbox
              inputId="tenant-default"
              [label]="t('platform.tenants.default')"
              [hint]="t('platform.tenants.defaultHint')"
              [checked]="defaultDraft()"
              (checkedChange)="defaultDraft.set($event)"
            />
            <div class="tenant-actions">
              <span class="hint">{{ t('validation.requiredLegend') }}</span>
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }

        <!-- ================= ALBION ================= -->
        @if (tab() === 'albion') {
          <form class="card tenant-section" (submit)="onSaveAlbion($event)">
            <h2 class="section-title">{{ t('platform.tenant.section.albion') }}</h2>
            <p class="hint">{{ t('platform.tenant.section.albionHint') }}</p>
            <label class="block" for="tenant-albion-guild">
              <span class="label">{{ t('platform.tenants.albionGuild') }}</span>
              <input
                id="tenant-albion-guild"
                class="input"
                name="albion_guild_id"
                type="text"
                autocomplete="off"
                [value]="albionGuildDraft()"
                (input)="onText(albionGuildDraft, $event)"
              />
            </label>
            <fieldset class="grid gap-2">
              <legend class="label">{{ t('register.region') }}</legend>
              <div class="tenant-radios">
                @for (region of regions; track region.id) {
                  <label class="tenant-radio" [attr.for]="'region-' + region.id">
                    <input
                      class="radio"
                      type="radio"
                      name="albion_api_region"
                      [id]="'region-' + region.id"
                      [value]="region.id"
                      [checked]="regionDraft() === region.id"
                      (change)="regionDraft.set(region.id)"
                    />
                    {{ t(region.labelKey) }}
                  </label>
                }
              </div>
            </fieldset>
            <label class="block" for="tenant-allied-ids">
              <span class="label">{{ t('platform.tenants.alliedIds') }}</span>
              <input
                id="tenant-allied-ids"
                class="input"
                name="albion_allied_guild_ids"
                type="text"
                autocomplete="off"
                [value]="alliedIdsDraft()"
                (input)="onText(alliedIdsDraft, $event)"
              />
            </label>
            <label class="block" for="tenant-allied-names">
              <span class="label">{{ t('platform.tenants.alliedNames') }}</span>
              <input
                id="tenant-allied-names"
                class="input"
                name="albion_allied_guild_names"
                type="text"
                autocomplete="off"
                [value]="alliedNamesDraft()"
                (input)="onText(alliedNamesDraft, $event)"
              />
            </label>
            <div class="tenant-actions">
              <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        }

        <!-- ================= FEATURES ================= -->
        @if (tab() === 'features') {
          <section class="card tenant-section" [attr.aria-label]="t('platform.tenant.features')">
            <h2 class="section-title">{{ t('platform.features.title') }}</h2>
            <p class="hint">{{ t('platform.features.subtitle') }}</p>
            @if (featuresFailed()) {
              <app-error-state
                [message]="t('platform.tenant.features.error')"
                [retryLabel]="t('common.retry')"
                (retry)="loadFeatures()"
              />
            } @else if (!features()) {
              <app-loading variant="lines" [rows]="4" [label]="t('common.loading')" />
            } @else if (featureRows().length === 0) {
              <app-empty-state
                icon="sparkles"
                [message]="t('platform.features.empty')"
                [compact]="true"
              />
            } @else {
              <form class="grid gap-3" (submit)="onSaveFeatures($event)">
                <fieldset class="grid gap-3" [disabled]="busy()">
                  <legend class="sr-only">{{ t('platform.features.title') }}</legend>
                  @for (item of featureRows(); track item.key) {
                    <app-checkbox
                      [inputId]="'flag-' + item.key"
                      [name]="item.key"
                      [label]="item.display_name"
                      [hint]="item.description ? item.key + ' · ' + item.description : item.key"
                      [checked]="item.enabled"
                      [disabled]="busy()"
                      (checkedChange)="onFeatureToggle(item.key, $event)"
                    />
                  }
                </fieldset>
                <div class="tenant-actions">
                  <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
                    {{ t('common.save') }}
                  </button>
                </div>
              </form>
            }
          </section>
        }
      </app-page-stack>

      @if (pendingSuspend()) {
        <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeSuspend()">
          <p>{{ t('platform.tenant.suspendConfirm', { name: row.name }) }}</p>
          <div dialogFooter>
            <button type="button" class="btn btn--outline" (click)="closeSuspend()">
              {{ t('common.cancel') }}
            </button>
            <button
              type="button"
              class="btn btn--danger"
              [disabled]="busy()"
              (click)="confirmSuspend()"
            >
              {{ t('platform.tenants.suspend') }}
            </button>
          </div>
        </app-dialog>
      }
    }
  `,
})
export class PlatformTenantDetail {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);

  protected readonly tenantId = this.route.snapshot.paramMap.get('tenantId') ?? '';
  protected readonly tenant = signal<PlatformTenant | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly notFound = signal(false);
  protected readonly busy = signal(false);
  protected readonly tab = signal<TenantTab>('overview');
  protected readonly pendingSuspend = signal(false);
  protected readonly ranks = signal<TenantRankView[]>([]);
  protected readonly regions = REGIONS;

  protected readonly nameDraft = signal('');
  protected readonly ownerDraft = signal('');
  protected readonly rankDraft = signal('');
  protected readonly defaultDraft = signal(false);
  protected readonly regionDraft = signal<(typeof REGIONS)[number]['id']>('europe');
  protected readonly albionGuildDraft = signal('');
  protected readonly alliedIdsDraft = signal('');
  protected readonly alliedNamesDraft = signal('');

  protected readonly features = signal<TenantFeaturesView | null>(null);
  protected readonly featuresFailed = signal(false);
  /** Local flag values keyed by feature key; the server copy lives in `features`. */
  protected readonly featureDraft = signal<Record<string, boolean>>({});

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly tabOptions = computed<readonly TabOption[]>(() => [
    { id: 'overview', label: this.t('platform.tenant.tab.overview') },
    { id: 'access', label: this.t('platform.tenant.tab.access') },
    { id: 'albion', label: this.t('platform.tenant.tab.albion') },
    { id: 'features', label: this.t('platform.tenant.features') },
  ]);

  protected readonly rankOptions = computed<SelectOption[]>(() => [
    { value: '', label: this.t('platform.tenants.none') },
    ...this.ranks().map((rank) => ({ value: rank.id, label: rank.name })),
  ]);

  /** Status, rank and creation date: the figures an officer checks before acting. */
  protected readonly summary = computed<SummaryItem[]>(() => {
    const row = this.tenant();
    if (!row) {
      return [];
    }
    const tone =
      row.status === 'active' ? 'success' : row.status === 'suspended' ? 'warning' : 'default';
    return [
      { label: this.t('platform.tenants.status'), value: this.statusLabel(row.status), tone },
      {
        label: this.t('platform.tenants.rank'),
        value: row.rank_name || this.t('platform.tenants.none'),
      },
      { label: this.t('platform.tenants.created'), value: row.created_at ?? '—' },
    ];
  });

  /** Dangerous actions only: suspending is the one, and it always asks first. */
  protected readonly menuItems = computed<EntityMenuItem[]>(() => {
    const row = this.tenant();
    if (!row || row.status !== 'active') {
      return [];
    }
    return [
      {
        id: 'suspend',
        label: this.t('platform.tenants.suspend'),
        danger: true,
        separatorBefore: true,
        disabled: this.busy(),
      },
    ];
  });

  protected readonly featureRows = computed(() => {
    const view = this.features();
    if (!view) {
      return [];
    }
    const draft = this.featureDraft();
    return view.catalog.map((item) => ({
      ...item,
      enabled: draft[item.key] ?? false,
    }));
  });

  constructor() {
    void this.load();
  }

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  protected statusLabel(status: string): string {
    if (status === 'active') {
      return this.t('platform.tenants.status.active');
    }
    if (status === 'suspended') {
      return this.t('platform.tenants.status.suspended');
    }
    if (status === 'provisioning') {
      return this.t('platform.tenants.status.provisioning');
    }
    return status;
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    this.notFound.set(false);
    try {
      const [match, ranks] = await Promise.all([
        firstValueFrom(this.api.get<PlatformTenant>(`api/platform/tenants/${this.tenantId}`)),
        firstValueFrom(this.api.get<TenantRankView[]>('api/platform/ranks')),
      ]);
      this.ranks.set(ranks);
      this.applyTenant(match);
    } catch (error) {
      this.tenant.set(null);
      if (error instanceof ApiError && error.status === 404) {
        this.notFound.set(true);
      } else {
        this.loadFailed.set(true);
      }
    } finally {
      this.loading.set(false);
    }
  }

  protected onTabChange(id: string): void {
    if (!(TENANT_TABS as readonly string[]).includes(id)) {
      return;
    }
    this.tab.set(id as TenantTab);
    if (id === 'features' && !this.features()) {
      void this.loadFeatures();
    }
  }

  protected onMenu(id: string): void {
    if (id === 'suspend') {
      this.pendingSuspend.set(true);
    }
  }

  protected closeSuspend(): void {
    this.pendingSuspend.set(false);
  }

  protected async confirmSuspend(): Promise<void> {
    this.pendingSuspend.set(false);
    await this.setStatus('suspended');
  }

  protected onSaveName(event: SubmitEvent): void {
    event.preventDefault();
    const name = this.nameDraft().trim();
    if (!name) {
      return;
    }
    void this.save({ name });
  }

  protected onSaveAccess(event: SubmitEvent): void {
    event.preventDefault();
    const owner = this.ownerDraft().trim();
    if (!owner) {
      return;
    }
    void this.save({
      owner_discord_id: owner,
      rank_id: this.rankDraft(),
      is_default: this.defaultDraft(),
    });
  }

  protected onSaveAlbion(event: SubmitEvent): void {
    event.preventDefault();
    void this.save({
      albion_guild_id: this.albionGuildDraft().trim(),
      albion_api_region: this.regionDraft(),
      albion_allied_guild_ids: this.alliedIdsDraft().trim(),
      albion_allied_guild_names: this.alliedNamesDraft().trim(),
    });
  }

  protected async setStatus(status: 'active' | 'suspended'): Promise<void> {
    await this.save({ status });
  }

  protected async loadFeatures(): Promise<void> {
    this.featuresFailed.set(false);
    try {
      const view = await firstValueFrom(
        this.api.get<TenantFeaturesView>(`api/platform/tenants/${this.tenantId}/features`),
      );
      this.applyFeatures(view);
    } catch {
      this.featuresFailed.set(true);
    }
  }

  protected onFeatureToggle(key: string, enabled: boolean): void {
    this.featureDraft.update((current) => ({ ...current, [key]: enabled }));
  }

  protected async onSaveFeatures(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    try {
      const view = await firstValueFrom(
        this.api.put<TenantFeaturesView>(`api/platform/tenants/${this.tenantId}/features`, {
          flags: this.featureRows().map((row) => ({ key: row.key, enabled: row.enabled })),
        }),
      );
      this.applyFeatures(view);
      this.toasts.success(this.t('platform.features.saved'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  /** One PATCH per section; the server ignores fields that are not sent. */
  private async save(body: Record<string, unknown>): Promise<void> {
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${this.tenantId}`, body),
      );
      this.tenant.set(updated);
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch {
      this.toasts.error(this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  private applyFeatures(view: TenantFeaturesView): void {
    this.features.set(view);
    this.featureDraft.set(
      Object.fromEntries(view.flags.map((flag): [string, boolean] => [flag.key, flag.enabled])),
    );
  }

  private applyTenant(row: PlatformTenant): void {
    this.tenant.set(row);
    this.nameDraft.set(row.name);
    this.ownerDraft.set(row.owner_discord_id ?? '');
    this.albionGuildDraft.set(row.albion_guild_id ?? '');
    this.alliedIdsDraft.set(row.albion_allied_guild_ids ?? '');
    this.alliedNamesDraft.set(row.albion_allied_guild_names ?? '');
    this.rankDraft.set(row.rank_id ?? '');
    this.defaultDraft.set(row.is_default === true);
    const region = row.albion_api_region;
    if (region === 'americas' || region === 'asia' || region === 'europe') {
      this.regionDraft.set(region);
    }
  }
}
