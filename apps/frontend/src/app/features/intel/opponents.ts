import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { EnemyGuildSummary, EnemyPlayerSummary } from '../../core/models/api.models';
import { EnemiesService } from '../../core/services/enemies.service';
import type {
  ListEnemyGuildsParams,
  ListEnemyPlayersParams,
} from '../../core/services/enemies.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

/** Default page size for both the enemy guild and enemy player tables. */
const PAGE_LIMIT = 25;

/**
 * Enemy identity browser: every enemy guild and player identified from battle
 * evidence, server-paged and searchable.
 *
 * Both tables load lazily — the player table only fetches once the Players
 * tab is first opened, since most visits only need one of the two lists.
 */
@Component({
  selector: 'app-opponents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DataTable, DataTableCell, Icon, PageHeader, PageStack, RouterLink, ViewToggle],
  template: `
    <app-page-header [title]="t('intel.opponents.title')" [subtitle]="t('intel.opponents.subtitle')">
      <app-view-toggle
        pageTabs
        [options]="tabs()"
        [active]="tab()"
        (activeChange)="onTabChange($event)"
      />
    </app-page-header>

    <app-page-stack>
      @switch (tab()) {
        @case ('guilds') {
          <app-data-table
            [columns]="guildColumns()"
            [rows]="guilds()"
            [loading]="guildsLoading()"
            [error]="guildsFailed()"
            (retry)="reloadGuilds()"
            [trackBy]="trackGuild"
            [pageSize]="PAGE_LIMIT"
            [serverMode]="true"
            [totalItems]="guildsTotal()"
            emptyIcon="shield"
            [emptyLabel]="'intel.opponents.empty.guilds'"
            [rowClickable]="true"
            (rowClick)="openGuild($event)"
            (pageChange)="onGuildsPageChange($event)"
          >
            <ng-template dataTableCell="name" let-row>
              <a
                class="font-medium no-underline hover:underline"
                style="color: var(--color-text)"
                [routerLink]="['/intel/opponents/guilds', row.id]"
                (click)="$event.stopPropagation()"
              >
                {{ row.name }}
              </a>
            </ng-template>
            <ng-template dataTableCell="alliance" let-row>
              <span class="text-sm" style="color: var(--color-text-secondary)">
                {{ row.current_alliance_name ?? '—' }}
              </span>
            </ng-template>
            <ng-template dataTableCell="battles" let-row>
              <span class="mono">{{ row.battles_fought }}</span>
            </ng-template>
            <ng-template dataTableCell="our_kills" let-row>
              <span class="mono" style="color: var(--color-success)">{{ row.our_kills }}</span>
            </ng-template>
            <ng-template dataTableCell="their_kills" let-row>
              <span class="mono" style="color: var(--color-error)">{{ row.their_kills }}</span>
            </ng-template>
            <ng-template dataTableCell="last_seen_at" let-row>
              <span class="text-sm" style="color: var(--color-text-secondary)">
                {{ row.last_seen_at | date: 'short' }}
              </span>
            </ng-template>
            <ng-template dataTableCell="watchlist" let-row>
              @if (row.is_watchlisted) {
                <span class="chip chip--warning text-[11px]">{{ t('intel.opponents.watchlisted') }}</span>
              }
            </ng-template>
          </app-data-table>
        }
        @case ('players') {
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('intel.opponents.guildFilter.label') }}
              </span>
              <input
                class="input input--sm"
                type="text"
                inputmode="numeric"
                [value]="guildIdFilter()"
                [placeholder]="t('intel.opponents.guildFilter.placeholder')"
                (input)="onGuildIdFilterInput($event)"
                (keyup.enter)="applyGuildIdFilter()"
              />
            </label>
            <button type="button" class="btn btn--outline btn--sm" (click)="applyGuildIdFilter()">
              {{ t('common.filter') }}
            </button>
            @if (guildIdFilter()) {
              <button type="button" class="btn btn--ghost btn--sm" (click)="clearGuildIdFilter()">
                {{ t('common.clear') }}
              </button>
            }
          </div>

          <app-data-table
            [columns]="playerColumns()"
            [rows]="players()"
            [loading]="playersLoading()"
            [error]="playersFailed()"
            (retry)="reloadPlayers()"
            [trackBy]="trackPlayer"
            [pageSize]="PAGE_LIMIT"
            [serverMode]="true"
            [totalItems]="playersTotal()"
            emptyIcon="users"
            [emptyLabel]="'intel.opponents.empty.players'"
            [rowClickable]="true"
            (rowClick)="openPlayer($event)"
            (pageChange)="onPlayersPageChange($event)"
          >
            <ng-template dataTableCell="name" let-row>
              <a
                class="font-medium no-underline hover:underline"
                style="color: var(--color-text)"
                [routerLink]="['/intel/opponents/players', row.id]"
                (click)="$event.stopPropagation()"
              >
                {{ row.name }}
              </a>
            </ng-template>
            <ng-template dataTableCell="guild" let-row>
              @if (row.current_enemy_guild_id) {
                <a
                  class="text-sm no-underline hover:underline"
                  style="color: var(--color-text-secondary)"
                  [routerLink]="['/intel/opponents/guilds', row.current_enemy_guild_id]"
                  (click)="$event.stopPropagation()"
                >
                  {{ row.current_enemy_guild_name }}
                </a>
              } @else {
                <span class="text-sm" style="color: var(--color-text-secondary)">—</span>
              }
            </ng-template>
            <ng-template dataTableCell="role" let-row>
              @if (row.role) {
                <span class="chip chip--neutral text-[11px] capitalize">{{ roleLabel(row.role) }}</span>
              } @else {
                <span class="text-xs italic" style="color: var(--color-text-tertiary)">
                  {{ t('intel.opponents.role.unobserved') }}
                </span>
              }
            </ng-template>
            <ng-template dataTableCell="weapon" let-row>
              <span class="text-sm" style="color: var(--color-text-secondary)">
                {{ prettyWeapon(row.main_hand_item_id) }}
              </span>
            </ng-template>
            <ng-template dataTableCell="battles" let-row>
              <span class="mono">{{ row.battles_fought }}</span>
            </ng-template>
            <ng-template dataTableCell="our_kills" let-row>
              <span class="mono" style="color: var(--color-success)">{{ row.our_kills }}</span>
            </ng-template>
            <ng-template dataTableCell="their_kills" let-row>
              <span class="mono" style="color: var(--color-error)">{{ row.their_kills }}</span>
            </ng-template>
            <ng-template dataTableCell="last_seen_at" let-row>
              <span class="text-sm" style="color: var(--color-text-secondary)">
                {{ row.last_seen_at | date: 'short' }}
              </span>
            </ng-template>
          </app-data-table>
        }
      }
    </app-page-stack>
  `,
})
export class Opponents {
  private readonly enemies = inject(EnemiesService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly PAGE_LIMIT = PAGE_LIMIT;
  protected readonly tab = signal<'guilds' | 'players'>('guilds');

  protected readonly guilds = signal<EnemyGuildSummary[]>([]);
  protected readonly guildsTotal = signal(0);
  protected readonly guildsLoading = signal(false);
  protected readonly guildsFailed = signal(false);

  protected readonly players = signal<EnemyPlayerSummary[]>([]);
  protected readonly playersTotal = signal(0);
  protected readonly playersLoading = signal(false);
  protected readonly playersFailed = signal(false);
  private playersLoaded = false;

  protected readonly guildIdFilter = signal('');

  private guildsParams: DataTablePageChange = {
    page: 1,
    pageSize: PAGE_LIMIT,
    search: '',
    sort: null,
    columnFilters: {},
  };

  private playersParams: DataTablePageChange = {
    page: 1,
    pageSize: PAGE_LIMIT,
    search: '',
    sort: null,
    columnFilters: {},
  };

  protected readonly tabs = computed<ViewToggleOption[]>(() => [
    { id: 'guilds', label: this.t('intel.opponents.tab.guilds') },
    { id: 'players', label: this.t('intel.opponents.tab.players') },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly guildColumns = computed<readonly DataTableColumn<EnemyGuildSummary>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
    },
    {
      key: 'alliance',
      label: 'intel.opponents.alliance',
      accessor: (row) => row.current_alliance_name,
    },
    {
      key: 'battles',
      label: 'intel.opponents.battlesFought',
      accessor: (row) => row.battles_fought,
      align: 'right',
    },
    {
      key: 'our_kills',
      label: 'intel.opponents.ourKills',
      accessor: (row) => row.our_kills,
      align: 'right',
    },
    {
      key: 'their_kills',
      label: 'intel.opponents.theirKills',
      accessor: (row) => row.their_kills,
      align: 'right',
    },
    {
      key: 'last_seen_at',
      label: 'intel.detail.lastSeen',
      sortable: true,
      accessor: (row) => row.last_seen_at,
    },
    {
      key: 'watchlist',
      label: '',
    },
  ]);

