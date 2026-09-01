import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { FightDetail } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

interface FightStat {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'success' | 'error' | 'warning';
}

/** Read-only detail view for a canonical fight and its roster-to-snapshot evidence. */
@Component({
  selector: 'app-fight-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, ErrorState, Loading, PageHeader, PageStack],
  template: `
    @if (loading()) {
      <app-loading label="Loading fight…" />
    } @else if (loadFailed() || !fight()) {
      <app-error-state message="Unable to load this fight." retryLabel="Try again" (retry)="load()" />
    } @else if (fight(); as detail) {
      <a class="btn btn--ghost btn--sm mb-4 inline-flex no-underline" routerLink="/battles">← Battles</a>

      <app-page-header
        [title]="'Fight #' + detail.id"
        [subtitle]="fightWindow(detail)"
        [badge]="detail.needs_review ? 'Needs review' : detail.grouping_method"
      />

      <app-page-stack>
        <section class="surface p-5" aria-labelledby="fight-metadata-title">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="fight-metadata-title" class="fight-detail__section-title">Fight metadata</h2>
              <p class="fight-detail__hint">How the battle segments were grouped.</p>
            </div>
            @if (detail.needs_review) {
              <span class="chip chip--warning">Needs review</span>
            }
          </div>

          <dl class="fight-detail__metadata-grid">
            <div><dt>Started</dt><dd>{{ formatDate(detail.started_at) }}</dd></div>
            <div><dt>Ended</dt><dd>{{ detail.ended_at ? formatDate(detail.ended_at) : 'In progress or unknown' }}</dd></div>
            <div><dt>Grouping</dt><dd class="capitalize">{{ detail.grouping_method }}</dd></div>
            <div><dt>Confidence</dt><dd>{{ formatPercent(detail.grouping_confidence) }}</dd></div>
          </dl>
        </section>

        @if (stats().length > 0) {
          <section aria-labelledby="fight-stats-title">
            <div class="mb-3 flex items-baseline justify-between gap-3">
              <h2 id="fight-stats-title" class="fight-detail__section-title">Fight statistics</h2>
              <span class="text-xs text-secondary">Aggregated across persisted segments</span>
            </div>
            <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              @for (stat of stats(); track stat.label) {
                <article class="surface p-4">
                  <p class="fight-detail__label">{{ stat.label }}</p>
                  <p class="fight-detail__stat-value mono" [class.text-success]="stat.tone === 'success'" [class.text-error]="stat.tone === 'error'" [class.text-warning]="stat.tone === 'warning'">{{ stat.value }}</p>
                </article>
              }
            </div>
          </section>
        }

        @if (hasRosterEvidence()) {
          <section class="surface p-5 fight-detail__deferred" aria-labelledby="roster-evidence-title">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="roster-evidence-title" class="fight-detail__section-title">Roster evidence</h2>
                <p class="fight-detail__hint">Planned event members compared with players found in friendly snapshots.</p>
              </div>
              @if (detail.planned_comp; as comp) {
                <span class="chip chip--info">Planned comp: {{ comp.name || ('#' + comp.id) }}</span>
              }
            </div>

            @if (detail.participant_coverage; as coverage) {
              <dl class="fight-detail__coverage-grid" aria-label="Roster observation coverage">
                <div><dt>Observed planned</dt><dd>{{ coverage.observed_planned_participants }} / {{ coverage.matchable_planned_participants }}</dd></div>
                <div><dt>Not matchable</dt><dd>{{ coverage.unmatched_planned_participants }}</dd></div>
                <div><dt>Unplanned observed</dt><dd>{{ coverage.unplanned_observed_players }}</dd></div>
                <div><dt>Snapshot coverage</dt><dd>{{ coverage.persisted_segments }} / {{ coverage.total_segments }} segments</dd></div>
              </dl>
            }

            @if (detail.planned_participants?.length) {
              <div class="fight-detail__table-wrap mt-5">
                <table class="fight-detail__table">
                  <caption>Planned participants and observation status</caption>
                  <thead><tr><th scope="col">Member</th><th scope="col">Primary build</th><th scope="col">Secondary build</th><th scope="col">Snapshot status</th></tr></thead>
                  <tbody>
                    @for (participant of detail.planned_participants; track participant.user_id) {
                      <tr>
                        <th scope="row">{{ participant.username }}</th>
                        <td>{{ participant.primary_build_name || ('Build #' + participant.primary_build_id) }}</td>
                        <td>{{ participant.secondary_build_name || (participant.secondary_build_id ? ('Build #' + participant.secondary_build_id) : 'None') }}</td>
                        <td><span class="chip" [class.chip--success]="participant.observed" [class.chip--warning]="!participant.observed">{{ participant.observed ? 'Observed' : (participant.albion_player_id ? 'Not observed' : 'No linked character') }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        }

        @if (detail.observed_friendly_players?.length) {
          <section class="surface p-5 fight-detail__deferred" aria-labelledby="observed-players-title">
            <div class="mb-4">
              <h2 id="observed-players-title" class="fight-detail__section-title">Observed friendly players</h2>
              <p class="fight-detail__hint">Players directly recorded in configured friendly guild snapshots.</p>
            </div>
            <div class="fight-detail__table-wrap">
              <table class="fight-detail__table">
                <caption>Friendly player performance across persisted segments</caption>
                <thead><tr><th scope="col">Player</th><th scope="col">Guild</th><th scope="col" class="numeric">Segments</th><th scope="col" class="numeric">K / D</th><th scope="col" class="numeric">Kill fame</th><th scope="col" class="numeric">Avg. IP</th></tr></thead>
                <tbody>
                  @for (player of detail.observed_friendly_players; track player.albion_player_id) {
                    <tr>
                      <th scope="row">{{ player.name }}</th><td>{{ player.guild_name }}</td><td class="numeric">{{ player.segments_observed }}</td><td class="numeric">{{ player.kills }} / {{ player.deaths }}</td><td class="numeric">{{ formatAmount(player.kill_fame) }}</td><td class="numeric">{{ formatDecimal(player.average_item_power) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }

        @if (hasAggregates()) {
          <section class="fight-detail__deferred" aria-labelledby="aggregate-title">
            <div class="mb-3">
              <h2 id="aggregate-title" class="fight-detail__section-title">Aggregated combat data</h2>
              <p class="fight-detail__hint">Rollups from all persisted segments in this fight.</p>
            </div>
            <div class="grid gap-4 xl:grid-cols-2">
              @if (detail.guilds?.length) { <ng-container [ngTemplateOutlet]="guildTable" [ngTemplateOutletContext]="{ $implicit: detail.guilds }" /> }
              @if (detail.players?.length) { <ng-container [ngTemplateOutlet]="playerTable" [ngTemplateOutletContext]="{ $implicit: detail.players }" /> }
              @if (detail.estimated_losses?.guilds?.length) { <ng-container [ngTemplateOutlet]="guildLossTable" [ngTemplateOutletContext]="{ $implicit: detail.estimated_losses.guilds }" /> }
              @if (detail.estimated_losses?.players?.length) { <ng-container [ngTemplateOutlet]="playerLossTable" [ngTemplateOutletContext]="{ $implicit: detail.estimated_losses.players }" /> }
            </div>
          </section>
        }

        <section class="surface overflow-hidden fight-detail__deferred" aria-labelledby="fight-segments-title">
          <header class="fight-detail__segments-header"><div><h2 id="fight-segments-title" class="fight-detail__section-title">Battle segments</h2><p class="fight-detail__hint">Open a segment for its individual battle report.</p></div><span class="chip mono">{{ detail.battle_ids.length }}</span></header>
          @if (detail.battle_ids.length) {
            <ol class="fight-detail__segment-list">
              @for (battleId of detail.battle_ids; track battleId; let index = $index) {
                <li><a class="fight-detail__segment-link" [routerLink]="['/battles', battleId]"><span class="fight-detail__segment-number" aria-hidden="true">{{ index + 1 }}</span><span><span class="fight-detail__segment-label">Battle segment</span><span class="mono">#{{ battleId }}</span></span><span class="fight-detail__open">Open <span aria-hidden="true">→</span></span></a></li>
              }
            </ol>
          } @else { <p class="p-5 text-sm text-secondary">No battle segments have been attached to this fight.</p> }
        </section>
      </app-page-stack>

      <ng-template #guildTable let-guilds><article class="surface p-4"><h3 class="fight-detail__table-title">Guilds</h3><div class="fight-detail__table-wrap"><table class="fight-detail__table"><caption>Guild performance</caption><thead><tr><th scope="col">Guild</th><th scope="col" class="numeric">Players</th><th scope="col" class="numeric">K / D</th><th scope="col" class="numeric">Kill fame</th></tr></thead><tbody>@for (guild of guilds; track guild.id) { <tr><th scope="row">{{ guild.name }}</th><td class="numeric">{{ guild.players }}</td><td class="numeric">{{ guild.kills }} / {{ guild.deaths }}</td><td class="numeric">{{ formatAmount(guild.kill_fame) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #playerTable let-players><article class="surface p-4"><h3 class="fight-detail__table-title">Players</h3><div class="fight-detail__table-wrap"><table class="fight-detail__table"><caption>Player performance</caption><thead><tr><th scope="col">Player</th><th scope="col">Guild</th><th scope="col" class="numeric">K / D</th><th scope="col" class="numeric">Kill fame</th></tr></thead><tbody>@for (player of players; track player.id) { <tr><th scope="row">{{ player.name }}</th><td>{{ player.guild_name }}</td><td class="numeric">{{ player.kills }} / {{ player.deaths }}</td><td class="numeric">{{ formatAmount(player.kill_fame) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #guildLossTable let-losses><article class="surface p-4"><h3 class="fight-detail__table-title">Guild losses</h3><div class="fight-detail__table-wrap"><table class="fight-detail__table"><caption>Estimated losses by guild</caption><thead><tr><th scope="col">Guild</th><th scope="col" class="numeric">Deaths</th><th scope="col" class="numeric">Estimated loss</th></tr></thead><tbody>@for (loss of losses; track loss.guild_name) { <tr><th scope="row">{{ loss.guild_name }}</th><td class="numeric">{{ loss.deaths }}</td><td class="numeric">{{ formatAmount(loss.estimated_loss) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #playerLossTable let-losses><article class="surface p-4"><h3 class="fight-detail__table-title">Player losses</h3><div class="fight-detail__table-wrap"><table class="fight-detail__table"><caption>Estimated losses by player</caption><thead><tr><th scope="col">Player</th><th scope="col">Guild</th><th scope="col" class="numeric">Deaths</th><th scope="col" class="numeric">Estimated loss</th></tr></thead><tbody>@for (loss of losses; track loss.player_name) { <tr><th scope="row">{{ loss.player_name }}</th><td>{{ loss.guild_name || 'Unknown' }}</td><td class="numeric">{{ loss.deaths }}</td><td class="numeric">{{ formatAmount(loss.estimated_loss) }}</td></tr> }</tbody></table></div></article></ng-template>
    }
  `,
  styles: `
    @layer components {
      .fight-detail__section-title, .fight-detail__table-title { color: var(--color-text); font-size: .95rem; font-weight: 600; letter-spacing: -.01em; }
      .fight-detail__table-title { margin-bottom: .75rem; }
      .fight-detail__hint { color: var(--color-text-secondary); font-size: .75rem; margin-top: .25rem; }
      .fight-detail__metadata-grid, .fight-detail__coverage-grid { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); margin-top: 1.25rem; }
      .fight-detail__metadata-grid dt, .fight-detail__coverage-grid dt, .fight-detail__label, .fight-detail__segment-label { color: var(--color-text-disabled); font-size: .7rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
      .fight-detail__metadata-grid dd, .fight-detail__coverage-grid dd { color: var(--color-text); font-family: var(--font-mono); font-size: .875rem; margin-top: .25rem; }
      .fight-detail__stat-value { color: var(--color-text); font-size: 1.4rem; font-weight: 600; margin-top: .35rem; }
      .fight-detail__deferred { content-visibility: auto; contain-intrinsic-size: auto none auto 32rem; }
      .fight-detail__table-wrap { overflow-x: auto; }
      .fight-detail__table { border-collapse: collapse; min-width: 34rem; width: 100%; }
      .fight-detail__table caption { caption-side: bottom; color: var(--color-text-secondary); font-size: .7rem; padding-top: .65rem; text-align: left; }
      .fight-detail__table th, .fight-detail__table td { border-top: 1px solid var(--color-border); padding: .625rem .5rem; text-align: left; vertical-align: middle; }
      .fight-detail__table thead th { border-top: 0; color: var(--color-text-secondary); font-size: .7rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
      .fight-detail__table tbody th { color: var(--color-text); font-size: .8125rem; font-weight: 500; }
      .fight-detail__table td { color: var(--color-text-secondary); font-size: .8125rem; }
      .fight-detail__table .numeric { font-family: var(--font-mono); text-align: right; }
      .fight-detail__segments-header { align-items: center; border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; padding: 1rem 1.25rem; }
      .fight-detail__segment-list { list-style: none; margin: 0; padding: 0; }
      .fight-detail__segment-list > li + li { border-top: 1px solid var(--color-border); }
      .fight-detail__segment-link { align-items: center; color: var(--color-text); display: grid; gap: .75rem; grid-template-columns: auto 1fr auto; padding: .875rem 1.25rem; text-decoration: none; }
      .fight-detail__segment-link:hover { background: var(--color-surface-hover); }
      .fight-detail__segment-link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
      .fight-detail__segment-number { align-items: center; background: var(--color-surface-2); border-radius: var(--radius-sm); color: var(--color-text-secondary); display: inline-flex; font-family: var(--font-mono); font-size: .75rem; height: 1.5rem; justify-content: center; width: 1.5rem; }
      .fight-detail__segment-label { display: block; margin-bottom: .15rem; }
      .fight-detail__open { color: var(--color-text-secondary); font-size: .75rem; }
    }
  `,
})
export class FightDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  protected readonly fight = signal<FightDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly hasRosterEvidence = computed(() => {
    const fight = this.fight();
    return Boolean(fight?.planned_comp || fight?.planned_participants?.length || fight?.observed_friendly_players?.length || fight?.participant_coverage?.event_linked);
  });
  protected readonly hasAggregates = computed(() => {
    const fight = this.fight();
    return Boolean(fight?.guilds?.length || fight?.players?.length || fight?.estimated_losses?.guilds?.length || fight?.estimated_losses?.players?.length);
  });
  protected readonly stats = computed<FightStat[]>(() => {
    const fight = this.fight();
    if (!fight) return [];
    const aggregate = fight.stats;
    const value = (...candidates: Array<number | undefined>): number | undefined => candidates.find(Number.isFinite);
    const number = (label: string, ...candidates: Array<number | undefined>): FightStat | null => {
      const result = value(...candidates);
      return result === undefined ? null : { label, value: this.formatAmount(result) };
    };
    return [
      number('Players', fight.total_players, fight.unique_players, aggregate?.total_players, aggregate?.players),
      number('Kills', fight.total_kills, aggregate?.total_kills, aggregate?.kills),
      number('Deaths', fight.total_deaths, aggregate?.total_deaths, aggregate?.deaths),
      number('Kill fame', fight.total_kill_fame, fight.total_fame, aggregate?.total_kill_fame, aggregate?.total_fame, aggregate?.kill_fame),
      this.ratioStat('K/D ratio', value(fight.kill_death_ratio, aggregate?.kill_death_ratio)),
      this.percentStat('Win rate', value(fight.win_rate, aggregate?.win_rate)),
    ].filter((stat): stat is FightStat => stat !== null);
  });

  constructor() { void this.load(); }

  protected async load(): Promise<void> {
    const fightId = Number(this.route.snapshot.paramMap.get('fightId'));
    if (!Number.isSafeInteger(fightId) || fightId <= 0) { this.loadFailed.set(true); this.loading.set(false); return; }
    this.loading.set(true); this.loadFailed.set(false);
    try { this.fight.set(await firstValueFrom(this.api.get<FightDetail>(`api/fights/${fightId}`))); }
    catch { this.fight.set(null); this.loadFailed.set(true); }
    finally { this.loading.set(false); }
  }

  protected fightWindow(fight: FightDetail): string { return `${this.formatDate(fight.started_at)}${fight.ended_at ? ` to ${this.formatDate(fight.ended_at)}` : ''}`; }
  protected formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
  protected formatAmount(value: number): string { return Intl.NumberFormat().format(value); }
  protected formatDecimal(value: number): string { return value.toFixed(0); }
  protected formatPercent(value: number): string { return `${(value <= 1 ? value * 100 : value).toFixed(0)}%`; }
  private ratioStat(label: string, value: number | undefined): FightStat | null { return value === undefined ? null : { label, value: value.toFixed(2), tone: value >= 1 ? 'success' : 'error' }; }
  private percentStat(label: string, value: number | undefined): FightStat | null { return value === undefined ? null : { label, value: this.formatPercent(value), tone: 'success' }; }
}
