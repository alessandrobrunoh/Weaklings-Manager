import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
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
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';

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
  imports: [DataTable, ErrorState, Loading, PageHeader, PageStack, RouterLink, SummaryBand],
  template: `
    @if (loading()) {
      <app-loading variant="detail" [label]="t('common.loading')" />
    } @else if (loadFailed()) {
      <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
    } @else {
      <app-page-header
        [title]="t('battles.group.personalTitle')"
        [subtitle]="t('battles.group.personalSubtitle', { count: battleDetails().length })"
        [backLink]="['/battles']"
        [backLabel]="t('nav.battles')"
      />

      <app-page-stack>
        <p class="hint max-w-3xl">{{ t('battles.group.personalDescription') }}</p>

        <div class="flex flex-wrap gap-1.5">
          @for (id of battleIds(); track id) {
            <a class="chip font-mono text-xs no-underline" [routerLink]="['/battles', id]">#{{ id }}</a>
          }
        </div>

        <app-summary-band [ariaLabel]="t('battleDetail.group.summaryLabel')" [items]="summaryItems()" />

        <section class="grid gap-4 xl:grid-cols-2">
          <article class="card">
            <h2 class="section-title">{{ t('battles.fame_chart') }}</h2>
            @for (guild of aggregatedGuilds().slice(0, 8); track guild.name) {
              <div class="bg__bar-row">
                <span class="truncate" [class.font-bold]="guild.isOurGuild">
                  {{ guild.name }}
                  @if (guild.alliance_name) {
                    <small class="text-secondary mono">[{{ guild.alliance_name }}]</small>
                  }
                </span>
                <div class="bg__bar" [class.bg__bar--our]="guild.isOurGuild">
                  <span [style.width.%]="percentage(guild.kill_fame, maxGuildFame())"></span>
                </div>
                <strong class="mono">{{ formatCompact(guild.kill_fame) }}</strong>
              </div>
            }
          </article>

          <article class="card">
            <h2 class="section-title">{{ t('battles.kill_chart') }}</h2>
            @for (guild of aggregatedGuilds().slice(0, 8); track guild.name) {
              <div class="bg__bar-row">
                <span class="truncate" [class.font-bold]="guild.isOurGuild">{{ guild.name }}</span>
                <div class="bg__bar bg__bar--kills">
                  <span [style.width.%]="percentage(guild.kills, maxGuildKills())"></span>
                </div>
                <strong class="mono">{{ guild.kills }} / {{ guild.deaths }} ({{ t('battles.kill_death') }} {{ formatDecimal(guild.kdRatio) }})</strong>
              </div>
            }
          </article>
        </section>

        <section class="card p-0">
          <div class="bg__head">
            <h2 class="section-title">{{ t('battles.guild_breakdown') }}</h2>
          </div>
          <app-data-table
            [syncUrl]="false"
            [columns]="guildColumns"
            [rows]="aggregatedGuilds()"
            [trackBy]="trackGuild"
            [pageSize]="12"
            [stickyFirstColumn]="true"
            [ariaLabel]="t('battles.guild_breakdown')"
          >
            <ng-template dataTableCell="name" let-row>
              <span class="bg__cell">
                <span class="font-medium" [class.text-primary]="row.isOurGuild">{{ row.name }}</span>
                @if (row.alliance_name) {
                  <span class="chip text-xs py-0 px-1 font-mono">[{{ row.alliance_name }}]</span>
                }
                @if (row.isOurGuild) {
                  <span class="chip chip--success text-xs py-0">{{ t('battleDetail.ourGuild') }}</span>
                }
              </span>
            </ng-template>

            <ng-template dataTableCell="kill_fame" let-row>
              <span class="mono">{{ formatCompact(row.kill_fame) }}</span>
            </ng-template>

            <ng-template dataTableCell="kill_death" let-row>
              <span class="mono" [class.text-success]="row.kdRatio >= 1">{{ formatDecimal(row.kdRatio) }}</span>
            </ng-template>
          </app-data-table>
        </section>
      </app-page-stack>
    }
  `,
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
    @layer components {
      .bg__head {
        padding: var(--card-padding) var(--card-padding) 0;
      }
      .bg__head .section-title {
        margin-bottom: 0;
      }
      .bg__cell {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }
      .bg__bar-row {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(8rem, 1.3fr) minmax(6rem, 2fr) auto;
        margin-top: 0.75rem;
      }
      @media (max-width: 640px) {
        .bg__bar-row {
          gap: 0.35rem 0.6rem;
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .bg__bar-row > span {
          grid-column: 1;
        }
        .bg__bar-row > .bg__bar {
          grid-column: 1 / -1;
          grid-row: 2;
        }
        .bg__bar-row > strong {
          grid-column: 2;
          grid-row: 1;
          font-size: var(--ui-text-xs);
        }
      }
      .bg__bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.65rem;
        overflow: hidden;
      }
      .bg__bar span {
        background: var(--color-primary);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
      }
      .bg__bar--our span {
        background: var(--color-success);
      }
      .bg__bar--kills span {
        background: var(--color-warning);
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

  /** Group headline numbers as one summary band. */
  protected readonly summaryItems = computed<SummaryItem[]>(() => [
    { label: this.t('battles.total_fame'), value: this.formatCompact(this.totalFame()) },
    { label: this.t('battles.players'), value: this.formatAmount(this.totalPlayers()) },
    { label: this.t('battles.kills'), value: this.formatAmount(this.totalKills()) },
    { label: this.t('battles.deaths'), value: this.formatAmount(this.totalDeaths()) },
    { label: this.t('battles.kill_death'), value: this.formatDecimal(this.groupKdRatio()) },
  ]);

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

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected backToBattles(): void {
    void this.router.navigate(['/battles']);
  }

  protected formatAmount(value: number): string {
    return value.toLocaleString(this.translate.locale());
  }

  protected formatCompact(value: number): string {
    return Intl.NumberFormat(this.translate.locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(this.translate.locale(), { maximumFractionDigits: 1 }).format(value);
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
        // Keyed case-insensitively so the same guild reported with
        // inconsistent casing across battles isn't split into two rows.
        const key = name.toLowerCase();
        const previous = statsByGuild.get(key) ?? {
          name,
          alliance_name: guild.alliance_name ?? null,
          isOurGuild: false,
          players: 0,
          kills: 0,
          deaths: 0,
          kill_fame: 0,
          battles: 0,
        };
        statsByGuild.set(key, {
          ...previous,
          // The backend flags the tenant's own guild; names are never compared.
          isOurGuild: previous.isOurGuild || guild.is_own === true,
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
