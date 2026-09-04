import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  CreateGiveawayPrizeRequest,
  DiscordChannelView,
  DiscordRoleView,
  GiveawayStatus,
  GiveawayView,
  GuildSettingsView,
  OpenAlbionItem,
  PaginatedData,
  UpdateGuildSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { channelSelectOptions, roleSelectOptions } from '../../shared/discord/discord-options';
import {
  ALBION_ITEM_QUALITIES,
  DEFAULT_ALBION_ITEM_QUALITY,
  normalizeAlbionItemQuality,
} from '../../shared/data/albion-item-quality';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';

interface PrizeDraft extends CreateGiveawayPrizeRequest {
  key: string;
}

/**
 * Admin giveaway console: Discord channel, create a draw, and browse logs.
 */
@Component({
  selector: 'app-admin-giveaways',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    Loading,
    PageHeader,
    PageStack,
    SearchableSelect,
  ],
  template: `
    <app-page-header [title]="t('giveaways.title')" [subtitle]="t('giveaways.subtitle')" />

    <app-page-stack>
      @if (pageLoading()) {
        <app-loading />
      } @else {
        @if (canManageSettings()) {
          <section class="card p-5">
            <form class="grid gap-4 sm:grid-cols-2" (submit)="saveSettings($event)">
              <h2 class="eyebrow sm:col-span-2">{{ t('giveaways.settings') }}</h2>
              <label>
                <span class="label">{{ t('giveaways.channel') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="channelOptions()"
                  [value]="channelId()"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('giveaways.channel')"
                  (valueChange)="channelId.set($event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('giveaways.channelHint') }}
                </span>
              </label>
              <label>
                <span class="label">{{ t('giveaways.role') }}</span>
                <app-searchable-select
                  class="mt-1 block"
                  [options]="roleOptions()"
                  [value]="roleId()"
                  [emptyLabel]="t('admin.discord.placeholder')"
                  [searchPlaceholder]="t('common.search')"
                  [noMatchesLabel]="t('picker.noMatches')"
                  [emptyOptionsLabel]="t('picker.empty')"
                  [loading]="catalogLoading()"
                  [ariaLabel]="t('giveaways.role')"
                  (valueChange)="roleId.set($event)"
                />
                <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                  {{ t('giveaways.roleHint') }}
                </span>
              </label>
              <div class="sm:col-span-2">
                <button type="submit" class="btn btn--primary" [disabled]="savingSettings()">
                  {{ t('common.save') }}
                </button>
              </div>
            </form>
          </section>
        }

        @if (canCreate()) {
          <section class="card p-5">
            <form class="grid gap-4" (submit)="createGiveaway($event)">
              <h2 class="eyebrow">{{ t('giveaways.create') }}</h2>
              <label>
                <span class="label">{{ t('giveaways.field.title') }}</span>
                <input class="input mt-1" [value]="title()" (input)="title.set(inputValue($event))" />
              </label>
              <label>
                <span class="label">{{ t('giveaways.field.description') }}</span>
                <textarea
                  class="input mt-1 min-h-24"
                  [value]="description()"
                  (input)="description.set(inputValue($event))"
                ></textarea>
              </label>
              <div class="grid gap-4 sm:grid-cols-2">
                <label>
                  <span class="label">{{ t('giveaways.field.endsAt') }}</span>
                  <input
                    class="input mt-1"
                    type="datetime-local"
                    [value]="endsAt()"
                    (input)="endsAt.set(inputValue($event))"
                  />
                </label>
                <label>
                  <span class="label">{{ t('giveaways.field.silver') }}</span>
                  <input
                    class="input mt-1"
                    inputmode="numeric"
                    [value]="silver()"
                    (input)="silver.set(inputValue($event))"
                  />
                  <span class="mt-1 block text-xs" style="color: var(--color-text-secondary)">
                    {{ t('giveaways.field.silverHint') }}
                  </span>
                </label>
              </div>

              <div class="grid gap-3">
                <span class="label">{{ t('giveaways.prizes') }}</span>
                <div class="grid gap-2 sm:grid-cols-4">
                  <label class="sm:col-span-2">
                    <span class="label">{{ t('giveaways.searchItem') }}</span>
                    <input
                      class="input mt-1"
                      type="search"
                      [value]="itemQuery()"
                      (input)="onItemQuery($event)"
                    />
                  </label>
                  <label>
                    <span class="label">{{ t('giveaways.quality') }}</span>
                    <select class="select mt-1" [value]="itemQuality()" (change)="onItemQuality($event)">
                      @for (grade of qualities; track grade.id) {
                        <option [value]="grade.id">{{ grade.label }}</option>
                      }
                    </select>
                  </label>
                  <label>
                    <span class="label">{{ t('giveaways.quantity') }}</span>
                    <input
                      class="input mt-1"
                      type="number"
                      min="1"
                      [value]="itemQty()"
                      (input)="itemQty.set(Math.max(1, numberValue($event)))"
                    />
                  </label>
                </div>
                @if (itemResults().length > 0) {
                  <div class="grid gap-1 max-h-48 overflow-auto rounded border border-[var(--color-border)] p-1">
                    @for (item of itemResults(); track item.id) {
                      <button type="button" class="btn btn--ghost btn--sm justify-start" (click)="addPrize(item)">
                        {{ item.name }} · {{ item.tier }}
                      </button>
                    }
                  </div>
                }
                @if (prizes().length === 0) {
                  <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('giveaways.noPrizes') }}</p>
                } @else {
                  <ul class="grid gap-2">
                    @for (prize of prizes(); track prize.key) {
                      <li class="flex items-center justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2">
                        <span class="text-sm">
                          {{ prize.openalbion_item_name }}
                          · {{ prize.openalbion_item_tier }}
                          · {{ qualityName(prize.openalbion_item_quality) }}
                          · ×{{ prize.quantity }}
                        </span>
                        <button type="button" class="btn btn--ghost btn--sm" (click)="removePrize(prize.key)">
                          ×
                        </button>
                      </li>
                    }
                  </ul>
                }
              </div>
              <div>
                <button type="submit" class="btn btn--primary" [disabled]="creating()">
                  {{ t('giveaways.create') }}
                </button>
              </div>
            </form>
          </section>
        }

        <section class="card p-5">
          <h2 class="eyebrow mb-3">{{ t('giveaways.logs') }}</h2>
          <app-data-table
            [columns]="columns"
            [rows]="rows()"
            [loading]="logsLoading()"
            [trackBy]="trackById"
            emptyLabel="giveaways.empty"
            [rowClickable]="true"
            (rowClick)="openLog($event)"
          />
        </section>
      }
    </app-page-stack>
  `,
})
export class AdminGiveaways {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);
  private readonly catalog = inject(AlbionCatalogService);
  private readonly router = inject(Router);

  protected readonly Math = Math;
  protected readonly qualities = ALBION_ITEM_QUALITIES;
  protected readonly pageLoading = signal(true);
  protected readonly catalogLoading = signal(false);
  protected readonly logsLoading = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly creating = signal(false);
  protected readonly channelId = signal('');
  protected readonly roleId = signal('');
  protected readonly channels = signal<DiscordChannelView[]>([]);
  protected readonly roles = signal<DiscordRoleView[]>([]);
  protected readonly rows = signal<GiveawayView[]>([]);
  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly endsAt = signal(defaultEndsAtLocal());
  protected readonly silver = signal('');
  protected readonly prizes = signal<PrizeDraft[]>([]);
  protected readonly itemQuery = signal('');
  protected readonly itemQuality = signal(DEFAULT_ALBION_ITEM_QUALITY);
  protected readonly itemQty = signal(1);
  protected readonly itemResults = signal<OpenAlbionItem[]>([]);
  private catalogItems: readonly OpenAlbionItem[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly canManageSettings = computed(() =>
    this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly canCreate = computed(() => this.auth.hasPermission('giveaways.create'));
  protected readonly channelOptions = computed(() =>
    channelSelectOptions(this.channels(), ['text'], this.channelId()),
  );
  protected readonly roleOptions = computed(() => roleSelectOptions(this.roles(), this.roleId()));

  protected readonly columns: DataTableColumn<GiveawayView>[] = [
    { key: 'title', label: 'giveaways.field.title', accessor: (row) => row.title },
    { key: 'status', label: 'common.status', accessor: (row) => this.statusLabel(row.status) },
    { key: 'ends_at', label: 'giveaways.ends', accessor: (row) => formatWhen(row.ends_at) },
    {
      key: 'entry_count',
      label: 'giveaways.participants',
      accessor: (row) => row.entry_count,
    },
    {
      key: 'winner_username',
      label: 'giveaways.winner',
      accessor: (row) => row.winner_username ?? this.t('giveaways.none'),
    },
  ];

  protected readonly trackById = (row: GiveawayView): number => row.id;

  protected openLog(row: GiveawayView): void {
    void this.router.navigate(['/admin/giveaways', row.id]);
  }

  constructor() {
    void this.load();
  }

  protected t(key: TranslationKey): string {
    return this.i18n.t(key);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected numberValue(event: Event): number {
    return Number((event.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected onItemQuality(event: Event): void {
    this.itemQuality.set(normalizeAlbionItemQuality(this.numberValue(event)));
  }

  protected qualityName(quality: number | undefined): string {
    return ALBION_ITEM_QUALITIES.find((grade) => grade.id === quality)?.label ?? 'Excellent';
  }

  protected statusLabel(status: GiveawayStatus): string {
    const key = `giveaways.status.${status}` as TranslationKey;
    return this.t(key);
  }

  protected onItemQuery(event: Event): void {
    const query = this.inputValue(event);
    this.itemQuery.set(query);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.filterItems(query), 200);
  }

  protected addPrize(item: OpenAlbionItem): void {
    this.prizes.update((prizes) => [
      ...prizes,
      {
        key: `${item.id}-${this.itemQuality()}-${Date.now()}`,
        openalbion_item_id: item.id,
        openalbion_item_name: item.name,
        openalbion_item_icon: item.icon,
        openalbion_item_identifier: item.identifier,
        openalbion_item_tier: item.tier,
        openalbion_item_quality: this.itemQuality(),
        quantity: this.itemQty(),
      },
    ]);
    this.itemQuery.set('');
    this.itemResults.set([]);
  }

  protected removePrize(key: string): void {
    this.prizes.update((prizes) => prizes.filter((prize) => prize.key !== key));
  }

  protected async saveSettings(event: Event): Promise<void> {
    event.preventDefault();
    this.savingSettings.set(true);
    try {
      const body: UpdateGuildSettingsRequest = {
        discord_giveaways_channel_id: this.channelId(),
        discord_giveaways_role_id: this.roleId(),
      };
      await firstValueFrom(this.api.put<GuildSettingsView>('api/admin/settings', body));
      this.toasts.success(this.t('giveaways.settingsSaved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.savingSettings.set(false);
    }
  }

  protected async createGiveaway(event: Event): Promise<void> {
    event.preventDefault();
    const prizes = this.prizes().map(({ key: _key, ...prize }) => prize);
    const silver = this.silver().trim();
    if (prizes.length === 0 && !silver) {
      this.toasts.error(this.t('giveaways.needPrize'));
      return;
    }
    this.creating.set(true);
    try {
      await firstValueFrom(
        this.api.post('api/giveaways', {
          title: this.title().trim(),
          description: this.description().trim() || null,
          ends_at: new Date(this.endsAt()).toISOString(),
          silver_amount: silver || null,
          prizes,
        }),
      );
      this.title.set('');
      this.description.set('');
      this.silver.set('');
      this.prizes.set([]);
      this.endsAt.set(defaultEndsAtLocal());
      this.toasts.success(this.t('giveaways.created'));
      await this.loadLogs();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }

  private async load(): Promise<void> {
    this.pageLoading.set(true);
    try {
      const jobs: Array<Promise<void>> = [this.loadLogs(), this.loadCatalog()];
      if (this.canManageSettings()) {
        jobs.push(this.loadSettings());
      }
      await Promise.all(jobs);
    } finally {
      this.pageLoading.set(false);
    }
  }

  private async loadSettings(): Promise<void> {
    this.catalogLoading.set(true);
    try {
      const [settings, channels, roles] = await Promise.all([
        firstValueFrom(this.api.get<GuildSettingsView>('api/admin/settings')),
        firstValueFrom(this.api.get<DiscordChannelView[]>('api/admin/discord/channels')),
        firstValueFrom(this.api.get<DiscordRoleView[]>('api/admin/discord/roles')),
      ]);
      this.channelId.set(settings.discord_giveaways_channel_id ?? '');
      this.roleId.set(settings.discord_giveaways_role_id ?? '');
      this.channels.set(channels);
      this.roles.set(roles);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.catalogLoading.set(false);
    }
  }

  private async loadLogs(): Promise<void> {
    this.logsLoading.set(true);
    try {
      const page = await firstValueFrom(
        this.api.get<PaginatedData<GiveawayView>>('api/giveaways', {
          page: 1,
          limit: 50,
          sort: 'created_at',
          order: 'desc',
        }),
      );
      this.rows.set(page.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.logsLoading.set(false);
    }
  }

  private async loadCatalog(): Promise<void> {
    this.catalogItems = await this.catalog.load();
  }

  private filterItems(query: string): void {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) {
      this.itemResults.set([]);
      return;
    }
    this.itemResults.set(
      this.catalogItems
        .filter((item) => item.name.toLowerCase().includes(needle) || (item.identifier ?? '').toLowerCase().includes(needle))
        .slice(0, 12),
    );
  }
}

function defaultEndsAtLocal(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
