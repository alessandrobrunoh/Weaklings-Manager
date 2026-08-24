import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { RouterLink } from '@angular/router';

import type {
  BattleDetail,
  BattleGuildSummary,
  BattleKillEvent,
  BattlePlayer,
  BattleSummary,
  BuildItemSlot,
  BuildSlot,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Loading } from '../../shared/components/loading/loading';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

const CHART_LIMIT = 8;
const ALBION_RENDER_ITEM_BASE_URL = 'https://render.albiononline.com/v1/item';

type DetailTab = 'fight' | 'guild' | 'players' | 'timeline';

function isDetailTab(value: string): value is DetailTab {
  return value === 'fight' || value === 'guild' || value === 'players' || value === 'timeline';
}
type KillSide = 'killer' | 'victim';

/**
 * AlbionBB equipment keys mapped to the slot names builds use.
 *
 * Kept in the same order the paperdoll lays out, so a loadout reads the same
 * whether it came from a build or from a kill feed.
 */
const EQUIPMENT_SLOTS: Readonly<Record<string, BuildSlot>> = {
  MainHand: 'weapon',
  OffHand: 'off_hand',
  Head: 'head',
  Armor: 'armor',
  Shoes: 'shoes',
  Cape: 'cape',
  Bag: 'bag',
  Potion: 'potion',
  Food: 'food',
  Mount: 'mount',
};
type RawObject = Record<string, unknown>;

interface BattleChartMetric {
  readonly label: string;
  readonly value: number;
}