  protected readonly playerColumns = computed<readonly DataTableColumn<EnemyPlayerSummary>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
    },
    {
      key: 'guild',
      label: 'intel.opponents.currentGuild',
      accessor: (row) => row.current_enemy_guild_name,
    },
    {
      key: 'role',
      label: 'common.role',
      accessor: (row) => row.role,
    },
    {
      key: 'weapon',
      label: 'intel.opponents.weapon',
      accessor: (row) => row.main_hand_item_id,
    },
    {
      key: 'battles',
      label: 'intel.opponents.battlesFought',
      accessor: (row) => row.battles_fought,
      align: 'right',
    },
    {
      key: 'our_kills',
      label: 'intel.opponents.ourKills',
      accessor: (row) => row.our_kills,
      align: 'right',
    },
    {
      key: 'their_kills',
      label: 'intel.opponents.theirKills',
      accessor: (row) => row.their_kills,
      align: 'right',
    },
    {
      key: 'last_seen_at',
      label: 'intel.detail.lastSeen',
      sortable: true,
      accessor: (row) => row.last_seen_at,
    },
  ]);

  protected readonly trackGuild = (row: EnemyGuildSummary): unknown => row.id;
  protected readonly trackPlayer = (row: EnemyPlayerSummary): unknown => row.id;

  constructor() {
    void this.loadGuilds();
  }

  protected onTabChange(tab: string): void {
    this.tab.set(tab === 'players' ? 'players' : 'guilds');
    if (tab === 'players' && !this.playersLoaded) {
      void this.loadPlayers();
    }
  }

  protected openGuild(row: EnemyGuildSummary): void {
    void this.router.navigate(['/intel/opponents/guilds', row.id]);
  }

  protected openPlayer(row: EnemyPlayerSummary): void {
    void this.router.navigate(['/intel/opponents/players', row.id]);
  }

  protected reloadGuilds(): void {
    void this.loadGuilds();
  }

  protected reloadPlayers(): void {
    void this.loadPlayers();
  }

  protected onGuildsPageChange(event: DataTablePageChange): void {
    this.guildsParams = event;
    void this.loadGuilds();
  }

  protected onPlayersPageChange(event: DataTablePageChange): void {
    this.playersParams = event;
    void this.loadPlayers();
  }

  protected onGuildIdFilterInput(event: Event): void {
    this.guildIdFilter.set((event.target as HTMLInputElement).value);
  }

  protected applyGuildIdFilter(): void {
    void this.loadPlayers();
  }

  protected clearGuildIdFilter(): void {
    this.guildIdFilter.set('');
    void this.loadPlayers();
  }

  protected prettyWeapon(id: string | null): string {
    if (!id) {
      return '—';
    }
    return id
      .replace(/^(MAIN|2H|OFF)_/, '')
      .split('_')
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(' ');
  }

  protected roleLabel(role: string): string {
    return role.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private async loadGuilds(): Promise<void> {
    this.guildsLoading.set(true);
    this.guildsFailed.set(false);
    try {
      const event = this.guildsParams;
      const sort: ListEnemyGuildsParams['sort'] =
        event.sort?.columnKey === 'name' ? 'name' : 'last_seen_at';
      const data = await firstValueFrom(
        this.enemies.listGuilds({
          page: event.page,
          limit: event.pageSize,
          search: event.search.trim() || undefined,
          sort,
          order: event.sort?.direction,
        }),
      );
      this.guilds.set(data.items);
      this.guildsTotal.set(data.total_items);
    } catch (error) {
      this.guildsFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildsLoading.set(false);
    }
  }

  private async loadPlayers(): Promise<void> {
    this.playersLoading.set(true);
    this.playersFailed.set(false);
    try {
      const event = this.playersParams;
      const sort: ListEnemyPlayersParams['sort'] =
        event.sort?.columnKey === 'name' ? 'name' : 'last_seen_at';
      const rawGuildId = this.guildIdFilter().trim();
      const guildId = rawGuildId === '' ? undefined : Number(rawGuildId);
      const data = await firstValueFrom(
        this.enemies.listPlayers({
          page: event.page,
          limit: event.pageSize,
          search: event.search.trim() || undefined,
          guild_id: guildId !== undefined && Number.isFinite(guildId) ? guildId : undefined,
          sort,
          order: event.sort?.direction,
        }),
      );
      this.players.set(data.items);
      this.playersTotal.set(data.total_items);
      this.playersLoaded = true;
    } catch (error) {
      this.playersFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.playersLoading.set(false);
    }
  }
}
