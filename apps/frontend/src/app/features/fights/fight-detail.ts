import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { FightDetail, FightMutationResult, MergeFightsRequest, MoveBattleRequest, SplitFightRequest } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Dialog } from '../../shared/components/dialog/dialog';

interface FightStat {
  readonly label: string;
  readonly value: string;
  readonly tone?: 'success' | 'error' | 'warning';
}

type PendingFightMutation =
  | { readonly kind: 'merge'; readonly body: MergeFightsRequest; readonly description: string }
  | { readonly kind: 'split'; readonly body: SplitFightRequest; readonly description: string }
  | { readonly kind: 'move'; readonly battleId: number; readonly body: MoveBattleRequest; readonly description: string };

/** Read-only detail view for a canonical fight and its roster-to-snapshot evidence. */
@Component({
  selector: 'app-fight-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, ErrorState, Loading, PageHeader, PageStack, Dialog],
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
        @if (canManageFights()) {
          <section class="surface p-5 fight-detail__management" aria-labelledby="fight-management-title">
            <div>
              <h2 id="fight-management-title" class="fight-detail__section-title">Officer controls</h2>
              <p class="fight-detail__hint">Manual grouping is permanent. Fights must belong to the same event, or neither can be event-linked.</p>
            </div>
            @if (mutationError(); as error) { <p class="fight-detail__mutation-error" role="alert">{{ error }}</p> }
            @if (mutationSuccess(); as message) { <p class="fight-detail__mutation-success" aria-live="polite">{{ message }}</p> }
            <div class="fight-detail__management-actions">
              <button type="button" class="btn btn--outline btn--sm" [disabled]="mutating()" (click)="openMerge()">Merge fights</button>
              <button type="button" class="btn btn--outline btn--sm" [disabled]="mutating() || detail.battle_ids.length < 2" (click)="openSplit()">Split segments</button>
            </div>
          </section>
        }

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
                <table class="table">
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
              <table class="table">
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
              @if (detail.estimated_losses; as losses) {
                @if (losses.guilds.length) { <ng-container [ngTemplateOutlet]="guildLossTable" [ngTemplateOutletContext]="{ $implicit: losses.guilds }" /> }
                @if (losses.players.length) { <ng-container [ngTemplateOutlet]="playerLossTable" [ngTemplateOutletContext]="{ $implicit: losses.players }" /> }
              }
            </div>
          </section>
        }

        <section class="surface overflow-hidden fight-detail__deferred" aria-labelledby="fight-segments-title">
          <header class="fight-detail__segments-header"><div><h2 id="fight-segments-title" class="fight-detail__section-title">Battle segments</h2><p class="fight-detail__hint">Open a segment for its individual battle report.</p></div><span class="chip mono">{{ detail.battle_ids.length }}</span></header>
          @if (detail.battle_ids.length) {
            <ol class="fight-detail__segment-list">
              @for (battleId of detail.battle_ids; track battleId; let index = $index) {
                <li><a class="fight-detail__segment-link" [routerLink]="['/battles', battleId]"><span class="fight-detail__segment-number" aria-hidden="true">{{ index + 1 }}</span><span><span class="fight-detail__segment-label">Battle segment</span><span class="mono">#{{ battleId }}</span></span><span class="fight-detail__open">Open <span aria-hidden="true">→</span></span></a>@if (canManageFights()) { <button type="button" class="btn btn--ghost btn--sm fight-detail__move" [disabled]="mutating()" (click)="openMove(battleId)">Move</button> }</li>
              }
            </ol>
          } @else { <p class="p-5 text-sm text-secondary">No battle segments have been attached to this fight.</p> }
        </section>
      </app-page-stack>

      @if (mergeOpen()) {
        <app-dialog title="Merge fights" subtitle="Choose the fight that remains, then list one or more other fights to merge into it." size="sm" (closed)="closeMutationDialog()">
          <form id="fight-merge-form" (submit)="stageMerge($event)">
            <label class="fight-detail__field-label" for="fight-merge-target">Surviving fight ID</label>
            <input id="fight-merge-target" class="input fight-detail__input" name="targetFightId" type="number" min="1" inputmode="numeric" [value]="mergeTargetId()" (input)="mergeTargetId.set(inputValue($event)); clearDialogError()" required />
            <label class="fight-detail__field-label" for="fight-merge-others">Other fight IDs</label>
            <input id="fight-merge-others" class="input fight-detail__input" name="otherFightIds" inputmode="numeric" placeholder="For example: 42, 57" [value]="mergeOtherIds()" (input)="mergeOtherIds.set(inputValue($event)); clearDialogError()" required aria-describedby="fight-merge-help" />
            <p id="fight-merge-help" class="fight-detail__hint">The current fight is included automatically if it is not already listed.</p>
            @if (dialogError(); as error) { <p class="fight-detail__mutation-error" role="alert">{{ error }}</p> }
          </form>
          <div dialogFooter><button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">Cancel</button><button type="submit" class="btn btn--primary btn--sm" form="fight-merge-form">Review merge</button></div>
        </app-dialog>
      }

      @if (splitOpen()) {
        <app-dialog title="Split segments" subtitle="Selected segments will become a new canonical fight." size="sm" (closed)="closeMutationDialog()">
          <form id="fight-split-form" (submit)="stageSplit($event)"><fieldset><legend class="fight-detail__field-label">Segments to move</legend><div class="fight-detail__checkboxes">@for (battleId of detail.battle_ids; track battleId) { <label><input type="checkbox" class="checkbox" [checked]="isSplitSelected(battleId)" (change)="toggleSplitBattle(battleId)" /> <span class="mono">#{{ battleId }}</span></label> }</div></fieldset>@if (dialogError(); as error) { <p class="fight-detail__mutation-error" role="alert">{{ error }}</p> }</form>
          <div dialogFooter><button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">Cancel</button><button type="submit" class="btn btn--primary btn--sm" form="fight-split-form">Review split</button></div>
        </app-dialog>
      }

      @if (moveBattleId(); as battleId) {
        <app-dialog title="Move battle segment" subtitle="Move this segment into another compatible fight." size="sm" (closed)="closeMutationDialog()">
          <form id="fight-move-form" (submit)="stageMove(battleId, $event)"><label class="fight-detail__field-label" for="fight-move-target">Destination fight ID</label><input id="fight-move-target" class="input fight-detail__input" name="targetFightId" type="number" min="1" inputmode="numeric" [value]="moveTargetId()" (input)="moveTargetId.set(inputValue($event)); clearDialogError()" required />@if (dialogError(); as error) { <p class="fight-detail__mutation-error" role="alert">{{ error }}</p> }</form>
          <div dialogFooter><button type="button" class="btn btn--ghost btn--sm" (click)="closeMutationDialog()">Cancel</button><button type="submit" class="btn btn--primary btn--sm" form="fight-move-form">Review move</button></div>
        </app-dialog>
      }

      @if (pendingMutation(); as pending) {
        <app-dialog title="Confirm fight change" size="sm" (closed)="cancelPendingMutation()"><p>{{ pending.description }}</p><p class="fight-detail__hint">This cannot be undone from the fight screen.</p>@if (dialogError(); as error) { <p class="fight-detail__mutation-error" role="alert">{{ error }}</p> }<div dialogFooter><button type="button" class="btn btn--ghost btn--sm" [disabled]="mutating()" (click)="cancelPendingMutation()">Cancel</button><button type="button" class="btn btn--danger btn--sm" [disabled]="mutating()" (click)="confirmMutation()">{{ mutating() ? 'Applying…' : 'Confirm change' }}</button></div></app-dialog>
      }

      <ng-template #guildTable let-guilds><article class="surface p-4"><h3 class="fight-detail__table-title">Guilds</h3><div class="fight-detail__table-wrap"><table class="table"><caption>Guild performance</caption><thead><tr><th scope="col">Guild</th><th scope="col" class="numeric">Players</th><th scope="col" class="numeric">K / D</th><th scope="col" class="numeric">Kill fame</th></tr></thead><tbody>@for (guild of guilds; track guild.id) { <tr><th scope="row">{{ guild.name }}</th><td class="numeric">{{ guild.players }}</td><td class="numeric">{{ guild.kills }} / {{ guild.deaths }}</td><td class="numeric">{{ formatAmount(guild.kill_fame) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #playerTable let-players><article class="surface p-4"><h3 class="fight-detail__table-title">Players</h3><div class="fight-detail__table-wrap"><table class="table"><caption>Player performance</caption><thead><tr><th scope="col">Player</th><th scope="col">Guild</th><th scope="col" class="numeric">K / D</th><th scope="col" class="numeric">Kill fame</th></tr></thead><tbody>@for (player of players; track player.id) { <tr><th scope="row">{{ player.name }}</th><td>{{ player.guild_name }}</td><td class="numeric">{{ player.kills }} / {{ player.deaths }}</td><td class="numeric">{{ formatAmount(player.kill_fame) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #guildLossTable let-losses><article class="surface p-4"><h3 class="fight-detail__table-title">Guild losses</h3><div class="fight-detail__table-wrap"><table class="table"><caption>Estimated losses by guild</caption><thead><tr><th scope="col">Guild</th><th scope="col" class="numeric">Deaths</th><th scope="col" class="numeric">Estimated loss</th></tr></thead><tbody>@for (loss of losses; track loss.guild_name) { <tr><th scope="row">{{ loss.guild_name }}</th><td class="numeric">{{ loss.deaths }}</td><td class="numeric">{{ formatAmount(loss.estimated_loss) }}</td></tr> }</tbody></table></div></article></ng-template>
      <ng-template #playerLossTable let-losses><article class="surface p-4"><h3 class="fight-detail__table-title">Player losses</h3><div class="fight-detail__table-wrap"><table class="table"><caption>Estimated losses by player</caption><thead><tr><th scope="col">Player</th><th scope="col">Guild</th><th scope="col" class="numeric">Deaths</th><th scope="col" class="numeric">Estimated loss</th></tr></thead><tbody>@for (loss of losses; track loss.player_name) { <tr><th scope="row">{{ loss.player_name }}</th><td>{{ loss.guild_name || 'Unknown' }}</td><td class="numeric">{{ loss.deaths }}</td><td class="numeric">{{ formatAmount(loss.estimated_loss) }}</td></tr> }</tbody></table></div></article></ng-template>
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
      .numeric { font-family: var(--font-mono); text-align: right; }
      .fight-detail__segments-header { align-items: center; border-bottom: 1px solid var(--color-border); display: flex; justify-content: space-between; padding: 1rem 1.25rem; }
      .fight-detail__segment-list { list-style: none; margin: 0; padding: 0; }
      .fight-detail__segment-list > li + li { border-top: 1px solid var(--color-border); }
      .fight-detail__segment-link { align-items: center; color: var(--color-text); display: grid; gap: .75rem; grid-template-columns: auto 1fr auto; padding: .875rem 1.25rem; text-decoration: none; }
      .fight-detail__segment-link:hover { background: var(--color-surface-hover); }
      .fight-detail__segment-link:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
      .fight-detail__segment-number { align-items: center; background: var(--color-surface-2); border-radius: var(--radius-sm); color: var(--color-text-secondary); display: inline-flex; font-family: var(--font-mono); font-size: .75rem; height: 1.5rem; justify-content: center; width: 1.5rem; }
      .fight-detail__segment-label { display: block; margin-bottom: .15rem; }
      .fight-detail__open { color: var(--color-text-secondary); font-size: .75rem; }
      .fight-detail__management { display: grid; gap: 1rem; }
      .fight-detail__management-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
      .fight-detail__mutation-error, .fight-detail__mutation-success { margin: 0; border: 1px solid var(--color-border); border-radius: var(--radius-sm); padding: .625rem .75rem; font-size: .8125rem; }
      .fight-detail__mutation-error { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface)); }
      .fight-detail__mutation-success { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 10%, var(--color-surface)); }
      .fight-detail__move { margin: 0 .75rem .625rem; }
      .fight-detail__field-label { display: block; color: var(--color-text); font-size: .8125rem; font-weight: 600; margin: 1rem 0 .375rem; }
      .fight-detail__field-label:first-child { margin-top: 0; }
      .fight-detail__input { box-sizing: border-box; min-height: 2.5rem; width: 100%; }
      .fight-detail__checkboxes { display: grid; gap: .5rem; margin-top: .5rem; }
      .fight-detail__checkboxes label { align-items: center; display: flex; gap: .5rem; min-height: 2.25rem; }
    }
  `,
})
export class FightDetailPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly fight = signal<FightDetail | null>(null);
  protected readonly canManageFights = computed(() => this.auth.hasPermission('fights.manage'));
  protected readonly mergeOpen = signal(false);
  protected readonly splitOpen = signal(false);
  protected readonly moveBattleId = signal<number | null>(null);
  protected readonly mergeTargetId = signal('');
  protected readonly mergeOtherIds = signal('');
  protected readonly moveTargetId = signal('');
  protected readonly splitBattleIds = signal<number[]>([]);
  protected readonly pendingMutation = signal<PendingFightMutation | null>(null);
  protected readonly dialogError = signal<string | null>(null);
  protected readonly mutationError = signal<string | null>(null);
  protected readonly mutationSuccess = signal<string | null>(null);
  protected readonly mutating = signal(false);
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

  protected openMerge(): void {
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.mergeOpen.set(true);
  }

  protected openSplit(): void {
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.splitBattleIds.set([]);
    this.splitOpen.set(true);
  }

  protected openMove(battleId: string | number): void {
    const id = this.parsePositiveId(String(battleId));
    if (!id) return;
    this.closeMutationDialog();
    this.mutationError.set(null);
    this.mutationSuccess.set(null);
    this.moveBattleId.set(id);
  }

  protected closeMutationDialog(): void {
    if (this.mutating()) return;
    this.mergeOpen.set(false);
    this.splitOpen.set(false);
    this.moveBattleId.set(null);
    this.dialogError.set(null);
  }

  protected clearDialogError(): void { this.dialogError.set(null); }
  protected inputValue(event: Event): string { return (event.target as HTMLInputElement).value; }
  protected isSplitSelected(battleId: string | number): boolean { const id = this.parsePositiveId(String(battleId)); return id !== null && this.splitBattleIds().includes(id); }
  protected toggleSplitBattle(battleId: string | number): void {
    const id = this.parsePositiveId(String(battleId));
    if (!id) return;
    this.splitBattleIds.update((ids) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id]);
    this.clearDialogError();
  }

  protected stageMerge(event: SubmitEvent): void {
    event.preventDefault();
    const currentId = this.fight()?.id;
    const targetId = this.parsePositiveId(this.mergeTargetId());
    const otherIds = this.parseIdList(this.mergeOtherIds());
    if (!currentId || !targetId || otherIds === null) {
      this.dialogError.set('Enter a surviving fight ID and a comma-separated list of valid fight IDs.');
      return;
    }
    const fightIds = [...new Set([currentId, targetId, ...otherIds])];
    if (fightIds.length < 2) {
      this.dialogError.set('Select at least two different fights to merge.');
      return;
    }
    this.mergeOpen.set(false);
    this.pendingMutation.set({ kind: 'merge', body: { target_fight_id: targetId, fight_ids: fightIds }, description: `Merge ${fightIds.map((id) => `fight #${id}`).join(', ')}. Fight #${targetId} will remain.` });
  }

  protected stageSplit(event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const selected = this.splitBattleIds();
    const total = this.fight()?.battle_ids.length ?? 0;
    if (!sourceId || selected.length === 0 || selected.length >= total) {
      this.dialogError.set('Select at least one segment, but leave at least one segment in this fight.');
      return;
    }
    this.splitOpen.set(false);
    this.pendingMutation.set({ kind: 'split', body: { battle_ids: selected }, description: `Split ${selected.map((id) => `battle #${id}`).join(', ')} into a new fight.` });
  }

  protected stageMove(battleId: number, event: SubmitEvent): void {
    event.preventDefault();
    const sourceId = this.fight()?.id;
    const targetId = this.parsePositiveId(this.moveTargetId());
    if (!sourceId || !targetId || targetId === sourceId) {
      this.dialogError.set('Enter a different, valid destination fight ID.');
      return;
    }
    this.moveBattleId.set(null);
    this.pendingMutation.set({ kind: 'move', battleId, body: { battle_id: battleId, target_fight_id: targetId }, description: `Move battle #${battleId} from fight #${sourceId} to fight #${targetId}.` });
  }

  protected cancelPendingMutation(): void {
    if (this.mutating()) return;
    this.pendingMutation.set(null);
    this.dialogError.set(null);
  }

  protected async confirmMutation(): Promise<void> {
    const pending = this.pendingMutation();
    const sourceId = this.fight()?.id;
    if (!pending || !sourceId) return;
    this.mutating.set(true);
    this.dialogError.set(null);
    this.mutationError.set(null);
    try {
      const path = pending.kind === 'merge' ? 'api/fights/merge' : pending.kind === 'split' ? `api/fights/${sourceId}/split` : `api/fights/${sourceId}/move-battle`;
      const result = await firstValueFrom(this.api.post<FightMutationResult>(path, pending.body));
      this.pendingMutation.set(null);
      this.mutationSuccess.set(`Fight grouping updated. Resulting fight: #${result.fight_id}.`);
      if (result.fight_id === sourceId) {
        await this.load();
      } else {
        await this.router.navigate(['/fights', result.fight_id]);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unable to update fight grouping.';
      this.dialogError.set(message);
      this.mutationError.set(message);
    } finally {
      this.mutating.set(false);
    }
  }

  protected fightWindow(fight: FightDetail): string { return `${this.formatDate(fight.started_at)}${fight.ended_at ? ` to ${this.formatDate(fight.ended_at)}` : ''}`; }
  protected formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
  protected formatAmount(value: number): string { return Intl.NumberFormat().format(value); }
  protected formatDecimal(value: number): string { return value.toFixed(0); }
  protected formatPercent(value: number): string { return `${(value <= 1 ? value * 100 : value).toFixed(0)}%`; }
  private parsePositiveId(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  private parseIdList(value: string): number[] | null {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    const ids = parts.map((part) => this.parsePositiveId(part));
    return ids.every((id): id is number => id !== null) ? ids : null;
  }
  private ratioStat(label: string, value: number | undefined): FightStat | null { return value === undefined ? null : { label, value: value.toFixed(2), tone: value >= 1 ? 'success' : 'error' }; }
  private percentStat(label: string, value: number | undefined): FightStat | null { return value === undefined ? null : { label, value: this.formatPercent(value), tone: 'success' }; }
}