interface BattleKpiCard {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
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
  imports: [Loading, DataTable, EquipmentGrid, RouterLink, ViewToggle],
  template: `
    @if (loading()) {
      <app-loading [label]="t('common.loading')" />
    } @else if (battle(); as detail) {
      <header class="battle-detail__hero card p-5">
        <button type="button" class="btn btn--ghost" (click)="backToBattles()">
          ← {{ t('nav.battles') }}
        </button>
        <div class="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <h1 class="text-3xl font-bold" style="color: var(--color-text)">
                #{{ detail.battle_id }}
              </h1>
              @if (winnerGuild(detail); as winner) {
                <span class="chip chip--success"
                  >{{ t('battles.winner') }} · {{ winner.name }}</span
                >
              }
              <!-- AlbionBB knows nothing about our events, so an unlinked
                   battle is one the background sync found on its own and
                   cannot be attributed to a composition. -->
              @if (detail.linked_event; as event) {
                <a
                  class="chip chip--info no-underline"
                  [routerLink]="['/events', event.id]"
                  [title]="t('battles.linkedEventHint')"
                >
                  {{ event.title }}
                  @if (event.call_to_arms) {
                    · {{ t('events.call_to_arms') }}
                  }
                </a>
              } @else {
                <span class="chip" [title]="t('battles.unlinkedHint')">
                  {{ t('battles.unlinked') }}
                </span>
              }
            </div>
            <p style="color: var(--color-text-secondary)">
              {{ formatDate(detail.start_time) }} · {{ formatDuration(detail) }}
            </p>
          </div>
          <app-view-toggle
            [options]="tabOptions()"
            [active]="tab()"
            (activeChange)="switchTab($event)"
          />
        </div>
      </header>

      <section
        class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-8"
        aria-label="Advanced battle KPIs"
      >
        @for (metric of battleKpiCards(); track metric.label) {
          <article class="surface p-4">
            <p class="battle-detail__label">{{ metric.label }}</p>
            <p class="battle-detail__value">{{ metric.value }}</p>
            @if (metric.sub) {
              <p class="battle-detail__sub">{{ metric.sub }}</p>
            }
          </article>
        }
      </section>

      @if (tab() === 'fight') {
        <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Fight stats">
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.total_fame') }}</p>
            <p class="battle-detail__value">{{ formatCompact(detail.total_fame) }}</p>
          </article>
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.players') }}</p>
            <p class="battle-detail__value">{{ formatAmount(detail.total_players) }}</p>
          </article>
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.guilds') }}</p>
            <p class="battle-detail__value">{{ detail.guilds.length }}</p>
          </article>
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.kills') }}</p>
            <p class="battle-detail__value">{{ formatAmount(detail.total_kills) }}</p>
          </article>
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.deaths') }}</p>
            <p class="battle-detail__value">{{ formatAmount(totalDeaths(detail.guilds)) }}</p>
          </article>
          <article class="surface p-4">
            <p class="battle-detail__label">{{ t('battles.kill_death') }}</p>
            <p class="battle-detail__value">
              {{ formatRatio(detail.total_kills, totalDeaths(detail.guilds)) }}
            </p>
          </article>
        </section>

        <section class="mt-5 grid gap-4 xl:grid-cols-3">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.fame_chart') }}</h2>
            @for (guild of chartGuilds(detail.guilds); track guildKey(guild)) {
              <div class="battle-detail__bar-row">
                <span>{{ guild.name || t('common.none') }}</span>
                <div class="battle-detail__bar">
                  <span
                    [style.width.%]="percentage(guild.kill_fame, maxGuildFame(detail.guilds))"
                  ></span>
                </div>
                <strong>{{ formatCompact(guild.kill_fame) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.kill_chart') }}</h2>
            @for (guild of chartGuilds(detail.guilds); track guildKey(guild)) {
              <div class="battle-detail__bar-row">
                <span>{{ guild.name || t('common.none') }}</span>
                <div class="battle-detail__bar battle-detail__bar--kills">
                  <span
                    [style.width.%]="percentage(guild.kills, maxGuildKills(detail.guilds))"
                  ></span>
                </div>
                <strong>{{ guild.kills }}/{{ guild.deaths }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Damage pressure proxy</h2>
            @for (guild of chartGuilds(detail.guilds); track guildKey(guild)) {
              <div class="battle-detail__bar-row">
                <span>{{ guild.name || t('common.none') }}</span>
                <div class="battle-detail__bar battle-detail__bar--danger">
                  <span
                    [style.width.%]="percentage(guild.deaths, maxGuildDeaths(detail.guilds))"
                  ></span>
                </div>
                <strong>{{ guild.deaths }} deaths</strong>
              </div>
            }
          </article>
        </section>

        <section class="mt-5 grid gap-4 xl:grid-cols-4">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Fame efficiency</h2>
            @for (row of famePerPlayerChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(famePerPlayerChart()))"
                  ></span>
                </div>
                <strong>{{ formatCompact(row.value) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">K/D leaders</h2>
            @for (row of guildKdChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--kills">
                  <span [style.width.%]="percentage(row.value, maxMetric(guildKdChart()))"></span>
                </div>
                <strong>{{ formatDecimal(row.value) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Player share</h2>
            @for (row of guildPlayerShareChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--players">
                  <span [style.width.%]="row.value"></span>
                </div>
                <strong>{{ formatDecimal(row.value) }}%</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Our guild silver lost</h2>
            <p class="battle-detail__value">
              {{ formatCompact(detail.estimated_losses.total_estimated_loss) }}
            </p>
            <p class="battle-detail__sub">
              {{ detail.estimated_losses.priced_items }} /
              {{ detail.estimated_losses.total_items }} own-guild victim items · AlbionData city
              minimum
            </p>
            @for (row of lossGuildChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--danger">
                  <span [style.width.%]="percentage(row.value, maxMetric(lossGuildChart()))"></span>
                </div>
                <strong>{{ formatCompact(row.value) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Kill timeline density</h2>
            @for (row of killMinuteChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--timeline">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(killMinuteChart()))"
                  ></span>
                </div>
                <strong>{{ row.value }}</strong>
              </div>
            } @empty {
              <p class="text-sm" style="color: var(--color-text-secondary)">No kill timestamps.</p>
            }
          </article>
        </section>

        <article class="mt-5 surface overflow-hidden">
          <app-data-table
            [columns]="guildColumns"
            [rows]="guildRows()"
            [trackBy]="trackGuild"
            [pageSize]="12"
          >
            <ng-template dataTableCell="name" let-row>
              <span class="font-medium">{{ row.name || t('common.none') }}</span>
              @if (row.winner) {
                <span class="ml-2 chip chip--success">{{ t('battles.winner') }}</span>
              }
            </ng-template>
            <ng-template dataTableCell="kill_fame" let-row>
              {{ formatCompact(row.kill_fame) }}
            </ng-template>
            <ng-template dataTableCell="kill_death" let-row>
              {{ formatGuildKDRatio(row.kills, row.deaths) }}
            </ng-template>
          </app-data-table>
        </article>
      } @else if (tab() === 'guild') {
        @if (primaryGuild(detail); as guild) {
          <section class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Guild stats">
            <article class="surface p-4 xl:col-span-2">
              <p class="battle-detail__label">{{ t('battles.guild') }}</p>
              <p class="battle-detail__value">{{ guild.name }}</p>
            </article>
            <article class="surface p-4">
              <p class="battle-detail__label">{{ t('battles.players') }}</p>
              <p class="battle-detail__value">{{ guild.players }}</p>
            </article>
            <article class="surface p-4">
              <p class="battle-detail__label">{{ t('battles.kills') }}</p>
              <p class="battle-detail__value">{{ guild.kills }}</p>
            </article>
            <article class="surface p-4">
              <p class="battle-detail__label">{{ t('battles.deaths') }}</p>
              <p class="battle-detail__value">{{ guild.deaths }}</p>
            </article>
            <article class="surface p-4">
              <p class="battle-detail__label">{{ t('battles.fame_share') }}</p>
              <p class="battle-detail__value">
                {{ formatDecimal(percentage(guild.kill_fame, detail.total_fame)) }}%
              </p>
            </article>
          </section>
        }

        <section class="mt-5 grid gap-4 xl:grid-cols-2">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.guild_fame_vs_fight') }}</h2>
            <svg
              class="battle-detail__donut"
              viewBox="0 0 42 42"
              role="img"
              aria-label="Guild fame share chart"
            >
              <circle
                cx="21"
                cy="21"
                r="15.9"
                fill="transparent"
                stroke="var(--color-surface-2)"
                stroke-width="7"
              ></circle>
              <circle
                cx="21"
                cy="21"
                r="15.9"
                fill="transparent"
                stroke="var(--color-primary)"
                stroke-width="7"
                [attr.stroke-dasharray]="donutDashArray(detail)"
                stroke-dashoffset="25"
              ></circle>
              <text x="21" y="22.5" text-anchor="middle">
                {{ formatDecimal(primaryGuildFameShare(detail)) }}%
              </text>
            </svg>
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">{{ t('battles.weapon_presence') }}</h2>
            @for (weapon of weaponChart(); track weapon.type) {
              <div class="battle-detail__weapon-row">
                <img [src]="itemIconUrl(weapon.type)" [alt]="weapon.type" loading="lazy" /><span
                  class="truncate"
                  >{{ weapon.type }}</span
                >
                <div class="battle-detail__bar">
                  <span [style.width.%]="percentage(weapon.count, maxWeaponCount())"></span>
                </div>
                <strong>{{ weapon.count }}</strong>
              </div>
            } @empty {
              <p class="text-sm" style="color: var(--color-text-secondary)">
                {{ t('battles.no_weapon_data') }}
              </p>
            }
          </article>
        </section>
      } @else if (tab() === 'players') {
        <section class="mt-5 grid gap-4 xl:grid-cols-4">
          <article class="surface p-5 xl:col-span-2">
            <h2 class="battle-detail__panel-title">Top player kill fame</h2>
            @for (row of topPlayerFameChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(topPlayerFameChart()))"
                  ></span>
                </div>
                <strong>{{ formatCompact(row.value) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Top player IP</h2>
            @for (row of topPlayerIpChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--players">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(topPlayerIpChart()))"
                  ></span>
                </div>
                <strong>{{ formatDecimal(row.value) }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Deaths by player</h2>
            @for (row of topPlayerDeathsChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--danger">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(topPlayerDeathsChart()))"
                  ></span>
                </div>
                <strong>{{ row.value }}</strong>
              </div>
            }
          </article>
        </section>

        <section class="mt-5 grid gap-4 xl:grid-cols-2">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Our guild silver lost by player</h2>
            @for (row of lossPlayerChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--danger">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(lossPlayerChart()))"
                  ></span>
                </div>
                <strong>{{ formatCompact(row.value) }}</strong>
              </div>
            } @empty {
              <p class="text-sm" style="color: var(--color-text-secondary)">
                No priced equipment lost by our guild members.
              </p>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Loss estimate coverage</h2>
            <p class="battle-detail__value">
              {{
                formatDecimal(
                  percentage(
                    detail.estimated_losses.priced_items,
                    detail.estimated_losses.total_items
                  )
                )
              }}%
            </p>
            <p class="battle-detail__sub">
              {{ detail.estimated_losses.priced_items }} priced of
              {{ detail.estimated_losses.total_items }} equipment items
            </p>
          </article>
        </section>

        <article class="mt-5 surface overflow-hidden">
          <app-data-table
            [columns]="playerColumns"
            [rows]="playerRows()"
            [trackBy]="trackPlayer"
            [pageSize]="12"
          >
            <ng-template dataTableCell="name" let-row>
              <span class="font-medium">{{ row.name }}</span>
            </ng-template>
            <ng-template dataTableCell="guild_name" let-row>
              {{ row.guild_name || t('common.none') }}
            </ng-template>
            <ng-template dataTableCell="kill_fame" let-row>
              {{ formatCompact(row.kill_fame) }}
            </ng-template>
            <ng-template dataTableCell="death_fame" let-row>
              {{ formatCompact(row.death_fame) }}
            </ng-template>
            <ng-template dataTableCell="item_power" let-row>
              {{ formatDecimal(row.item_power) }}
            </ng-template>
          </app-data-table>
        </article>
      } @else {
        <section class="mt-5 grid gap-4 xl:grid-cols-3">
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Killer guilds</h2>
            @for (row of killerGuildChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--kills">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(killerGuildChart()))"
                  ></span>
                </div>
                <strong>{{ row.value }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Victim guilds</h2>
            @for (row of victimGuildChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar battle-detail__bar--danger">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(victimGuildChart()))"
                  ></span>
                </div>
                <strong>{{ row.value }}</strong>
              </div>
            }
          </article>
          <article class="surface p-5">
            <h2 class="battle-detail__panel-title">Highest fame kills</h2>
            @for (row of highFameKillChart(); track row.label) {
              <div class="battle-detail__bar-row">
                <span>{{ row.label }}</span>
                <div class="battle-detail__bar">
                  <span
                    [style.width.%]="percentage(row.value, maxMetric(highFameKillChart()))"
                  ></span>
                </div>
                <strong>{{ formatCompact(row.value) }}</strong>
              </div>
            }
          </article>
        </section>

        <article class="mt-5 surface overflow-hidden">
          <app-data-table
            [columns]="killColumns"
            [rows]="killRows()"
            [trackBy]="trackKill"
            [pageSize]="12"
          >
            <ng-template dataTableCell="time" let-row>
              {{ formatTime(row.time) }}
            </ng-template>
            <ng-template dataTableCell="killer" let-row>
              <span class="battle-detail__participant">
                <img [src]="participantWeaponIcon(row, 'killer')" alt="" loading="lazy" />
                <span>
                  <strong>{{ row.killer.name }}</strong>
                  <small>{{ row.killer.guild_name || t('common.none') }}</small>
                </span>
              </span>
            </ng-template>
            <ng-template dataTableCell="victim" let-row>
              <span class="battle-detail__participant">
                <img [src]="participantWeaponIcon(row, 'victim')" alt="" loading="lazy" />
                <span>
                  <strong>{{ row.victim.name }}</strong>
                  <small>{{ row.victim.guild_name || t('common.none') }}</small>
                </span>
              </span>
            </ng-template>
            <ng-template dataTableCell="total_kill_fame" let-row>
              {{ formatCompact(row.total_kill_fame) }}
            </ng-template>
            <ng-template dataTableCell="item_power" let-row>
              {{ formatDecimal(row.killer_item_power) }} →
              {{ formatDecimal(row.victim_item_power) }}
            </ng-template>
            <ng-template dataTableCell="loadout" let-row>
              @if (hasLoadout(row)) {
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  [attr.aria-expanded]="expandedKill() === row.event_id"
                  (click)="toggleKillLoadout(row.event_id)"
                >
                  {{ expandedKill() === row.event_id ? t('battles.hideGear') : t('battles.showGear') }}
                </button>
              } @else {
                <span style="color: var(--color-text-disabled)">—</span>
              }
            </ng-template>
          </app-data-table>

          <!-- What the victim actually lost. The kill feed carries the whole
               loadout; only the weapon used to be shown. -->
          @if (expandedKillDetail(); as kill) {
            <div class="border-t p-4" style="border-color: var(--color-border)">
              <h3 class="eyebrow mb-3">
                {{ t('battles.lostGear') }} — {{ kill.victim.name }}
              </h3>
              <app-equipment-grid [items]="participantLoadout(kill, 'victim')" />
            </div>
          }
        </article>
      }
    }
  `,
  styles: `
    @layer components {
      .battle-detail__hero {
        position: sticky;
        top: 0;
        z-index: 10;
      }
      .battle-detail__label {
        color: var(--color-text-disabled);
        font-size: 0.75rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .battle-detail__value {
        color: var(--color-text);
        font-size: clamp(1.25rem, 2vw, 1.75rem);
        font-weight: 700;
      }
      .battle-detail__sub {
        color: var(--color-text-secondary);
        font-size: 0.75rem;
        margin-top: 0.25rem;
      }
      .battle-detail__panel-title {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
        margin-bottom: 1rem;
      }
      .battle-detail__bar-row,
      .battle-detail__weapon-row {
        align-items: center;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(8rem, 1fr) minmax(8rem, 2fr) auto;
        margin-top: 0.75rem;
      }
      .battle-detail__bar {
        background: var(--color-surface-2);
        border-radius: var(--radius-full);
        height: 0.7rem;
        overflow: hidden;
      }
      .battle-detail__bar span {
        background: var(--color-primary);
        border-radius: inherit;
        display: block;
        height: 100%;
        min-width: 0.25rem;
      }
      .battle-detail__bar--kills span {
        background: var(--color-warning);
      }
      .battle-detail__bar--danger span {
        background: var(--color-danger);
      }
      .battle-detail__bar--players span {
        background: var(--color-success);
      }
      .battle-detail__bar--timeline span {
        background: var(--color-primary);
      }
      .battle-detail__table-header {
        align-items: center;
        border-bottom: 1px solid var(--color-border);
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: space-between;
        padding: 1rem;
      }
      .battle-detail__table-header h2 {
        color: var(--color-text);
        font-size: 1rem;
        font-weight: 700;
      }
      .battle-detail__filter {
        max-width: 18rem;
      }
      .battle-detail__table-footer {
        align-items: center;
        border-top: 1px solid var(--color-border);
        color: var(--color-text-secondary);
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        justify-content: flex-end;
        padding: 0.75rem 1rem;
      }
      .battle-detail__donut {
        display: block;
        height: 14rem;
        margin: 0 auto;
        max-width: 14rem;
        width: 100%;
      }
      .battle-detail__donut text {
        fill: var(--color-text);
        font-size: 0.32rem;
        font-weight: 700;
      }
      .battle-detail__weapon-row {
        grid-template-columns: 2rem minmax(6rem, 1fr) minmax(8rem, 2fr) auto;
      }
      .battle-detail__weapon-row img,
      .battle-detail__participant img {
        background: var(--color-surface-2);
        border-radius: var(--radius-sm);
        height: 2rem;
        object-fit: contain;
        width: 2rem;
      }
      .battle-detail__participant {
        align-items: center;
        display: inline-flex;
        gap: 0.5rem;
        min-width: 12rem;
      }
      .battle-detail__participant small {
        color: var(--color-text-secondary);
        display: block;
        font-size: 0.75rem;
      }
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
  /** Kill whose loadout is expanded, by upstream event id. */
  protected readonly expandedKill = signal<number | null>(null);

  protected readonly loading = signal(false);
  protected readonly tab = signal<DetailTab>('fight');

  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'fight', label: this.t('battles.fight_info') },
    { id: 'guild', label: this.t('battles.guild_info') },
    { id: 'players', label: this.t('battles.players') },
    { id: 'timeline', label: this.t('battles.timeline') },
  ]);
  protected readonly weaponChart = computed(() => this.buildWeaponChart());
  protected readonly maxWeaponCount = computed(() =>
    Math.max(...this.weaponChart().map((weapon) => weapon.count), 0),
  );
  protected readonly battleKpiCards = computed<BattleKpiCard[]>(() => {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    const deaths = this.totalDeaths(detail.guilds);
    const durationMinutes = this.durationMinutes(detail);
    const averageIp = this.average(detail.players.map((player) => player.item_power));
    const totalDeathFame = detail.players.reduce((sum, player) => sum + player.death_fame, 0);
    const weaponCount = this.weaponChart().length;
    const killFamePerKill = detail.total_kills > 0 ? detail.total_fame / detail.total_kills : 0;
    return [
      { label: 'Kill fame / kill', value: this.formatCompact(killFamePerKill) },
      {
        label: 'Kills / minute',
        value: this.formatDecimal(this.safeDivide(detail.total_kills, durationMinutes)),
      },
      {
        label: 'Deaths / minute',
        value: this.formatDecimal(this.safeDivide(deaths, durationMinutes)),
      },
      { label: 'Avg item power', value: this.formatDecimal(averageIp) },
      {
        label: 'Death fame',
        value: this.formatCompact(totalDeathFame),
        sub: 'Modeled from players',
      },
      { label: 'Weapons seen', value: String(weaponCount), sub: 'From kill feed equipment' },
      {
        label: 'Players / guild',
        value: this.formatDecimal(this.safeDivide(detail.total_players, detail.guilds.length)),
      },
      { label: 'Fight duration', value: this.formatDuration(detail) },
    ];
  });

  // Guild table columns and data
  protected readonly guildColumns: readonly DataTableColumn<BattleGuildSummary>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (guild) => guild.name || '',
      comparator: (a, b) => (a.name || '').localeCompare(b.name || ''),
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
      key: 'kill_fame',
      label: 'battles.fame',
      sortable: true,
      accessor: (guild) => guild.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
    {
      key: 'kill_death',
      label: 'battles.kill_death',
      sortable: true,
      accessor: (guild) =>
        guild.deaths === 0 ? (guild.kills > 0 ? Infinity : 0) : guild.kills / guild.deaths,
      comparator: (a, b) => {
        const aRatio = a.deaths === 0 ? (a.kills > 0 ? Infinity : 0) : a.kills / a.deaths;
        const bRatio = b.deaths === 0 ? (b.kills > 0 ? Infinity : 0) : b.kills / b.deaths;
        return aRatio - bRatio;
      },
      align: 'right',
    },
  ];

  protected readonly guildRows = computed(() => {
    const detail = this.battle();
    return detail ? this.sortedGuilds(detail.guilds) : [];
  });

  protected readonly trackGuild = (guild: BattleGuildSummary): unknown => this.guildKey(guild);

  // Player table columns and data
  protected readonly playerColumns: readonly DataTableColumn<BattlePlayer>[] = [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (player) => player.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'guild_name',
      label: 'battles.guild',
      sortable: true,
      searchable: true,
      accessor: (player) => player.guild_name || '',
      comparator: (a, b) => (a.guild_name || '').localeCompare(b.guild_name || ''),
    },
    {
      key: 'kills',
      label: 'battles.kills',
      sortable: true,
      accessor: (player) => player.kills,
      comparator: (a, b) => a.kills - b.kills,
      align: 'right',
    },
    {
      key: 'deaths',
      label: 'battles.deaths',
      sortable: true,
      accessor: (player) => player.deaths,
      comparator: (a, b) => a.deaths - b.deaths,
      align: 'right',
    },
    {
      key: 'kill_fame',
      label: 'battles.kill_fame',
      sortable: true,
      accessor: (player) => player.kill_fame,
      comparator: (a, b) => a.kill_fame - b.kill_fame,
      align: 'right',
    },
    {
      key: 'death_fame',
      label: 'battles.death_fame',
      sortable: true,
      accessor: (player) => player.death_fame,
      comparator: (a, b) => a.death_fame - b.death_fame,
      align: 'right',
    },
    {
      key: 'item_power',
      label: 'battles.item_power',
      sortable: true,
      accessor: (player) => player.item_power,
      comparator: (a, b) => a.item_power - b.item_power,
      align: 'right',
    },
  ];

  protected readonly playerRows = computed(() => {
    const detail = this.battle();
    return detail ? [...detail.players] : [];
  });

  protected readonly trackPlayer = (player: BattlePlayer): unknown => player.id || player.name;

  // Kill table columns and data
  protected readonly killColumns: readonly DataTableColumn<BattleKillEvent>[] = [
    {
      key: 'time',
      label: 'common.date',
      sortable: true,
      accessor: (kill) => kill.time,
      comparator: (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    },
    {
      key: 'killer',
      label: 'battles.killer',
      sortable: true,
      searchable: true,
      accessor: (kill) => `${kill.killer.name} ${kill.killer.guild_name ?? ''}`,
      comparator: (a, b) => a.killer.name.localeCompare(b.killer.name),
    },
    {
      key: 'victim',
      label: 'battles.victim',
      sortable: true,
      searchable: true,
      accessor: (kill) => `${kill.victim.name} ${kill.victim.guild_name ?? ''}`,
      comparator: (a, b) => a.victim.name.localeCompare(b.victim.name),
    },
    {
      key: 'total_kill_fame',
      label: 'battles.fame',
      sortable: true,
      accessor: (kill) => kill.total_kill_fame,
      comparator: (a, b) => a.total_kill_fame - b.total_kill_fame,
      align: 'right',
    },
    {
      key: 'item_power',
      label: 'battles.item_power',
      sortable: true,
      accessor: (kill) => `${kill.killer_item_power} → ${kill.victim_item_power}`,
      comparator: (a, b) => a.killer_item_power - b.killer_item_power,
      align: 'right',
    },
    {
      key: 'loadout',
      label: 'battles.gear',
      sortable: false,
      accessor: () => '',
      align: 'right',
    },
  ];

  /** The kill currently expanded in the timeline, if it is still on the page. */
  protected readonly expandedKillDetail = computed(() => {
    const id = this.expandedKill();
    return id === null ? null : (this.killRows().find((kill) => kill.event_id === id) ?? null);
  });

  protected readonly killRows = computed(() => {
    const detail = this.battle();
    return detail ? detail.kills : [];
  });

  protected readonly trackKill = (kill: BattleKillEvent): unknown => kill.event_id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  /** Returns to the battle list without relying on browser history state. */
  protected backToBattles(): void {
    void this.router.navigate(['/battles']);
  }

  /** Switches between fight-wide and guild-specific analytics. */
  protected switchTab(tab: string): void {
    if (isDetailTab(tab)) {
      this.tab.set(tab);
    }
  }

  /** Formats local date/time according to the browser locale. */
  protected formatDate(isoDate: string): string {
    return new Date(isoDate).toLocaleString();
  }

  /** Formats local time for compact kill-feed rows. */
  protected formatTime(isoDate: string): string {
    return new Date(isoDate).toLocaleTimeString();
  }

  /** Formats kill/death efficiency for guild table cells. */
  protected formatGuildKDRatio(kills: number, deaths: number): string {
    return this.formatRatio(kills, deaths);
  }

  /** Formats exact integer metrics with locale separators. */
  protected formatAmount(value: number): string {
    return value.toLocaleString();
  }

  /** Makes large fame values readable in charts and tables. */
  protected formatCompact(value: number): string {
    return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
      value,
    );
  }

  /** Avoids noisy precision from upstream decimal item-power values. */
  protected formatDecimal(value: number): string {
    return Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  }

  /** Presents kill/death efficiency while protecting against division by zero. */
  protected formatRatio(kills: number, deaths: number): string {
    return deaths === 0 ? (kills > 0 ? '∞' : '0') : this.formatDecimal(kills / deaths);
  }

  /** Calculates duration from server timestamps with a safe fallback. */
  protected formatDuration(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): string {
    const milliseconds =
      new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return this.t('battles.duration_unknown');
    }
    return `${Math.max(1, Math.round(milliseconds / 60000))}m`;
  }

  /** Provides a stable track key when AlbionBB omits guild ids. */
  protected guildKey(guild: BattleGuildSummary): string {
    return guild.id || guild.name;
  }

  /** Finds the winning or highest-fame guild. */
  protected winnerGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.winner) ?? this.sortedGuilds(battle.guilds)[0] ?? null
    );
  }

  /** Selects Weaklings when visible, otherwise falls back to the winner. */
  protected primaryGuild(battle: Pick<BattleSummary, 'guilds'>): BattleGuildSummary | null {
    return (
      battle.guilds.find((guild) => guild.name.toLowerCase() === 'weaklings') ??
      this.winnerGuild(battle)
    );
  }

  /** Computes the selected guild fame share for the donut chart. */
  protected primaryGuildFameShare(battle: BattleSummary): number {
    const guild = this.primaryGuild(battle);
    return guild ? this.percentage(guild.kill_fame, battle.total_fame) : 0;
  }

  /** Provides Angular-safe SVG donut segments for the selected guild share. */
  protected donutDashArray(battle: BattleSummary): string {
    const share = this.primaryGuildFameShare(battle);
    return `${share} ${100 - share}`;
  }

  /** Sorts guilds by fame without mutating signal-owned arrays. */
  protected sortedGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return [...guilds].sort((leftGuild, rightGuild) => rightGuild.kill_fame - leftGuild.kill_fame);
  }

  /** Limits chart rows to avoid unreadable long legends. */
  protected chartGuilds(guilds: readonly BattleGuildSummary[]): BattleGuildSummary[] {
    return this.sortedGuilds(guilds).slice(0, CHART_LIMIT);
  }

  /** Aggregates deaths across guild rows. */
  protected totalDeaths(guilds: readonly BattleGuildSummary[]): number {
    return guilds.reduce((totalDeaths, guild) => totalDeaths + guild.deaths, 0);
  }

  /** Returns the max guild fame for proportional bars. */
  protected maxGuildFame(guilds: readonly BattleGuildSummary[]): number {
    return Math.max(...guilds.map((guild) => guild.kill_fame), 0);
  }

  /** Returns the max guild kills for proportional bars. */
  protected maxGuildKills(guilds: readonly BattleGuildSummary[]): number {
    return Math.max(...guilds.map((guild) => guild.kills), 0);
  }

  protected maxGuildDeaths(guilds: readonly BattleGuildSummary[]): number {
    return Math.max(...guilds.map((guild) => guild.deaths), 0);
  }

  protected maxMetric(rows: readonly BattleChartMetric[]): number {
    return Math.max(...rows.map((row) => row.value), 0);
  }

  protected famePerPlayerChart(): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    return this.chartGuilds(detail.guilds).map((guild) => ({
      label: guild.name || this.t('common.none'),
      value: this.safeDivide(guild.kill_fame, guild.players),
    }));
  }

  protected guildKdChart(): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    return this.chartGuilds(detail.guilds).map((guild) => ({
      label: guild.name || this.t('common.none'),
      value: this.safeDivide(guild.kills, guild.deaths || 1),
    }));
  }

  protected guildPlayerShareChart(): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    return this.chartGuilds(detail.guilds).map((guild) => ({
      label: guild.name || this.t('common.none'),
      value: this.percentage(guild.players, detail.total_players),
    }));
  }

  protected killMinuteChart(): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail || detail.kills.length === 0) {
      return [];
    }
    const start = new Date(detail.start_time).getTime();
    const buckets = new Map<string, number>();
    for (const kill of detail.kills) {
      const minute = Math.max(0, Math.floor((new Date(kill.time).getTime() - start) / 60000));
      const label = `${minute}m`;
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
    }
    return Array.from(buckets.entries())
      .map(([label, value]) => ({ label, value }))
      .slice(0, 12);
  }

  protected topPlayerFameChart(): BattleChartMetric[] {
    return this.topPlayersBy((player) => player.kill_fame);
  }

  protected topPlayerIpChart(): BattleChartMetric[] {
    return this.topPlayersBy((player) => player.item_power);
  }

  protected topPlayerDeathsChart(): BattleChartMetric[] {
    return this.topPlayersBy((player) => player.deaths);
  }

  protected killerGuildChart(): BattleChartMetric[] {
    return this.groupKillsByGuild('killer');
  }

  protected victimGuildChart(): BattleChartMetric[] {
    return this.groupKillsByGuild('victim');
  }

  protected highFameKillChart(): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    return [...detail.kills]
      .sort((left, right) => right.total_kill_fame - left.total_kill_fame)
      .slice(0, CHART_LIMIT)
      .map((kill) => ({
        label: `${kill.killer.name} → ${kill.victim.name}`,
        value: kill.total_kill_fame,
      }));
  }

  protected lossGuildChart(): BattleChartMetric[] {
    return (this.battle()?.estimated_losses.guilds ?? [])
      .slice(0, CHART_LIMIT)
      .map((guild) => ({ label: guild.guild_name, value: guild.estimated_loss }));
  }

  protected lossPlayerChart(): BattleChartMetric[] {
    return (this.battle()?.estimated_losses.players ?? [])
      .slice(0, CHART_LIMIT)
      .map((player) => ({ label: player.player_name, value: player.estimated_loss }));
  }

  /** Converts values into bounded percentages for CSS/SVG chart dimensions. */
  protected percentage(value: number, total: number): number {
    return total <= 0 ? 0 : Math.min(100, Math.max(0, (value / total) * 100));
  }

  /** Builds a public Albion item render URL from an upstream equipment type. */
  protected itemIconUrl(itemType: string): string {
    return `${ALBION_RENDER_ITEM_BASE_URL}/${encodeURIComponent(itemType)}.png`;
  }

  /** Extracts participant weapon icon from AlbionBB raw equipment data. */
  protected participantWeaponIcon(kill: BattleKillEvent, side: KillSide): string {
    return this.itemIconUrl(this.extractWeaponType(kill.raw, side) ?? 'T4_MAIN_SWORD');
  }

  private durationMinutes(battle: Pick<BattleSummary, 'start_time' | 'end_time'>): number {
    const milliseconds =
      new Date(battle.end_time).getTime() - new Date(battle.start_time).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      return 1;
    }
    return Math.max(1, milliseconds / 60000);
  }

  private safeDivide(value: number, denominator: number): number {
    if (denominator <= 0 || !Number.isFinite(denominator)) {
      return 0;
    }
    return value / denominator;
  }

  private average(values: readonly number[]): number {
    const validValues = values.filter((value) => Number.isFinite(value) && value > 0);
    if (validValues.length === 0) {
      return 0;
    }
    return validValues.reduce((sum, value) => sum + value, 0) / validValues.length;
  }

  private topPlayersBy(selector: (player: BattlePlayer) => number): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    return [...detail.players]
      .sort((left, right) => selector(right) - selector(left))
      .slice(0, CHART_LIMIT)
      .map((player) => ({ label: player.name, value: selector(player) }));
  }

  private groupKillsByGuild(side: KillSide): BattleChartMetric[] {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const kill of detail.kills) {
      const participant = side === 'killer' ? kill.killer : kill.victim;
      const label = participant.guild_name || this.t('common.none');
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((left, right) => right.value - left.value)
      .slice(0, CHART_LIMIT);
  }

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

  /** Counts weapon occurrences from modeled raw kill-feed equipment. */
  private buildWeaponChart(): Array<{ readonly type: string; readonly count: number }> {
    const detail = this.battle();
    if (!detail) {
      return [];
    }
    const counts = new Map<string, number>();
    for (const kill of detail.kills) {
      for (const side of ['killer', 'victim'] as const) {
        const weaponType = this.extractWeaponType(kill.raw, side);
        if (!weaponType) {
          continue;
        }
        counts.set(weaponType, (counts.get(weaponType) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((leftWeapon, rightWeapon) => rightWeapon.count - leftWeapon.count)
      .slice(0, CHART_LIMIT);
  }

  /**
   * Reads a participant's whole loadout out of the raw kill payload.
   *
   * The backend preserves the upstream kill event verbatim precisely so the
   * frontend can render fields it did not model; until now only the main hand
   * was read, and the other nine slots — the bulk of what a death actually
   * costs — were discarded. Slot keys are mapped to the same vocabulary builds
   * use, so the existing equipment grid renders it unchanged.
   */
  protected participantLoadout(kill: BattleKillEvent, side: KillSide): BuildItemSlot[] {
    const participantKey = side === 'killer' ? 'Killer' : 'Victim';
    const participant =
      this.readObject(kill.raw, participantKey) ??
      this.readObject(kill.raw, participantKey.toLowerCase());
    const equipment =
      this.readObject(participant, 'Equipment') ?? this.readObject(participant, 'equipment');
    if (!equipment) {
      return [];
    }

    const items: BuildItemSlot[] = [];
    for (const [upstreamKey, slot] of Object.entries(EQUIPMENT_SLOTS)) {
      const entry =
        this.readObject(equipment, upstreamKey) ??
        this.readObject(equipment, upstreamKey.charAt(0).toLowerCase() + upstreamKey.slice(1));
      const type = this.readString(entry, 'Type') ?? this.readString(entry, 'type');
      if (!type?.trim()) {
        continue;
      }
      items.push({
        slot,
        openalbion_item_type: slot,
        // The upstream payload carries no numeric id; the grid keys on the
        // slot, so a stable placeholder is enough.
        openalbion_item_id: 0,
        openalbion_item_name: type,
        openalbion_item_icon: this.itemIconUrl(type),
        openalbion_item_tier: null,
      });
    }
    return items;
  }

  /** Whether a kill carries enough equipment detail to be worth expanding. */
  protected hasLoadout(kill: BattleKillEvent): boolean {
    return this.participantLoadout(kill, 'victim').length > 0;
  }

  protected toggleKillLoadout(eventId: number): void {
    this.expandedKill.update((current) => (current === eventId ? null : eventId));
  }

  /** Reads nested `Killer/Victim -> Equipment -> MainHand -> Type` safely from raw JSON. */
  private extractWeaponType(raw: unknown, side: KillSide): string | null {
    const participantKey = side === 'killer' ? 'Killer' : 'Victim';
    const participant =
      this.readObject(raw, participantKey) ?? this.readObject(raw, participantKey.toLowerCase());
    const equipment =
      this.readObject(participant, 'Equipment') ?? this.readObject(participant, 'equipment');
    const mainHand =
      this.readObject(equipment, 'MainHand') ??
      this.readObject(equipment, 'mainHand') ??
      this.readObject(equipment, 'main_hand');
    const type = this.readString(mainHand, 'Type') ?? this.readString(mainHand, 'type');
    return type && type.trim().length > 0 ? type : null;
  }

  /** Returns an object property only when the runtime JSON shape matches. */
  private readObject(source: unknown, key: string): RawObject | null {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const value = (source as RawObject)[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as RawObject)
      : null;
  }

  /** Returns a string property only when the runtime JSON shape matches. */
  private readString(source: unknown, key: string): string | null {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const value = (source as RawObject)[key];
    return typeof value === 'string' ? value : null;
  }
}
