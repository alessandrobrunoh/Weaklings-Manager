import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { EnemyGuildSummary, EnemyPlayerSummary } from '../../core/models/api.models';
import { AuthService } from '../../core/services/auth.service';
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
  parseDataTableQuery,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import {
  Tabs,
  type TabOption,
} from '../../shared/components/tabs/tabs';
import { MatchupMatrix } from './matchup-matrix';
import { ScoutLibrary } from './scout-library';

/** Default page size for both the enemy guild and enemy player tables. */
const PAGE_LIMIT = 25;

/**
 * Intel opponents: who we face and what they field.
 *
 * Four views. Guilds and Players are the enemy identities pulled from battle evidence
 * (`intel.opponents.view`, officers); Scouted comps and Matchups are the scout library and our
 * record against it (`intel.view`, every member). Members therefore land on Scouted comps.
 *
 * Guild and player tables load lazily — the player table only fetches once the Players tab is
 * first opened, since most visits only need one of the two lists.
 */
@Component({
  selector: 'app-opponents',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DataTable, DataTableCell, MatchupMatrix, PageStack, RouterLink, ScoutLibrary, Tabs],
  styles: [`
    :host { display: block; color: var(--color-text); }
    :host ::ng-deep .rounded-xl, :host ::ng-deep .rounded-2xl,
    :host ::ng-deep .rounded-lg, :host ::ng-deep .rounded-md,
    :host ::ng-deep .shadow-lg, :host ::ng-deep .shadow-xl {
      border-radius: var(--radius-cards);
      box-shadow: none;
    }
  `],
  template: `
    <app-page-stack>
      <app-tabs [options]="tabs()" [active]="tab()" (activeChange)="onTabChange($event)" />
      @switch (tab()) {
        @case ('scouts') {
          <app-scout-library />
        }
        @case ('matchups') {
          <app-matchup-matrix />
        }
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
                <span class="chip chip--warning text-xs">{{ t('intel.opponents.watchlisted') }}</span>
              }
            </ng-template>
          </app-data-table>
        }
        @case ('players') {
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('intel.opponents.guildFilter.searchLabel') }}
              </span>
              <input
                class="input input--sm"
                type="search"
                [value]="guildFilterSearch()"
                [disabled]="guildFilterLoading()"
                [placeholder]="t('intel.opponents.guildFilter.placeholder')"
                (input)="onGuildFilterSearchInput($event)"
                (keyup.enter)="searchGuildFilter()"
              />
            </label>
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="guildFilterLoading()"
              (click)="searchGuildFilter()"
            >
              {{ t('common.search') }}
            </button>
            <label class="flex flex-col gap-1">
              <span class="text-xs" style="color: var(--color-text-secondary)">
                {{ t('intel.opponents.guildFilter.label') }}
              </span>
              <select
                class="select"
                [value]="guildIdFilter()"
                [disabled]="guildFilterLoading() || guildFilterFailed()"
                (change)="onGuildFilterChange($event)"
              >
                <option value="">{{ t('common.all') }}</option>
                @if (selectedGuild() && !selectedGuildOnCurrentPage()) {
                  <option [value]="selectedGuild()!.id">{{ selectedGuild()!.name }}</option>
                }
                @for (guild of guildFilterOptions(); track guild.id) {
                  <option [value]="guild.id">{{ guild.name }}</option>
                }
              </select>
            </label>
            @if (guildFilterLoading()) {
              <span role="status" class="text-sm">{{ t('common.loading') }}</span>
            } @else if (guildFilterFailed()) {
              <span role="alert" class="text-sm">{{ t('common.error') }}</span>
              <button type="button" class="btn btn--outline btn--sm" (click)="retryGuildFilterOptions()">
                {{ t('common.retry') }}
              </button>
            } @else if (guildFilterOptions().length === 0) {
              <span class="text-sm" style="color: var(--color-text-secondary)">
                {{ t('picker.noMatches') }}
              </span>
            } @else if (guildFilterTotalPages() > 1) {
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  [disabled]="guildFilterPage() <= 1"
                  (click)="changeGuildFilterPage(guildFilterPage() - 1)"
                >
                  {{ t('common.prev') }}
                </button>
                <span class="text-xs" style="color: var(--color-text-secondary)">
                  {{ t('intel.opponents.guildFilter.page', { page: guildFilterPage(), pages: guildFilterTotalPages() }) }}
                </span>
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  [disabled]="guildFilterPage() >= guildFilterTotalPages()"
                  (click)="changeGuildFilterPage(guildFilterPage() + 1)"
                >
                  {{ t('common.next') }}
                </button>
              </div>
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
                <span class="chip chip--neutral text-xs capitalize">{{ roleLabel(row.role) }}</span>
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
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly PAGE_LIMIT = PAGE_LIMIT;
  /** Guild and player dossiers are officer-only; the scout views are open to every member. */
  protected readonly canViewDossiers = computed(() => this.auth.hasPermission('intel.opponents.view'));
  protected readonly tab = signal<'guilds' | 'players' | 'scouts' | 'matchups'>(
    this.auth.hasPermission('intel.opponents.view') ? 'guilds' : 'scouts',
  );

  protected readonly guilds = signal<EnemyGuildSummary[]>([]);
  protected readonly guildsTotal = signal(0);
  protected readonly guildsLoading = signal(false);
  protected readonly guildsFailed = signal(false);

  protected readonly players = signal<EnemyPlayerSummary[]>([]);
  protected readonly playersTotal = signal(0);
  protected readonly playersLoading = signal(false);
  protected readonly playersFailed = signal(false);
  private playersLoaded = false;

  protected readonly guildFilterOptions = signal<EnemyGuildSummary[]>([]);
  protected readonly guildFilterLoading = signal(false);
  protected readonly guildFilterFailed = signal(false);
  protected readonly guildFilterSearch = signal('');
  protected readonly guildFilterPage = signal(1);
  protected readonly guildFilterTotalPages = signal(1);
  protected readonly guildIdFilter = signal('');
  protected readonly selectedGuild = signal<EnemyGuildSummary | null>(null);
  protected readonly selectedGuildOnCurrentPage = computed(() =>
    this.guildFilterOptions().some((guild) => guild.id === this.selectedGuild()?.id),
  );
  private guildFilterAppliedSearch = '';

  private guildsParams: DataTablePageChange = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: PAGE_LIMIT,
  });

  private playersParams: DataTablePageChange = parseDataTableQuery(this.route.snapshot.queryParamMap, {
    defaultPageSize: PAGE_LIMIT,
  });

  protected readonly tabs = computed<TabOption[]>(() => [
    ...(this.canViewDossiers()
      ? [
          { id: 'guilds', label: this.t('intel.opponents.tab.guilds') },
          { id: 'players', label: this.t('intel.opponents.tab.players') },
        ]
      : []),
    { id: 'scouts', label: this.t('intel.opponents.tab.scouts') },
    { id: 'matchups', label: this.t('intel.opponents.tab.matchups') },
  ]);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

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
    if (this.canViewDossiers()) {
      void this.loadGuilds();
    }
  }

  protected onTabChange(tab: string): void {
    if ((tab === 'guilds' || tab === 'players') && !this.canViewDossiers()) {
      return;
    }
    this.tab.set(
      tab === 'players' || tab === 'scouts' || tab === 'matchups' ? tab : 'guilds',
    );
    if (tab === 'players' && !this.playersLoaded) {
      void this.loadGuildFilterOptions(1);
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

  protected onGuildFilterSearchInput(event: Event): void {
    this.guildFilterSearch.set((event.target as HTMLInputElement).value);
  }

  protected searchGuildFilter(): void {
    this.guildFilterAppliedSearch = this.guildFilterSearch().trim();
    void this.loadGuildFilterOptions(1);
  }

  protected changeGuildFilterPage(page: number): void {
    if (page < 1 || page > this.guildFilterTotalPages() || page === this.guildFilterPage()) {
      return;
    }
    void this.loadGuildFilterOptions(page);
  }

  protected retryGuildFilterOptions(): void {
    void this.loadGuildFilterOptions(this.guildFilterPage());
  }

  protected onGuildFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const id = Number(value);
    const guild = this.guildFilterOptions().find((option) => option.id === id);
    const isRetainedGuild = this.selectedGuild()?.id === id;
    const filter =
      value !== '' && Number.isSafeInteger(id) && id > 0 && (guild || isRetainedGuild) ? value : '';
    if (filter === this.guildIdFilter()) {
      return;
    }
    this.guildIdFilter.set(filter);
    this.selectedGuild.set(filter ? (guild ?? this.selectedGuild()) : null);
    this.playersParams = { ...this.playersParams, page: 1 };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page: 1 },
      queryParamsHandling: 'merge',
    });
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

  private async loadGuildFilterOptions(page: number): Promise<void> {
    this.guildFilterLoading.set(true);
    this.guildFilterFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.enemies.listGuilds({
          page,
          limit: PAGE_LIMIT,
          search: this.guildFilterAppliedSearch || undefined,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.guildFilterOptions.set(data.items);
      this.guildFilterPage.set(data.current_page);
      this.guildFilterTotalPages.set(data.total_pages);
    } catch (error) {
      this.guildFilterFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.guildFilterLoading.set(false);
    }
  }

  private async loadPlayers(): Promise<void> {
    this.playersLoading.set(true);
    this.playersFailed.set(false);
    try {
      const event = this.playersParams;
      const sort: ListEnemyPlayersParams['sort'] =
        event.sort?.columnKey === 'name' ? 'name' : 'last_seen_at';
      const rawGuildId = this.guildIdFilter();
      const guildId = rawGuildId === '' ? undefined : Number(rawGuildId);
      const data = await firstValueFrom(
        this.enemies.listPlayers({
          page: event.page,
          limit: event.pageSize,
          search: event.search.trim() || undefined,
          guild_id:
            guildId !== undefined && Number.isSafeInteger(guildId) && guildId > 0
              ? guildId
              : undefined,
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
