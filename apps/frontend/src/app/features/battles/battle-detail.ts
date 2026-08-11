import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BattleDetail,
  BattleGuildSummary,
  BattleKillEvent,
  BattlePlayer,
  BattleSummary,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';

const TABLE_PAGE_SIZE = 12;
const CHART_LIMIT = 8;
const ALBION_RENDER_ITEM_BASE_URL = 'https://render.albiononline.com/v1/item';

type DetailTab = 'fight' | 'guild';
type KillSide = 'killer' | 'victim';
type RawObject = Record<string, unknown>;

interface TableSlice<T> {
  readonly items: T[];
  readonly totalItems: number;
  readonly totalPages: number;
}

/**
 * Full-page analytics view for one battle.
 *
 * Uses normal document flow instead of a modal so long player and kill tables
 * can scroll with the page and remain usable on small screens.
 *
 * @example
 * ```ts
 * routes.push({ path: 'battles/:battleId', loadComponent: () => import('./battle-detail').then(m => m.BattleDetailPage) });
 * ```
 */
@Component({
  selector: 'app-battle-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Loading],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (battle(); as detail) {
      <header class="battle-detail__hero card p-5">
        <button type="button" class="btn btn--ghost" (click)="backToBattles()">← {{ t('nav.battles') }}</button>
        <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <h1 class="text-3xl font-bold" style="color: var(--color-text)">#{{ detail.battle_id }}</h1>
              @if (winnerGuild(detail); as winner) {
                <span class="chip chip--success">{{ t('battles.winner') }} · {{ winner.name }}</span>
              }
            </div>
            <p style="color: var(--color-text-secondary)">{{ formatDate(detail.start_time) }} · {{ formatDuration(detail) }}</p>
          </div>
          <nav class="inline-flex gap-1 rounded-full p-1" style="background: var(--color-surface-1)">
            <button type="button" class="btn btn--ghost" [class.btn--tonal]="tab() === 'fight'" (click)="switchTab('fight')">{{ t('battles.fight_info') }}</button>
            <button type="button" class="btn btn--ghost" [class.btn--tonal]="tab() === 'guild'" (click)="switchTab('guild')">{{ t('battles.guild_info') }}</button>
          </nav>
        </div>
      </header>

      @if (tab() === 'fight') {
        <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Fight stats">
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.total_fame') }}</p><p class="battle-detail__value">{{ formatCompact(detail.total_fame) }}</p></article>
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.players') }}</p><p class="battle-detail__value">{{ formatAmount(detail.total_players) }}</p></article>
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.guilds') }}</p><p class="battle-detail__value">{{ detail.guilds.length }}</p></article>
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.kills') }}</p><p class="battle-detail__value">{{ formatAmount(detail.total_kills) }}</p></article>
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.deaths') }}</p><p class="battle-detail__value">{{ formatAmount(totalDeaths(detail.guilds)) }}</p></article>
          <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.kill_death') }}</p><p class="battle-detail__value">{{ formatRatio(detail.total_kills, totalDeaths(detail.guilds)) }}</p></article>
        </section>

        <section class="mt-5 grid gap-4 xl:grid-cols-2">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.fame_chart') }}</h2>
            @for (guild of chartGuilds(detail.guilds); track guildKey(guild)) {
              <div class="battle-detail__bar-row">
                <span>{{ guild.name || t('common.none') }}</span>
                <div class="battle-detail__bar"><span [style.width.%]="percentage(guild.kill_fame, maxGuildFame(detail.guilds))"></span></div>
                <strong>{{ formatCompact(guild.kill_fame) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.kill_chart') }}</h2>
            @for (guild of chartGuilds(detail.guilds); track guildKey(guild)) {
              <div class="battle-detail__bar-row">
                <span>{{ guild.name || t('common.none') }}</span>
                <div class="battle-detail__bar battle-detail__bar--kills"><span [style.width.%]="percentage(guild.kills, maxGuildKills(detail.guilds))"></span></div>
                <strong>{{ guild.kills }}/{{ guild.deaths }}</strong>
              </div>
            }
          </article>
        </section>

        <article class="mt-5 surface overflow-hidden">
          <header class="battle-detail__table-header"><h2>{{ t('battles.guild_breakdown') }}</h2><input class="input battle-detail__filter" type="search" [placeholder]="t('common.search')" [value]="guildFilter()" (input)="onGuildFilterChange($event)" /></header>
          <div class="overflow-x-auto"><table class="table"><thead><tr><th>{{ t('common.name') }}</th><th>{{ t('battles.players') }}</th><th>{{ t('battles.kills') }}</th><th>{{ t('battles.deaths') }}</th><th>{{ t('battles.fame') }}</th><th>{{ t('battles.kill_death') }}</th></tr></thead><tbody>@for (guild of guildTable().items; track guildKey(guild)) { <tr><td><span class="font-medium">{{ guild.name || t('common.none') }}</span> @if (guild.winner) { <span class="ml-2 chip chip--success">{{ t('battles.winner') }}</span> }</td><td>{{ guild.players }}</td><td>{{ guild.kills }}</td><td>{{ guild.deaths }}</td><td>{{ formatCompact(guild.kill_fame) }}</td><td>{{ formatRatio(guild.kills, guild.deaths) }}</td></tr> }</tbody></table></div>
          <footer class="battle-detail__table-footer"><span>{{ guildTable().totalItems }} {{ t('battles.total_results') }}</span><button type="button" class="btn btn--outline" [disabled]="guildTablePage() <= 1" (click)="prevGuildTablePage()">{{ t('common.prev') }}</button><span>{{ guildTablePage() }}/{{ guildTable().totalPages }}</span><button type="button" class="btn btn--outline" [disabled]="guildTablePage() >= guildTable().totalPages" (click)="nextGuildTablePage()">{{ t('common.next') }}</button></footer>
        </article>
      } @else {
        @if (primaryGuild(detail); as guild) {
          <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Guild stats">
            <article class="surface p-4 xl:col-span-2"><p class="battle-detail__label">{{ t('battles.guild') }}</p><p class="battle-detail__value">{{ guild.name }}</p></article>
            <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.players') }}</p><p class="battle-detail__value">{{ guild.players }}</p></article>
            <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.kills') }}</p><p class="battle-detail__value">{{ guild.kills }}</p></article>
            <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.deaths') }}</p><p class="battle-detail__value">{{ guild.deaths }}</p></article>
            <article class="surface p-4"><p class="battle-detail__label">{{ t('battles.fame_share') }}</p><p class="battle-detail__value">{{ formatDecimal(percentage(guild.kill_fame, detail.total_fame)) }}%</p></article>
          </section>
        }

        <section class="mt-5 grid gap-4 xl:grid-cols-2">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.guild_fame_vs_fight') }}</h2>
            <svg class="battle-detail__donut" viewBox="0 0 42 42" role="img" aria-label="Guild fame share chart">
              <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--color-surface-2)" stroke-width="7"></circle>
              <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--color-primary)" stroke-width="7" [attr.stroke-dasharray]="donutDashArray(detail)" stroke-dashoffset="25"></circle>
              <text x="21" y="22.5" text-anchor="middle">{{ formatDecimal(primaryGuildFameShare(detail)) }}%</text>
            </svg>
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.weapon_presence') }}</h2>
            @for (weapon of weaponChart(); track weapon.type) {
              <div class="battle-detail__weapon-row"><img [src]="itemIconUrl(weapon.type)" [alt]="weapon.type" loading="lazy" /><span class="truncate">{{ weapon.type }}</span><div class="battle-detail__bar"><span [style.width.%]="percentage(weapon.count, maxWeaponCount())"></span></div><strong>{{ weapon.count }}</strong></div>
            } @empty {
              <p class="text-sm" style="color: var(--color-text-secondary)">{{ t('battles.no_weapon_data') }}</p>
            }
          </article>
        </section>

        <article class="mt-5 surface overflow-hidden">
          <header class="battle-detail__table-header"><h2>{{ t('battles.top_players') }}</h2><input class="input battle-detail__filter" type="search" [placeholder]="t('common.search')" [value]="playerFilter()" (input)="onPlayerFilterChange($event)" /></header>
          <div class="overflow-x-auto"><table class="table"><thead><tr><th>{{ t('common.name') }}</th><th>{{ t('battles.guild') }}</th><th>{{ t('battles.kills') }}</th><th>{{ t('battles.deaths') }}</th><th>{{ t('battles.kill_fame') }}</th><th>{{ t('battles.death_fame') }}</th><th>{{ t('battles.item_power') }}</th></tr></thead><tbody>@for (player of playerTable().items; track player.id || player.name) { <tr><td class="font-medium">{{ player.name }}</td><td>{{ player.guild_name || t('common.none') }}</td><td>{{ player.kills }}</td><td>{{ player.deaths }}</td><td>{{ formatCompact(player.kill_fame) }}</td><td>{{ formatCompact(player.death_fame) }}</td><td>{{ formatDecimal(player.item_power) }}</td></tr> }</tbody></table></div>
          <footer class="battle-detail__table-footer"><span>{{ playerTable().totalItems }} {{ t('battles.total_results') }}</span><button type="button" class="btn btn--outline" [disabled]="playerTablePage() <= 1" (click)="prevPlayerTablePage()">{{ t('common.prev') }}</button><span>{{ playerTablePage() }}/{{ playerTable().totalPages }}</span><button type="button" class="btn btn--outline" [disabled]="playerTablePage() >= playerTable().totalPages" (click)="nextPlayerTablePage()">{{ t('common.next') }}</button></footer>
        </article>

        <article class="mt-5 surface overflow-hidden">
          <header class="battle-detail__table-header"><h2>{{ t('battles.kill_timeline') }}</h2><input class="input battle-detail__filter" type="search" [placeholder]="t('common.search')" [value]="killFilter()" (input)="onKillFilterChange($event)" /></header>
          <div class="overflow-x-auto"><table class="table"><thead><tr><th>{{ t('common.date') }}</th><th>{{ t('battles.killer') }}</th><th>{{ t('battles.victim') }}</th><th>{{ t('battles.fame') }}</th><th>{{ t('battles.item_power') }}</th></tr></thead><tbody>@for (kill of killTable().items; track kill.event_id) { <tr><td>{{ formatTime(kill.time) }}</td><td><span class="battle-detail__participant"><img [src]="participantWeaponIcon(kill, 'killer')" alt="" loading="lazy" /><span><strong>{{ kill.killer.name }}</strong><small>{{ kill.killer.guild_name || t('common.none') }}</small></span></span></td><td><span class="battle-detail__participant"><img [src]="participantWeaponIcon(kill, 'victim')" alt="" loading="lazy" /><span><strong>{{ kill.victim.name }}</strong><small>{{ kill.victim.guild_name || t('common.none') }}</small></span></span></td><td>{{ formatCompact(kill.total_kill_fame) }}</td><td>{{ formatDecimal(kill.killer_item_power) }} → {{ formatDecimal(kill.victim_item_power) }}</td></tr> }</tbody></table></div>
          <footer class="battle-detail__table-footer"><span>{{ killTable().totalItems }} {{ t('battles.total_results') }}</span><button type="button" class="btn btn--outline" [disabled]="killTablePage() <= 1" (click)="prevKillTablePage()">{{ t('common.prev') }}</button><span>{{ killTablePage() }}/{{ killTable().totalPages }}</span><button type="button" class="btn btn--outline" [disabled]="killTablePage() >= killTable().totalPages" (click)="nextKillTablePage()">{{ t('common.next') }}</button></footer>
        </article>
      }
    }
  `,
  styles: `
    @layer components {
      .battle-detail__hero { position: sticky; top: 0; z-index: 10; }
      .battle-detail__label { color: var(--color-text-disabled); font-size: .75rem; letter-spacing: .04em; text-transform: uppercase; }
      .battle-detail__value { color: var(--color-text); font-size: clamp(1.25rem, 2vw, 1.75rem); font-weight: 700; }
      .battle-detail__panel-title { color: var(--color-text); font-size: 1rem; font-weight: 700; margin-bottom: 1rem; }
      .battle-detail__bar-row, .battle-detail__weapon-row { align-items: center; display: grid; gap: .75rem; grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 2fr) auto; margin-top: .75rem; }
      .battle-detail__bar { background: var(--color-surface-2); border-radius: var(--radius-full); height: .7rem; overflow: hidden; }
      .battle-detail__bar span { background: var(--color-primary); border-radius: inherit; display: block; height: 100%; min-width: .25rem; }
      .battle-detail__bar--kills span { background: var(--color-warning); }
      .battle-detail__table-header { align-items: center; border-bottom: 1px solid var(--color-border); display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; padding: 1rem; }
      .battle-detail__table-header h2 { color: var(--color-text); font-size: 1rem; font-weight: 700; }
      .battle-detail__filter { max-width: 18rem; }
      .battle-detail__table-footer { align-items: center; border-top: 1px solid var(--color-border); color: var(--color-text-secondary); display: flex; flex-wrap: wrap; gap: .75rem; justify-content: flex-end; padding: .75rem 1rem; }
      .battle-detail__donut { display: block; height: 14rem; margin: 0 auto; max-width: 14rem; width: 100%; }
      .battle-detail__donut text { fill: var(--color-text); font-size: .32rem; font-weight: 700; }
      .battle-detail__weapon-row { grid-template-columns: 2rem minmax(6rem, 1fr) minmax(8rem, 2fr) auto; }
      .battle-detail__weapon-row img, .battle-detail__participant img { background: var(--color-surface-2); border-radius: var(--radius-sm); height: 2rem; object-fit: contain; width: 2rem; }
      .battle-detail__participant { align-items: center; display: inline-flex; gap: .5rem; min-width: 12rem; }
      .battle-detail__participant small { color: var(--color-text-secondary); display: block; font-size: .75rem; }
    }
  `,
})
export class BattleDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly battle = signal<BattleDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly tab = signal<DetailTab>('fight');
  protected readonly guildFilter = signal('');
  protected readonly playerFilter = signal('');
  protected readonly killFilter = signal('');
  protected readonly guildTablePage = signal(1);
  protected readonly playerTablePage = signal(1);
  protected readonly killTablePage = signal(1);
  protected readonly guildTable = computed(() => this.paginate(this.filteredGuilds(), this.guildTablePage()));
  protected readonly playerTable = computed(() => this.paginate(this.filteredPlayers(), this.playerTablePage()));
  protected readonly killTable = computed(() => this.paginate(this.filteredKills(), this.killTablePage()));
  protected readonly weaponChart = computed(() => this.buildWeaponChart());
  protected readonly maxWeaponCount = computed(() => Math.max(...this.weaponChart().map((weapon) => weapon.count), 0));

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** Returns to the battle list without relying on browser history state. */
  protected backToBattles(): void { void this.router.navigate(['/battles']); }

  /** Switches between fight-wide and guild-specific analytics. */
  protected switchTab(tab: DetailTab): void { this.tab.set(tab); }

  /** Updates guild filtering and resets the table to page one. */
  protected onGuildFilterChange(event: Event): void { this.guildFilter.set((event.target as HTMLInputElement).value); this.guildTablePage.set(1); }

  /** Updates player filtering and resets the table to page one. */
  protected onPlayerFilterChange(event: Event): void { this.playerFilter.set((event.target as HTMLInputElement).value); this.playerTablePage.set(1); }

  /** Updates kill filtering and resets the table to page one. */
  protected onKillFilterChange(event: Event): void { this.killFilter.set((event.target as HTMLInputElement).value); this.killTablePage.set(1); }

  /** Moves the guild table backward without crossing page one. */
  protected prevGuildTablePage(): void { this.guildTablePage.update((page) => Math.max(1, page - 1)); }

  /** Moves the guild table forward without crossing the filtered page count. */
  protected nextGuildTablePage(): void { this.guildTablePage.update((page) => Math.min(this.guildTable().totalPages, page + 1)); }

  /** Moves the player table backward without crossing page one. */
  protected prevPlayerTablePage(): void { this.playerTablePage.update((page) => Math.max(1, page - 1)); }

  /** Moves the player table forward without crossing the filtered page count. */
  protected nextPlayerTablePage(): void { this.playerTablePage.update((page) => Math.min(this.playerTable().totalPages, page + 1)); }

  /** Moves the kill table backward without crossing page one. */
  protected prevKillTablePage(): void { this.killTablePage.update((page) => Math.max(1, page - 1)); }

  /** Moves the kill table forward without crossing the filtered page count. */
  protected nextKillTablePage(): void { this.killTablePage.update((page) => Math.min(this.killTable().totalPages, page + 1)); }

  /** Formats local date/time according to the browser locale. */
  protected formatDate(isoDate: string): string { return new Date(isoDate).toLocaleString(); }

  /** Formats local time for compact kill-feed rows. */
  protected formatTime(isoDate: string): string { return new Date(isoDate).toLocaleTimeString(); }

  /** Formats exact integer metrics with locale separators. */
  protected formatAmount(value: number): string { return value.toLocaleString(); }

  /** Makes large fame values readable in charts and tables. */
  protected formatCompact(value: number): string { return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value); }

  /** Avoids noisy precision from upstream decimal item-power values. */
  protected formatDecimal(value: number): string { return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value); }

  /** Presents kill/death efficiency while protecting against division by zero. */
  protected formatRatio(kills: number, deaths: number): string { return deaths === 0 ? (kills > 0 ? '∞' : '0') : this.formatDecimal(kills / deaths); }

  /** Calculates duration from server timestamps with a safe fallback. */
  protected formatDuration(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): string {
    const milliseconds = new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return this.t('battles.duration_unknown');
    }
    return `${Math.max(1, Math.round(milliseconds / 60000))}m`;
  }

  /** Provides a stable track key when AlbionBB omits guild ids. */
  protected guildKey(guild: BattleGuildSummary): string { return guild.id || guild.name; }

  /** Finds the winning or highest-fame guild. */
  protected winnerGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null { return battle.guilds.find((guild) => guild.winner) ?? this.sortedGuilds(battle.guilds)[0] ?? null; }

  /** Selects Weaklings when visible, otherwise falls back to the winner. */
  protected primaryGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null { return battle.guilds.find((guild) => guild.name.toLowerCase() === 'weaklings') ?? this.winnerGuild(battle); }

  /** Computes the selected guild fame share for the donut chart. */
  protected primaryGuildFameShare(battle: BattleSummary): number { const guild = this.primaryGuild(battle); return guild ? this.percentage(guild.kill_fame, battle.total_fame) : 0; }

  /** Provides Angular-safe SVG donut segments for the selected guild share. */
  protected donutDashArray(battle: BattleSummary): string { const share = this.primaryGuildFameShare(battle); return `${share} ${100 - share}`; }

  /** Sorts guilds by fame without mutating signal-owned arrays. */
  protected sortedGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] { return [...guilds].sort((leftGuild, rightGuild) => rightGuild.kill_fame - leftGuild.kill_fame); }

  /** Limits chart rows to avoid unreadable long legends. */
  protected chartGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] { return this.sortedGuilds(guilds).slice(0, CHART_LIMIT); }

  /** Aggregates deaths across guild rows. */
  protected totalDeaths(guilds: readonly BattleGuildSummary[]): number { return guilds.reduce((totalDeaths, guild) => totalDeaths + guild.deaths, 0); }

  /** Returns the max guild fame for proportional bars. */
  protected maxGuildFame(guilds: readonly BattleGuildSummary[]): number { return Math.max(...guilds.map((guild) => guild.kill_fame), 0); }

  /** Returns the max guild kills for proportional bars. */
  protected maxGuildKills(guilds: readonly BattleGuildSummary[]): number { return Math.max(...guilds.map((guild) => guild.kills), 0); }

  /** Converts values into bounded percentages for CSS/SVG chart dimensions. */
  protected percentage(value: number, total: number): number { return total <= 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100)); }

  /** Builds a public Albion item render URL from an upstream equipment type. */
  protected itemIconUrl(itemType: string): string { return `${ALBION_RENDER_ITEM_BASE_URL}/${encodeURIComponent(itemType)}.png`; }

  /** Extracts participant weapon icon from AlbionBB raw equipment data. */
  protected participantWeaponIcon(kill: BattleKillEvent, side: KillSide): string { return this.itemIconUrl(this.extractWeaponType(kill.raw, side) ?? 'T4_MAIN_SWORD'); }

  /** Fetches battle id from the route and loads the full analytics payload. */
  private async load(): Promise<void> {
    const battleId = Number(this.route.snapshot.paramMap.get('battleId'));
    if (battleId <= 0) {
      this.toasts.error(this.t('common.error'));
      this.backToBattles();
      return;
    }
    this.loading.set(true);
    try {
      this.battle.set(await firstValueFrom(this.api.get<BattleDetail>(`api/battles/${battleId}`)));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  /** Filters guild rows by name while preserving the default fame sort. */
  private filteredGuilds(): BattleGuildSummary[] {
    const detail = this.battle();
    if (!detail) { return []; }
    const needle = this.guildFilter().trim().toLowerCase();
    return this.sortedGuilds(detail.guilds).filter((guild) => !needle || guild.name.toLowerCase().includes(needle));
  }

  /** Filters players by player or guild name and sorts by kill fame. */
  private filteredPlayers(): BattlePlayer[] {
    const detail = this.battle();
    if (!detail) { return []; }
    const needle = this.playerFilter().trim().toLowerCase();
    return [...detail.players].filter((player) => !needle || `${player.name} ${player.guild_name}`.toLowerCase().includes(needle)).sort((leftPlayer, rightPlayer) => rightPlayer.kill_fame - leftPlayer.kill_fame || rightPlayer.kills - leftPlayer.kills);
  }

  /** Filters kill-feed rows by participant and guild names. */
  private filteredKills(): BattleKillEvent[] {
    const detail = this.battle();
    if (!detail) { return []; }
    const needle = this.killFilter().trim().toLowerCase();
    return detail.kills.filter((kill) => !needle || `${kill.killer.name} ${kill.killer.guild_name ?? ''} ${kill.victim.name} ${kill.victim.guild_name ?? ''}`.toLowerCase().includes(needle));
  }

  /** Slices filtered rows into stable one-indexed table pages. */
  private paginate<T>(items: readonly T[], page: number): TableSlice<T> {
    const totalPages = Math.max(1, Math.ceil(items.length / TABLE_PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const startIndex = (safePage - 1) * TABLE_PAGE_SIZE;
    return { items: items.slice(startIndex, startIndex + TABLE_PAGE_SIZE), totalItems: items.length, totalPages };
  }

  /** Counts weapon occurrences from modeled raw kill-feed equipment. */
  private buildWeaponChart(): Array<{ readonly type: string; readonly count: number }> {
    const detail = this.battle();
    if (!detail) { return []; }
    const counts = new Map<string, number>();
    for (const kill of detail.kills) {
      for (const side of ['killer', 'victim'] as const) {
        const weaponType = this.extractWeaponType(kill.raw, side);
        if (!weaponType) { continue; }
        counts.set(weaponType, (counts.get(weaponType) ?? 0) + 1);
      }
    }
    return [...counts.entries()].map(([type, count]) => ({ type, count })).sort((leftWeapon, rightWeapon) => rightWeapon.count - leftWeapon.count).slice(0, CHART_LIMIT);
  }

  /** Reads nested `Killer/Victim -> Equipment -> MainHand -> Type` safely from raw JSON. */
  private extractWeaponType(raw: unknown, side: KillSide): string | null {
    const participantKey = side === 'killer' ? 'Killer' : 'Victim';
    const participant = this.readObject(raw, participantKey) ?? this.readObject(raw, participantKey.toLowerCase());
    const equipment = this.readObject(participant, 'Equipment') ?? this.readObject(participant, 'equipment');
    const mainHand = this.readObject(equipment, 'MainHand') ?? this.readObject(equipment, 'mainHand') ?? this.readObject(equipment, 'main_hand');
    const type = this.readString(mainHand, 'Type') ?? this.readString(mainHand, 'type');
    return type && type.trim().length > 0 ? type : null;
  }

  /** Returns an object property only when the runtime JSON shape matches. */
  private readObject(source: unknown, key: string): RawObject | null {
    if (!source || typeof source !== 'object') { return null; }
    const value = (source as RawObject)[key];
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as RawObject) : null;
  }

  /** Returns a string property only when the runtime JSON shape matches. */
  private readString(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') { return null; }
    const value = (source as RawObject)[key];
    return typeof value === 'string' ? value : null;
  }
}
