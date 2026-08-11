import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { BattleDetail, BattleGuildSummary } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';

interface AggregatedGuildStats {
  readonly name: string;
  readonly players: number;
  readonly kills: number;
  readonly deaths: number;
  readonly kill_fame: number;
  readonly battles: number;
}

/**
 * Aggregated view for multiple battles.
 *
 * This keeps ad-hoc battle reviews possible before a permanent event link exists,
 * while event pages can pass their linked battle ids to the same route.
 *
 * @example
 * ```text
 * /battles/group?ids=397700308,397690743
 * ```
 */
@Component({
  selector: 'app-battle-group-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else {
      <header class="card p-5">
        <button type="button" class="btn btn--ghost" (click)="backToBattles()">← {{ t('nav.battles') }}</button>
        <div class="mt-4 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 class="text-3xl font-bold" style="color: var(--color-text)">{{ t('battles.group_title') }}</h1>
            <p style="color: var(--color-text-secondary)">{{ battleDetails().length }} {{ t('battles.visible_battles') }}</p>
          </div>
          <span class="chip">{{ battleIds().join(', ') }}</span>
        </div>
      </header>

      <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <article class="surface p-4"><p class="battle-group__label">{{ t('battles.total_fame') }}</p><p class="battle-group__value">{{ formatCompact(totalFame()) }}</p></article>
        <article class="surface p-4"><p class="battle-group__label">{{ t('battles.players') }}</p><p class="battle-group__value">{{ formatAmount(totalPlayers()) }}</p></article>
        <article class="surface p-4"><p class="battle-group__label">{{ t('battles.kills') }}</p><p class="battle-group__value">{{ formatAmount(totalKills()) }}</p></article>
        <article class="surface p-4"><p class="battle-group__label">{{ t('battles.deaths') }}</p><p class="battle-group__value">{{ formatAmount(totalDeaths()) }}</p></article>
        <article class="surface p-4"><p class="battle-group__label">{{ t('battles.kill_death') }}</p><p class="battle-group__value">{{ formatRatio(totalKills(), totalDeaths()) }}</p></article>
      </section>

      <section class="mt-5 grid gap-4 xl:grid-cols-2">
        <article class="surface p-5">
          <h2 class="battle-group__panel-title">{{ t('battles.fame_chart') }}</h2>
          @for (guild of aggregatedGuilds(); track guild.name) {
            <div class="battle-group__bar-row">
              <span>{{ guild.name }}</span>
              <div class="battle-group__bar"><span [style.width.%]="percentage(guild.kill_fame, maxGuildFame())"></span></div>
              <strong>{{ formatCompact(guild.kill_fame) }}</strong>
            </div>
          }
        </article>
        <article class="surface p-5">
          <h2 class="battle-group__panel-title">{{ t('battles.kill_chart') }}</h2>
          @for (guild of aggregatedGuilds(); track guild.name) {
            <div class="battle-group__bar-row">
              <span>{{ guild.name }}</span>
              <div class="battle-group__bar battle-group__bar--kills"><span [style.width.%]="percentage(guild.kills, maxGuildKills())"></span></div>
              <strong>{{ guild.kills }}/{{ guild.deaths }}</strong>
            </div>
          }
        </article>
      </section>

      <article class="mt-5 surface overflow-hidden">
        <header class="battle-group__table-header"><h2>{{ t('battles.guild_breakdown') }}</h2></header>
        <div class="overflow-x-auto">
          <table class="table">
            <thead><tr><th>{{ t('common.name') }}</th><th>{{ t('battles.visible_battles') }}</th><th>{{ t('battles.players') }}</th><th>{{ t('battles.kills') }}</th><th>{{ t('battles.deaths') }}</th><th>{{ t('battles.fame') }}</th><th>{{ t('battles.kill_death') }}</th></tr></thead>
            <tbody>@for (guild of aggregatedGuilds(); track guild.name) { <tr><td class="font-medium">{{ guild.name }}</td><td>{{ guild.battles }}</td><td>{{ guild.players }}</td><td>{{ guild.kills }}</td><td>{{ guild.deaths }}</td><td>{{ formatCompact(guild.kill_fame) }}</td><td>{{ formatRatio(guild.kills, guild.deaths) }}</td></tr> }</tbody>
          </table>
        </div>
      </article>
    }
  `,
  styles: `
    @layer components {
      .battle-group__label { color: var(--color-text-disabled); font-size: .75rem; letter-spacing: .04em; text-transform: uppercase; }
      .battle-group__value { color: var(--color-text); font-size: clamp(1.25rem, 2vw, 1.75rem); font-weight: 700; }
      .battle-group__panel-title { color: var(--color-text); font-size: 1rem; font-weight: 700; margin-bottom: 1rem; }
      .battle-group__bar-row { align-items: center; display: grid; gap: .75rem; grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 2fr) auto; margin-top: .75rem; }
      .battle-group__bar { background: var(--color-surface-2); border-radius: var(--radius-full); height: .7rem; overflow: hidden; }
      .battle-group__bar span { background: var(--color-primary); border-radius: inherit; display: block; height: 100%; min-width: .25rem; }
      .battle-group__bar--kills span { background: var(--color-warning); }
      .battle-group__table-header { border-bottom: 1px solid var(--color-border); padding: 1rem; }
      .battle-group__table-header h2 { color: var(--color-text); font-size: 1rem; font-weight: 700; }
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
  protected readonly totalFame = computed(() => this.battleDetails().reduce((total, battle) => total + battle.total_fame, 0));
  protected readonly totalPlayers = computed(() => this.battleDetails().reduce((total, battle) => total + battle.total_players, 0));
  protected readonly totalKills = computed(() => this.battleDetails().reduce((total, battle) => total + battle.total_kills, 0));
  protected readonly totalDeaths = computed(() => this.battleDetails().reduce((total, battle) => total + this.guildDeaths(battle.guilds), 0));
  protected readonly aggregatedGuilds = computed(() => this.aggregateGuilds());
  protected readonly maxGuildFame = computed(() => Math.max(...this.aggregatedGuilds().map((guild) => guild.kill_fame), 0));
  protected readonly maxGuildKills = computed(() => Math.max(...this.aggregatedGuilds().map((guild) => guild.kills), 0));

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** Returns to the battle list without depending on browser history. */
  protected backToBattles(): void { void this.router.navigate(['/battles']); }

  /** Formats exact integer metrics with locale separators. */
  protected formatAmount(value: number): string { return value.toLocaleString(); }

  /** Makes large fame values readable in aggregate charts. */
  protected formatCompact(value: number): string { return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }

  /** Presents kill/death efficiency while protecting against division by zero. */
  protected formatRatio(kills: number, deaths: number): string { return deaths === 0 ? (kills > 0 ? '∞' : '0') : Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(kills / deaths); }

  /** Converts values into bounded percentages for CSS chart bars. */
  protected percentage(value: number, total: number): number { return total <= 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100)); }

  /** Loads every requested battle detail and keeps ordering from the query string. */
  private async load(): Promise<void> {
    const ids = (this.route.snapshot.queryParamMap.get('ids') ?? '').split(',').map((id) => Number(id.trim())).filter((id) => id > 0);
    if (ids.length === 0) {
      this.toasts.error(this.t('common.error'));
      this.backToBattles();
      return;
    }

    this.battleIds.set(ids);
    this.loading.set(true);
    try {
      const details = await Promise.all(ids.map((id) => firstValueFrom(this.api.get<BattleDetail>(`api/battles/${id}`))));
      this.battleDetails.set(details);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Folds per-battle guild rows into one aggregate guild table. */
  private aggregateGuilds(): AggregatedGuildStats[] {
    const statsByGuild = new Map<string, AggregatedGuildStats>();
    for (const battle of this.battleDetails()) {
      for (const guild of battle.guilds) {
        const name = guild.name || this.t('common.none');
        const previous = statsByGuild.get(name) ?? { name, players: 0, kills: 0, deaths: 0, kill_fame: 0, battles: 0 };
        statsByGuild.set(name, {
          name,
          players: previous.players + guild.players,
          kills: previous.kills + guild.kills,
          deaths: previous.deaths + guild.deaths,
          kill_fame: previous.kill_fame + guild.kill_fame,
          battles: previous.battles + 1,
        });
      }
    }
    return [...statsByGuild.values()].sort((leftGuild, rightGuild) => rightGuild.kill_fame - leftGuild.kill_fame);
  }

  /** Aggregates death counts exposed per guild by the backend summary. */
  private guildDeaths(guilds: readonly BattleGuildSummary[]): number { return guilds.reduce((total, guild) => total + guild.deaths, 0); }
}
