import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformTenant, TenantRankView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const REGIONS = [
  { id: 'europe', labelKey: 'register.region.europe' as const },
  { id: 'americas', labelKey: 'register.region.americas' as const },
  { id: 'asia', labelKey: 'register.region.asia' as const },
] as const;

/**
 * Single tenant on the control plane: full record, SuperAdmin, Albion, flags.
 */
@Component({
  selector: 'app-platform-tenant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header
      [title]="tenant()?.name ?? t('platform.tenants.title')"
      [subtitle]="t('platform.tenant.subtitle')"
      [badge]="tenant()?.id"
    >
      <a routerLink="/platform/tenants" class="btn btn--outline btn--sm no-underline">
        {{ t('nav.platform.tenants') }}
      </a>
    </app-page-header>

    <app-page-stack>
      @if (loadFailed()) {
        <p class="text-sm" style="color: var(--color-danger)">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else if (tenant(); as row) {
        <section class="card p-4 grid gap-3 sm:grid-cols-2">
          <p>
            <span class="label">{{ t('platform.tenants.status') }}</span>
            <span class="chip mt-1 inline-flex">{{ statusLabel(row.status) }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.schema') }}</span>
            <span class="font-mono text-sm">{{ row.schema_name }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.slug') }}</span>
            <span class="font-mono text-sm">{{ row.slug }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.id') }}</span>
            <span class="font-mono text-sm">{{ row.id }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.created') }}</span>
            <span class="text-sm">{{ row.created_at ?? '—' }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.suspendedAt') }}</span>
            <span class="text-sm">{{ row.suspended_at ?? '—' }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.icon') }}</span>
            <span class="font-mono text-sm">{{ row.icon_hash || '—' }}</span>
          </p>
        </section>

        <form class="card p-4 grid gap-4 max-w-lg" (submit)="onSave($event)">
          <label class="block" for="tenant-name">
            <span class="label">{{ t('platform.tenant.rename') }}</span>
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
          <label class="block" for="tenant-rank">
            <span class="label">{{ t('platform.tenants.rank') }}</span>
            <select
              id="tenant-rank"
              class="input"
              name="rank_id"
              [value]="rankDraft()"
              (change)="onRankChange($event)"
            >
              <option value="">{{ t('platform.tenants.none') }}</option>
              @for (rank of ranks(); track rank.id) {
                <option [value]="rank.id">{{ rank.name }}</option>
              }
            </select>
          </label>
          <label class="block" for="tenant-owner">
            <span class="label">{{ t('platform.tenants.superadmin') }}</span>
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

          <fieldset class="grid gap-3">
            <legend class="label">{{ t('register.region') }}</legend>
            @for (region of regions; track region.id) {
              <label class="flex items-center gap-2" [attr.for]="'region-' + region.id">
                <input
                  class="radio"
                  type="radio"
                  name="albion_api_region"
                  [id]="'region-' + region.id"
                  [value]="region.id"
                  [checked]="regionDraft() === region.id"
                  (change)="regionDraft.set(region.id)"
                />
                <span class="text-sm">{{ t(region.labelKey) }}</span>
              </label>
            }
          </fieldset>

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

          <div class="flex flex-wrap gap-2">
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
              {{ t('common.save') }}
            </button>
            @if (row.status === 'active') {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="busy()"
                (click)="setStatus('suspended')"
              >
                {{ t('platform.tenants.suspend') }}
              </button>
            } @else if (row.status === 'suspended') {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="busy()"
                (click)="setStatus('active')"
              >
                {{ t('platform.tenants.resume') }}
              </button>
            }
            <a
              class="btn btn--tonal btn--sm no-underline inline-flex items-center gap-1.5"
              [routerLink]="['/platform/tenants', row.id, 'features']"
            >
              <app-icon name="sparkles" size="0.875rem" />
              {{ t('platform.tenant.features') }}
            </a>
          </div>
        </form>
      } @else if (!loading()) {
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('platform.tenants.empty') }}
        </p>
      }
    </app-page-stack>
  `,
})
export class PlatformTenantDetail {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);

  protected readonly tenantId = this.route.snapshot.paramMap.get('tenantId') ?? '';
  protected readonly tenant = signal<PlatformTenant | null>(null);
  protected readonly nameDraft = signal('');
  protected readonly ownerDraft = signal('');
  protected readonly regionDraft = signal<(typeof REGIONS)[number]['id']>('europe');
  protected readonly albionGuildDraft = signal('');
  protected readonly alliedIdsDraft = signal('');
  protected readonly alliedNamesDraft = signal('');
  protected readonly rankDraft = signal('');
  protected readonly ranks = signal<TenantRankView[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly regions = REGIONS;

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  protected onRankChange(event: Event): void {
    this.rankDraft.set((event.target as HTMLSelectElement).value);
  }

  constructor() {
    void this.load();
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
    try {
      const [match, ranks] = await Promise.all([
        firstValueFrom(this.api.get<PlatformTenant>(`api/platform/tenants/${this.tenantId}`)),
        firstValueFrom(this.api.get<TenantRankView[]>('api/platform/ranks')),
      ]);
      this.ranks.set(ranks);
      this.applyTenant(match);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async onSave(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = this.nameDraft().trim();
    const owner = this.ownerDraft().trim();
    if (!name || !owner || !this.tenantId) {
      return;
    }
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${this.tenantId}`, {
          name,
          owner_discord_id: owner,
          albion_guild_id: this.albionGuildDraft().trim(),
          albion_api_region: this.regionDraft(),
          albion_allied_guild_ids: this.alliedIdsDraft().trim(),
          albion_allied_guild_names: this.alliedNamesDraft().trim(),
          rank_id: this.rankDraft(),
        }),
      );
      this.applyTenant(updated);
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async setStatus(status: 'active' | 'suspended'): Promise<void> {
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${this.tenantId}`, { status }),
      );
      this.applyTenant(updated);
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  private applyTenant(row: PlatformTenant): void {
    this.tenant.set(row);
    this.nameDraft.set(row.name);
    this.ownerDraft.set(row.owner_discord_id ?? '');
    this.albionGuildDraft.set(row.albion_guild_id ?? '');
    this.alliedIdsDraft.set(row.albion_allied_guild_ids ?? '');
    this.alliedNamesDraft.set(row.albion_allied_guild_names ?? '');
    this.rankDraft.set(row.rank_id ?? '');
    const region = row.albion_api_region;
    if (region === 'americas' || region === 'asia' || region === 'europe') {
      this.regionDraft.set(region);
    }
  }
}
