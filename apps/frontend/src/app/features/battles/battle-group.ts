import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { BattleDetail, BattleGuildSummary } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface AggregatedGuildStats {
  readonly name: string;
  readonly alliance_name: string | null;
  readonly isOurGuild: boolean;
  readonly players: number;
  readonly kills: number;
  readonly deaths: number;
  readonly kill_fame: number;
  readonly battles: number;
  readonly kdRatio: number;
}

/**
 * Aggregated view for multiple battles.
 *
 * This allows tactical review of campaigns, multiple skirmishes, or CTA sessions
 * with full guild and alliance summaries.
 */
@Component({
  selector: 'app-battle-group-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading, ErrorState, DataTable, PageHeader, PageStack],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else {
      <app-page-header
        [title]="t('battles.group_title')"
        [subtitle]="'Aggregated analytics across ' + battleDetails().length + ' ' + t('battles.visible_battles')"
      >
        <button type="button" class="btn btn--ghost btn--sm" (click)="backToBattles()">
          ← {{ t('nav.battles') }}
        </button>
      </app-page-header>

      <div class="mb-5 flex flex-wrap gap-1">
        @for (id of battleIds(); track id) {
          <span class="chip font-mono text-xs">#{{ id }}</span>
        }
      </div>

      <app-page-stack>
      <!-- Aggregate KPIs -->
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Group KPIs">
        <article class="surface p-4">
          <p class="battle-group__label">{{ t('battles.total_fame') }}</p>
          <p class="battle-group__value mono text-warning">{{ formatCompact(totalFame()) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-group__label">{{ t('battles.players') }}</p>
          <p class="battle-group__value mono">{{ formatAmount(totalPlayers()) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-group__label">{{ t('battles.kills') }}</p>
          <p class="battle-group__value mono text-success">{{ formatAmount(totalKills()) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-group__label">{{ t('battles.deaths') }}</p>
          <p class="battle-group__value mono text-error">{{ formatAmount(totalDeaths()) }}</p>
        </article>
        <article class="surface p-4">
          <p class="battle-group__label">{{ t('battles.kill_death') }}</p>
          <p class="battle-group__value mono" [class.text-success]="groupKdRatio() >= 1">
            {{ formatDecimal(groupKdRatio()) }}
          </p>
        </article>
      </section>

      <!-- Comparative Bar Charts -->
      <section class="grid gap-4 xl:grid-cols-2">
        <article class="surface p-5">
          <h2 class="battle-group__panel-title">{{ t('battles.fame_chart') }}</h2>
          @for (guild of aggregatedGuilds().slice(0, 8); track guild.name) {
            <div class="battle-group__bar-row">
              <span class="truncate" [class.font-bold]="guild.isOurGuild">
                {{ guild.name }}
                @if (guild.alliance_name) {
                  <small class="text-disabled mono">[{{ guild.alliance_name }}]</small>
                }
              </span>
              <div class="battle-group__bar" [class.battle-group__bar--our]="guild.isOurGuild">
                <span [style.width.%]="percentage(guild.kill_fame, maxGuildFame())"></span>
              </div>
              <strong class="mono text-warning">{{ formatCompact(guild.kill_fame) }}</strong>
            </div>
          }
        </article>

        <article class="surface p-5">
          <h2 class="battle-group__panel-title">{{ t('battles.kill_chart') }}</h2>
          @for (guild of aggregatedGuilds().slice(0, 8); track guild.name) {
            <div class="battle-group__bar-row">
              <span class="truncate" [class.font-bold]="guild.isOurGuild">
                {{ guild.name }}
              </span>
              <div class="battle-group__bar battle-group__bar--kills">
                <span [style.width.%]="percentage(guild.kills, maxGuildKills())"></span>
              </div>
              <strong class="mono">{{ guild.kills }}/{{ guild.deaths }} (K/D {{ formatDecimal(guild.kdRatio) }})</strong>
            </div>
          }
        </article>
      </section>

      <!-- Guild Breakdown Table -->
      <article class="surface overflow-hidden">
        <header class="battle-group__table-header">
          <h2 class="font-bold text-base" style="color: var(--color-text)">{{ t('battles.guild_breakdown') }}</h2>
        </header>
        <app-data-table
          [columns]="guildColumns"
          [rows]="aggregatedGuilds()"
          [trackBy]="trackGuild"
          [pageSize]="12"
        >
          <ng-template dataTableCell="name" let-row>
            <div class="flex items-center gap-2">
              <span class="font-medium" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
              @if (row.alliance_name) {
                <span class="chip text-xs py-0 px-1 font-mono">[{{ row.alliance_name }}]</span>
              }
              @if (row.isOurGuild) {
                <span class="chip chip--success text-xs py-0">Our Guild</span>
              }
            </div>
          </ng-template>

          <ng-template dataTableCell="battles" let-row>
            <span class="mono">{{ row.battles }}</span>
          </ng-template>

          <ng-template dataTableCell="players" let-row>
            <span class="mono">{{ row.players }}</span>
          </ng-template>

          <ng-template dataTableCell="kills" let-row>
            <span class="mono font-bold text-success">{{ row.kills }}</span>
          </ng-template>

          <ng-template dataTableCell="deaths" let-row>
            <span class="mono font-bold text-error">{{ row.deaths }}</span>
          </ng-template>

          <ng-template dataTableCell="kill_fame" let-row>
            <span class="mono text-warning font-medium">{{ formatCompact(row.kill_fame) }}</span>
          </ng-template>

          <ng-template dataTableCell="kill_death" let-row>
            <span class="mono" [class.text-success]="row.kdRatio >= 1">
              {{ formatDecimal(row.kdRatio) }}
            </span>
          </ng-template>
        </app-data-table>
      </article>
      </app-page-stack>
    }
  `,
  styles: `
    @layer components {
      .battle-group__label {
        color: var(--color-text-disabled);
        font-size: 0.72rem;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        font-weight: 600;
      }
      .battle-group__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.65rem);
        font-weight: 700;
      }
      .battle-group__panel-title {
        color: var(--color-text);
        font-size: 0.95rem;
        font-weight: 700;
        margin-bottom: 1rem;
      }
      .battle-group__bar-row {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(8rem, 1.3fr) minmax(6rem, 2fr) auto;
        margin-top: 0.75rem;
      }
      .battle-group__bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.65rem;
        overflow: hidden;
      }
      .battle-group__bar span {
        background: var(--color-primary);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
      }
      .battle-group__bar--our span {
        background: var(--color-success);
      }
      .battle-group__bar--kills span {
        background: var(--color-warning);
      }
      .battle-group__table-header {
        border-bottom: 1px solid var(--color-border);
        padding: 1rem;
      }
    }
  `,
})
export class BattleGroupPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly battleIds = signal<number[]>([]);
  protected readonly battleDetails = signal<BattleDetail[]>([]);
  protected readonly loading = signal(false);
  protected readonly loadFailed = signal(false);

  protected readonly totalFame = computed(() =>
    this.battleDetails().reduce((total, battle) => total + battle.total_fame, 0),
  );
  protected readonly totalPlayers = computed(() =>
    this.battleDetails().reduce((total, battle) => total + battle.total_players, 0),
  );
  protected readonly totalKills = computed(() =>
    this.battleDetails().reduce((total, battle) => total + battle.total_kills, 0),
  );
  protected readonly totalDeaths = computed(() =>
    this.battleDetails().reduce((total, battle) => total + this.guildDeaths(battle.guilds), 0),
  );
  protected readonly groupKdRatio = computed(() => {
    const kills = this.totalKills();
    const deaths = this.totalDeaths();
    return deaths === 0 ? (kills > 0 ? kills : 0) : kills / deaths;
  });

  protected readonly aggregatedGuilds = computed(() => this.aggregateGuilds());
  protected readonly maxGuildFame = computed(() =>
    Math.max(...this.aggregatedGuilds().map((guild) => guild.kill_fame), 1),
  );
  protected readonly maxGuildKills = computed(() =>
    Math.max(...this.aggregatedGuilds().map((guild) => guild.kills), 1),
  );
  protected readonly trackGuild = (guild: AggregatedGuildStats): unknown => guild.name;

  /** Columns for guild aggregates table */
  protected readonly guildColumns: readonly DataTableColumn<AggregatedGuildStats>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (guild) => `${guild.name} ${guild.alliance_name ?? ''}`,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'battles',
      label: 'battles.visible_battles',
      sortable: true,
      accessor: (guild) => guild.battles,
      comparator: (a, b) => a.battles - b.battles,
      align: 'right',
    },
    {
      key: 'players',
      label: 'battles.players',
      sortable: true,
      accessor: (guild) => guild.players,
      comparator: (a, b) => a.players - b.players,
      align: 'right',
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (guild) => guild.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (guild) => guild.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_death',
      label: 'battles.kill_death',
      sortable: true,
      accessor: (guild) => guild.kdRatio,
      comparator: (a, b) => a.kdRatio - b.kdRatio,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.total_fame',
      sortable: true,
      accessor: (guild) => guild.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
  ];

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected backToBattles(): void {
    void this.router.navigate(['/battles']);
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString();
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  }

  protected percentage(value: number, total: number): number {
    return total <= 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100));
  }

  protected async load(): Promise<void> {
    const ids = (this.route.snapshot.queryParamMap.get('ids') ?? '')
      .split(',')
      .map((id) => Number(id.trim()))
      .filter((id) => id > 0);
    if (ids.length === 0) {
      this.toasts.error(this.t('common.error'));
      this.backToBattles();
      return;
    }

    this.battleIds.set(ids);
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const details = await Promise.all(
        ids.map((id) => firstValueFrom(this.api.get<BattleDetail>(`api/battles/${id}`))),
      );
      this.battleDetails.set(details);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private aggregateGuilds(): AggregatedGuildStats[] {
    const statsByGuild = new Map<string, {
      name: string;
      alliance_name: string | null;
      isOurGuild: boolean;
      players: number;
      kills: number;
      deaths: number;
      kill_fame: number;
      battles: number;
    }>();

    for (const battle of this.battleDetails()) {
      for (const guild of battle.guilds) {
        const name = guild.name || this.t('common.none');
        const previous = statsByGuild.get(name) ?? {
          name,
          alliance_name: guild.alliance_name ?? null,
          isOurGuild: name.toLowerCase() === 'weaklings',
          players: 0,
          kills: 0,
          deaths: 0,
          kill_fame: 0,
          battles: 0,
        };
        statsByGuild.set(name, {
          ...previous,
          alliance_name: previous.alliance_name || (guild.alliance_name ?? null),
          players: previous.players + guild.players,
          kills: previous.kills + guild.kills,
          deaths: previous.deaths + guild.deaths,
          kill_fame: previous.kill_fame + guild.kill_fame,
          battles: previous.battles + 1,
        });
      }
    }

    return Array.from(statsByGuild.values()).map((g) => ({
      ...g,
      kdRatio: g.deaths === 0 ? (g.kills > 0 ? g.kills : 0) : g.kills / g.deaths,
    })).sort((a, b) => b.kill_fame - a.kill_fame);
  }

  private guildDeaths(guilds: readonly BattleGuildSummary[]): number {
    return guilds.reduce((total, guild) => total + guild.deaths, 0);
  }
}
