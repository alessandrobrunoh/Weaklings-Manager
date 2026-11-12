import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
import { Dialog } from '../../shared/components/dialog/dialog';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { SearchableSelect } from '../../shared/components/searchable-select/searchable-select';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
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

/** Quiet period after the last keystroke before the search hits the server. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Admin giveaway list: one table of draws with their status and end time, a filter bar, and one
 * primary action that opens the create dialog. Discord channel and role settings sit behind the
 * page menu, so the list stays the first thing an officer sees.
 */
@Component({
  selector: 'app-admin-giveaways',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTable,
    Dialog,
    FilterBar,
    PageHeader,
    PageStack,
    RouterLink,
    SearchableSelect,
    StatusChip,
  ],
  template: `
    <app-page-header
      [title]="t('giveaways.title')"
      [subtitle]="t('giveaways.subtitle')"
      [menuItems]="pageMenu()"
      (menuSelect)="onPageMenu($event)"
    >
      @if (canCreate()) {
        <button type="button" class="btn btn--primary" (click)="createOpen.set(true)">
          {{ t('giveaways.create') }}
        </button>
      }
    </app-page-header>

    <app-page-stack>
      <app-filter-bar
        [searchLabel]="t('giveaways.searchLabel')"
        [searchPlaceholder]="t('giveaways.searchPlaceholder')"
        [query]="search()"
        [activeCount]="search().trim() ? 1 : 0"
        (queryChange)="onSearch($event)"
        (clear)="onSearch('')"
      />

      <app-data-table
        [columns]="columns"
        [rows]="rows()"
        [loading]="logsLoading()"
        [error]="logsFailed()"
        (retry)="loadLogs()"
        [trackBy]="trackById"
        [serverMode]="true"
        [hideSearch]="true"
        [totalItems]="totalItems()"
        [pageSize]="tableQuery().pageSize"
        [mobileLayout]="'stack'"
        [ariaLabel]="t('giveaways.logs')"
        emptyLabel="giveaways.empty"
        (pageChange)="onTableChange($event)"
      >
        <ng-template dataTableCell="title" let-row>
          <a class="font-medium" [routerLink]="['/admin/giveaways', row.id]">{{ row.title }}</a>
        </ng-template>
        <ng-template dataTableCell="status" let-row>
          <app-status-chip [value]="row.status" [label]="statusLabel(row.status)" />
        </ng-template>
        <ng-template dataTableCell="ends_at" let-row>
          {{ formatWhen(row.ends_at) }}
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (canManageSettings()) {
      <app-dialog
        [open]="settingsOpen()"
        [title]="t('giveaways.settings')"
        size="md"
        (closed)="settingsOpen.set(false)"
      >
        <form id="giveaway-settings-form" class="grid gap-4" (submit)="saveSettings($event)">
          <label class="grid gap-1">
            <span class="label">{{ t('giveaways.channel') }}</span>
            <app-searchable-select
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
            <span class="hint">{{ t('giveaways.channelHint') }}</span>
          </label>
          <label class="grid gap-1">
            <span class="label">{{ t('giveaways.role') }}</span>
            <app-searchable-select
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
            <span class="hint">{{ t('giveaways.roleHint') }}</span>
          </label>
        </form>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="settingsOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" form="giveaway-settings-form" class="btn btn--primary" [disabled]="savingSettings()">
            {{ t('common.save') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (canCreate()) {
      <app-dialog
        [open]="createOpen()"
        [title]="t('giveaways.create')"
        size="lg"
        (closed)="createOpen.set(false)"
      >
        <form id="giveaway-create-form" class="grid gap-4" (submit)="createGiveaway($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="grid gap-1">
            <span class="label">
              {{ t('giveaways.field.title') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input class="input" required [value]="title()" (input)="title.set(inputValue($event))" />
          </label>
          <label class="grid gap-1">
            <span class="label">{{ t('giveaways.field.description') }}</span>
            <textarea class="input min-h-24" [value]="description()" (input)="description.set(inputValue($event))"></textarea>
          </label>
          <label class="grid gap-1">
            <span class="label">
              {{ t('giveaways.field.endsAt') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              class="input"
              type="datetime-local"
              required
              [value]="endsAt()"
              (input)="endsAt.set(inputValue($event))"
            />
          </label>

          <fieldset class="grid gap-4 sm:grid-cols-2" aria-describedby="giveaway-prize-requirement">
            <legend class="label sm:col-span-2">
              {{ t('giveaways.prizes') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </legend>
            <p id="giveaway-prize-requirement" class="hint sm:col-span-2">
              {{ t('giveaways.needPrize') }}
            </p>
            <label class="grid gap-1">
              <span class="label">{{ t('giveaways.field.silver') }}</span>
              <input class="input" inputmode="numeric" [value]="silver()" (input)="silver.set(inputValue($event))" />
              <span class="hint">{{ t('giveaways.field.silverHint') }}</span>
            </label>
            <label class="grid gap-1">
              <span class="label">{{ t('giveaways.field.regearBonus') }}</span>
              <input
                class="input"
                type="number"
                min="0"
                inputmode="numeric"
                [value]="regearRequestBonus()"
                (input)="regearRequestBonus.set(inputValue($event))"
              />
              <span class="hint">{{ t('giveaways.field.regearBonusHint') }}</span>
            </label>

            <div class="grid gap-3 sm:col-span-2">
              <div class="grid gap-2 sm:grid-cols-4">
                <label class="grid gap-1 sm:col-span-2">
                  <span class="label">{{ t('giveaways.searchItem') }}</span>
                  <input
                    class="input"
                    type="search"
                    [value]="itemQuery()"
                    (input)="onItemQuery($event)"
                    (keydown.enter)="$event.preventDefault()"
                  />
                </label>
                <label class="grid gap-1">
                  <span class="label">{{ t('giveaways.quality') }}</span>
                  <select class="select" [value]="itemQuality()" (change)="onItemQuality($event)">
                    @for (grade of qualities; track grade.id) {
                      <option [value]="grade.id">{{ grade.label }}</option>
                    }
                  </select>
                </label>
                <label class="grid gap-1">
                  <span class="label">{{ t('giveaways.quantity') }}</span>
                  <input
                    class="input"
                    type="number"
                    min="1"
                    [value]="itemQty()"
                    (input)="itemQty.set(Math.max(1, numberValue($event)))"
                  />
                </label>
              </div>
              @if (itemResults().length > 0) {
                <div class="grid max-h-48 gap-1 overflow-auto rounded border border-[var(--color-border)] p-1">
                  @for (item of itemResults(); track item.id) {
                    <button type="button" class="btn btn--ghost btn--sm justify-start" (click)="addPrize(item)">
                      {{ item.name }} · {{ item.tier }}
                    </button>
                  }
                </div>
              }
              @if (prizes().length === 0) {
                <p class="hint">{{ t('giveaways.noPrizes') }}</p>
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
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        [attr.aria-label]="t('giveaways.removePrize')"
                        (click)="removePrize(prize.key)"
                      >
                        ×
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
          </fieldset>
        </form>
        <div dialogFooter class="flex justify-end gap-2">
          <button type="button" class="btn btn--outline" (click)="createOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" form="giveaway-create-form" class="btn btn--primary" [disabled]="creating()">
            {{ t('giveaways.create') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class AdminGiveaways {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);
  private readonly catalog = inject(AlbionCatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly Math = Math;
  protected readonly qualities = ALBION_ITEM_QUALITIES;
  protected readonly logsLoading = signal(true);
  protected readonly logsFailed = signal(false);
  protected readonly catalogLoading = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly createOpen = signal(false);
  protected readonly savingSettings = signal(false);
  protected readonly creating = signal(false);
  protected readonly channelId = signal('');
  protected readonly roleId = signal('');
  protected readonly channels = signal<DiscordChannelView[]>([]);
  protected readonly roles = signal<DiscordRoleView[]>([]);
  protected readonly rows = signal<GiveawayView[]>([]);
  protected readonly totalItems = signal(0);
  protected readonly tableQuery = signal<DataTablePageChange>(
    parseDataTableQuery(this.route.snapshot.queryParamMap, { defaultPageSize: 25 }),
  );
  /** Page-owned search text; the table's own search box is hidden in favour of the filter bar. */
  protected readonly search = signal(this.tableQuery().search);
  protected readonly title = signal('');
  protected readonly description = signal('');
  protected readonly endsAt = signal(defaultEndsAtLocal());
  protected readonly silver = signal('');
  protected readonly regearRequestBonus = signal('');
  protected readonly prizes = signal<PrizeDraft[]>([]);
  protected readonly itemQuery = signal('');
  protected readonly itemQuality = signal(DEFAULT_ALBION_ITEM_QUALITY);
  protected readonly itemQty = signal(1);
  protected readonly itemResults = signal<OpenAlbionItem[]>([]);
  private catalogItems: readonly OpenAlbionItem[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private itemTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly canManageSettings = computed(() =>
    this.auth.hasPermission('admin.settings.manage'),
  );
  protected readonly canCreate = computed(() => this.auth.hasPermission('giveaways.create'));
  protected readonly pageMenu = computed<MenuItem[]>(() =>
    this.canManageSettings() ? [{ id: 'settings', label: this.t('giveaways.settings') }] : [],
  );
  protected readonly channelOptions = computed(() =>
    channelSelectOptions(this.channels(), ['text'], this.channelId()),
  );
  protected readonly roleOptions = computed(() => roleSelectOptions(this.roles(), this.roleId()));

  protected readonly columns: DataTableColumn<GiveawayView>[] = [
    {
      key: 'title',
      label: 'giveaways.field.title',
      sortable: true,
      searchable: true,
      accessor: (row) => row.title,
    },
    {
      key: 'status',
      label: 'common.status',
      sortable: true,
      accessor: (row) => row.status,
    },
    {
      key: 'ends_at',
      label: 'giveaways.ends',
      sortable: true,
      accessor: (row) => row.ends_at,
    },
    {
      key: 'entry_count',
      label: 'giveaways.participants',
      align: 'right',
      accessor: (row) => row.entry_count,
    },
    {
      key: 'winner_username',
      label: 'giveaways.winner',
      accessor: (row) => row.winner_username ?? this.t('giveaways.none'),
    },
  ];

  protected readonly trackById = (row: GiveawayView): number => row.id;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (this.itemTimer) clearTimeout(this.itemTimer);
    });
    void this.loadLogs();
    void this.loadCatalog();
  }

  protected onTableChange(change: DataTablePageChange): void {
    this.tableQuery.set({ ...change, search: this.search().trim() });
    void this.loadLogs();
  }

  protected onSearch(value: string): void {
    this.search.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.tableQuery.update((query) => ({ ...query, page: 1, search: value.trim() }));
      void this.loadLogs();
    }, SEARCH_DEBOUNCE_MS);
  }

  protected onPageMenu(id: string): void {
    if (id === 'settings') {
      this.settingsOpen.set(true);
      void this.loadSettings();
    }
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
    return this.t(`giveaways.status.${status}` as TranslationKey);
  }

  protected formatWhen(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(this.i18n.locale());
  }

  protected onItemQuery(event: Event): void {
    const query = this.inputValue(event);
    this.itemQuery.set(query);
    if (this.itemTimer) clearTimeout(this.itemTimer);
    this.itemTimer = setTimeout(() => this.filterItems(query), SEARCH_DEBOUNCE_MS);
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
      this.settingsOpen.set(false);
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
    const regearBonus = Number(this.regearRequestBonus().trim() || 0);
    if (prizes.length === 0 && !silver && regearBonus <= 0) {
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
          regear_request_bonus: regearBonus > 0 ? regearBonus : null,
          prizes,
        }),
      );
      this.title.set('');
      this.description.set('');
      this.silver.set('');
      this.regearRequestBonus.set('');
      this.prizes.set([]);
      this.endsAt.set(defaultEndsAtLocal());
      this.createOpen.set(false);
      this.toasts.success(this.t('giveaways.created'));
      await this.loadLogs();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }

  protected async loadLogs(): Promise<void> {
    this.logsLoading.set(true);
    this.logsFailed.set(false);
    try {
      const query = this.tableQuery();
      const page = await firstValueFrom(
        this.api.get<PaginatedData<GiveawayView>>('api/giveaways', {
          page: query.page,
          limit: query.pageSize,
          search: query.search.trim() || undefined,
          sort: query.sort?.columnKey ?? 'created_at',
          order: query.sort?.direction ?? 'desc',
        }),
      );
      this.rows.set(page.items);
      this.totalItems.set(page.total_items);
    } catch {
      this.logsFailed.set(true);
    } finally {
      this.logsLoading.set(false);
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

  private async loadCatalog(): Promise<void> {
    try {
      this.catalogItems = await this.catalog.load();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
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
