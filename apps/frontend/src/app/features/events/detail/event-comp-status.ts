import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type {
  EventRosterParticipant,
  EventRosterSeat,
  ParticipantWeapon,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon, type IconName } from '../../../shared/components/icon/icon';
import {
  albionCombatIconUrl,
  normalizeAlbionEquipmentName,
} from '../../../shared/data/albion-equipment-catalog';
import { weaponFit } from '../../../shared/data/user-weapons';
import {
  carriedWeaponGroups,
  compAdvice,
  seatedFitCounts,
  WEAPON_FIT_CHIP,
  WEAPON_FIT_ORDER,
  type CarriedWeapon,
  type CompAdvice,
} from './comp-status';
import { groupSeatsByRole, roleColorVar, roleLabelKey } from './roster-lobby';

/** One board party as the panel needs it: its heading and its seats. */
export interface CompStatusParty {
  readonly partyNumber: number;
  readonly heading: string;
  readonly seats: readonly EventRosterSeat[];
}

/** The member an officer is dragging or moving. */
export interface CarriedMember {
  readonly username: string;
  readonly weapons: readonly ParticipantWeapon[];
}

/** Advice entries shown before "and N more". */
const ADVICE_LIMIT = 8;

/**
 * Side panel of the Parties board: how full the comp is per role, how well the seated players
 * fit their weapons, each party's state and what to fix next. While an officer drags or moves a
 * player it opens with that player's weapon levels.
 */
@Component({
  selector: 'app-event-comp-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <aside class="comp-status" [attr.aria-label]="t('events.compStatus.title')">
      @if (carried(); as member) {
        <section class="comp-status__carried" aria-live="polite">
          <p class="comp-status__eyebrow">{{ t('events.compStatus.moving') }}</p>
          <p class="comp-status__carried-name">{{ member.username }}</p>
          <p class="comp-status__hint">{{ t('events.compStatus.movingHint') }}</p>
          @if (carriedLevels().length > 0) {
            <dl class="comp-status__levels">
              @for (level of carriedLevels(); track level.key) {
                <div class="comp-status__level">
                  <dt>
                    <span class="chip" [class]="'chip chip--' + level.tone">
                      @if (level.icon) {
                        <app-icon [name]="level.icon" size="0.6875rem" />
                      }
                      {{ t(level.labelKey) }}
                    </span>
                  </dt>
                  <dd>
                    <ul class="comp-status__weapons">
                      @for (weapon of level.weapons; track weapon.key) {
                        <li>
                          <img [src]="weaponIcon(weapon)" alt="" loading="lazy" />
                          <span>{{ weapon.name }}</span>
                        </li>
                      }
                    </ul>
                  </dd>
                </div>
              }
            </dl>
          } @else {
            <p class="comp-status__hint">{{ t('weapons.fit.noDeclarations') }}</p>
          }
          <p class="comp-status__carried-fits">
            {{ t('events.compStatus.openFits', { count: carriedOpenFits() }) }}
          </p>
        </section>
      }

      <header class="comp-status__head">
        <h3 class="comp-status__title">{{ t('events.compStatus.title') }}</h3>
        <p class="comp-status__totals">
          <span class="font-mono">{{ t('events.lobby.seatsCount', { filled: filled(), total: total() }) }}</span>
          <span>· {{ t('events.compStatus.waiting', { count: bench().length }) }}</span>
        </p>
        <div class="comp-status__meter" aria-hidden="true">
          <span [style.width.%]="percent(filled(), total())"></span>
        </div>
      </header>

      @if (roles().length > 0) {
        <section class="comp-status__section">
          <h4 class="comp-status__subtitle">{{ t('events.compStatus.roles') }}</h4>
          <ul class="comp-status__roles">
            @for (role of roles(); track role.role) {
              <li class="comp-status__role" [style.--role-accent]="roleAccent(role.role)">
                <span class="comp-status__role-name">{{ roleName(role.role) }}</span>
                <span class="comp-status__role-bar" aria-hidden="true">
                  <span [style.width.%]="percent(role.filled, role.total)"></span>
                </span>
                <span class="font-mono">{{ role.filled }}/{{ role.total }}</span>
              </li>
            }
          </ul>
        </section>
      }

      @if (fitTotal() > 0) {
        <section class="comp-status__section">
          <h4 class="comp-status__subtitle">{{ t('events.compStatus.levels') }}</h4>
          <div class="comp-status__stack" aria-hidden="true">
            @for (row of fitRows(); track row.fit) {
              <span [class]="'comp-status__stack-part tone-' + row.tone" [style.flex-grow]="row.count"></span>
            }
          </div>
          <ul class="comp-status__legend">
            @for (row of fitRows(); track row.fit) {
              <li>
                <span class="chip" [class]="'chip chip--' + row.tone">
                  @if (row.icon) {
                    <app-icon [name]="row.icon" size="0.6875rem" />
                  }
                  {{ t(row.labelKey) }}
                </span>
                <span class="font-mono">{{ row.count }}</span>
              </li>
            }
          </ul>
        </section>
      }

      @if (partyRows().length > 1) {
        <section class="comp-status__section">
          <h4 class="comp-status__subtitle">{{ t('events.compStatus.parties') }}</h4>
          <ul class="comp-status__parties">
            @for (party of partyRows(); track party.partyNumber) {
              <li>
                <button type="button" class="comp-status__party" (click)="revealParty.emit(party.partyNumber)">
                  <span class="comp-status__party-name">{{ party.heading }}</span>
                  @if (party.issues > 0) {
                    <span class="chip chip--warning">
                      <app-icon name="alert" size="0.6875rem" />
                      {{ party.issues }}
                    </span>
                  }
                  <span class="font-mono comp-status__party-count">{{ party.filled }}/{{ party.total }}</span>
                </button>
              </li>
            }
          </ul>
        </section>
      }

      <section class="comp-status__section">
        <h4 class="comp-status__subtitle">{{ t('events.compStatus.advice') }}</h4>
        @if (advice().length === 0) {
          <p class="comp-status__ok">
            <app-icon name="check" size="0.875rem" />
            {{ total() > 0 && filled() === total() ? t('events.compStatus.allGood') : t('events.compStatus.noAdvice') }}
          </p>
        } @else {
          <ul class="comp-status__advice">
            @for (item of visibleAdvice(); track $index) {
              <li class="advice" [class]="'advice advice--' + adviceTone(item)">
                <app-icon [name]="adviceIcon(item)" size="0.875rem" />
                <p class="advice__text">{{ adviceText(item) }}</p>
                <div class="advice__actions">
                  @if (item.kind === 'bench_match' && canManage()) {
                    <button
                      type="button"
                      class="btn btn--primary btn--sm"
                      [disabled]="busy()"
                      (click)="place.emit({ userId: item.userId, seat: item.seat })"
                      [attr.aria-label]="t('events.compStatus.placeLabel', { name: item.username, party: partyName(item.seat.party_number), position: item.seat.position })"
                    >
                      {{ t('events.compStatus.place') }}
                    </button>
                  }
                  @if (adviceSeatKey(item); as seatKey) {
                    <button
                      type="button"
                      class="advice__show"
                      (click)="revealSeat.emit(seatKey)"
                      [attr.aria-label]="t('events.compStatus.show')"
                    >
                      <app-icon name="arrow-right" size="0.875rem" />
                    </button>
                  } @else if (item.kind === 'missing_role') {
                    <button
                      type="button"
                      class="advice__show"
                      (click)="revealParty.emit(item.partyNumber)"
                      [attr.aria-label]="t('events.compStatus.show')"
                    >
                      <app-icon name="arrow-right" size="0.875rem" />
                    </button>
                  }
                </div>
              </li>
            }
          </ul>
          @if (hiddenAdvice() > 0) {
            <p class="comp-status__hint">{{ t('events.compStatus.more', { count: hiddenAdvice() }) }}</p>
          }
        }
      </section>
    </aside>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .comp-status {
      display: grid;
      gap: 0.875rem;
      padding: 0.875rem;
      border: 1px solid var(--color-border);
      border-top: 4px solid var(--color-primary);
      border-radius: var(--radius-cards);
      background: var(--color-surface);
    }
    .comp-status__carried {
      display: grid;
      gap: 0.375rem;
      padding: 0.75rem;
      border: 1px solid var(--color-primary);
      border-radius: var(--radius-smallcards);
      background: var(--color-primary-container);
    }
    .comp-status__eyebrow,
    .comp-status__subtitle {
      font-size: 0.75rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .comp-status__carried-name {
      font-size: 0.9375rem;
      font-weight: 800;
      color: var(--color-text);
    }
    .comp-status__hint {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .comp-status__carried-fits {
      font-size: 0.75rem;
      font-weight: 700;
      color: var(--color-text);
    }
    .comp-status__levels {
      display: grid;
      gap: 0.5rem;
    }
    .comp-status__level {
      display: grid;
      gap: 0.25rem;
    }
    .comp-status__weapons {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.625rem;
    }
    .comp-status__weapons li {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .comp-status__weapons img {
      width: 1.5rem;
      height: 1.5rem;
      object-fit: contain;
    }
    .comp-status__head {
      display: grid;
      gap: 0.375rem;
    }
    .comp-status__title {
      font-family: var(--font-display);
      font-size: 0.875rem;
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--color-text);
    }
    .comp-status__totals {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .comp-status__meter,
    .comp-status__role-bar {
      height: 0.375rem;
      overflow: hidden;
      border-radius: var(--radius-full);
      background: var(--color-surface-2, var(--color-surface-muted));
    }
    .comp-status__meter > span,
    .comp-status__role-bar > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--color-success);
      transition: width 300ms ease;
    }
    .comp-status__section {
      display: grid;
      gap: 0.5rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--color-border);
    }
    .comp-status__roles {
      display: grid;
      gap: 0.375rem;
    }
    .comp-status__role {
      display: grid;
      grid-template-columns: 5.5rem minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .comp-status__role-name {
      overflow: hidden;
      font-weight: 700;
      color: var(--role-accent);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .comp-status__role-bar > span {
      background: var(--role-accent);
    }
    .comp-status__stack {
      display: flex;
      height: 0.5rem;
      gap: 2px;
      overflow: hidden;
      border-radius: var(--radius-full);
    }
    .comp-status__stack-part {
      flex-basis: 0;
      min-width: 4px;
    }
    .tone-success {
      background: var(--color-success);
    }
    .tone-info {
      background: var(--color-info);
    }
    .tone-neutral {
      background: var(--color-border-strong);
    }
    .tone-warning {
      background: var(--color-warning);
    }
    .tone-error {
      background: var(--color-error);
    }
    .comp-status__legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem 0.75rem;
    }
    .comp-status__legend li {
      display: inline-flex;
      align-items: center;
      gap: 0.3125rem;
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .comp-status__parties {
      display: grid;
      gap: 0.25rem;
    }
    .comp-status__party {
      display: flex;
      width: 100%;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0.5rem;
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
      color: var(--color-text);
      text-align: left;
      transition: background-color var(--motion-fast);
    }
    .comp-status__party:hover {
      background: var(--color-surface-hover);
    }
    .comp-status__party:focus-visible,
    .advice__show:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .comp-status__party-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .comp-status__party-count {
      color: var(--color-text-secondary);
    }
    .comp-status__ok {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      font-size: 0.8125rem;
      color: var(--color-success);
    }
    .comp-status__advice {
      display: grid;
      gap: 0.375rem;
    }
    .advice {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      gap: 0.5rem;
      padding: 0.5rem;
      border: 1px solid var(--color-border);
      border-left: 3px solid var(--advice-accent, var(--color-border-strong));
      border-radius: var(--radius-smallcards);
      background: var(--color-surface-1, var(--color-bg));
      color: var(--advice-accent, var(--color-text-secondary));
    }
    .advice--error {
      --advice-accent: var(--color-error);
    }
    .advice--warning {
      --advice-accent: var(--color-warning);
    }
    .advice--success {
      --advice-accent: var(--color-success);
    }
    .advice--info {
      --advice-accent: var(--color-info);
    }
    .advice__text {
      font-size: 0.8125rem;
      line-height: 1.35;
      color: var(--color-text);
    }
    .advice__actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .advice__show {
      display: inline-flex;
      width: 1.75rem;
      height: 1.75rem;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-md);
      color: var(--color-text-secondary);
    }
    .advice__show:hover {
      background: var(--color-surface-active);
      color: var(--color-text);
    }
    @media (prefers-reduced-motion: reduce) {
      .comp-status__meter > span,
      .comp-status__role-bar > span,
      .comp-status__party {
        transition: none;
      }
    }
  `,
})
export class EventCompStatus {
  private readonly translate = inject(TranslateService);

  readonly parties = input.required<readonly CompStatusParty[]>();
  readonly bench = input.required<readonly EventRosterParticipant[]>();
  readonly carried = input<CarriedMember | null>(null);
  readonly canManage = input(false);
  readonly busy = input(false);

  readonly revealSeat = output<string>();
  readonly revealParty = output<number>();
  readonly place = output<{ userId: number; seat: EventRosterSeat }>();

  protected readonly seats = computed(() => this.parties().flatMap((party) => party.seats));
  protected readonly total = computed(() => this.seats().length);
  protected readonly filled = computed(
    () => this.seats().filter((seat) => seat.participant !== null).length,
  );
  protected readonly roles = computed(() => groupSeatsByRole(this.seats()));

  private readonly fitCounts = computed(() => seatedFitCounts(this.seats()));
  protected readonly fitRows = computed(() =>
    WEAPON_FIT_ORDER.filter((fit) => this.fitCounts()[fit] > 0).map((fit) => ({
      fit,
      count: this.fitCounts()[fit],
      ...WEAPON_FIT_CHIP[fit],
    })),
  );
  protected readonly fitTotal = computed(() =>
    this.fitRows().reduce((sum, row) => sum + row.count, 0),
  );

  protected readonly partyRows = computed(() =>
    this.parties().map((party) => ({
      partyNumber: party.partyNumber,
      heading: party.heading,
      total: party.seats.length,
      filled: party.seats.filter((seat) => seat.participant !== null).length,
      issues: party.seats.filter((seat) => {
        if (!seat.participant) return false;
        const fit = weaponFit(seat.participant.weapons, seat.weapon_key);
        return fit === 'locked' || fit === 'not_declared';
      }).length,
    })),
  );

  protected readonly advice = computed(() => compAdvice(this.seats(), this.bench()));
  protected readonly visibleAdvice = computed(() => this.advice().slice(0, ADVICE_LIMIT));
  protected readonly hiddenAdvice = computed(() =>
    Math.max(0, this.advice().length - ADVICE_LIMIT),
  );

  protected readonly carriedLevels = computed(() => {
    const member = this.carried();
    if (!member) return [];
    const groups = carriedWeaponGroups(member.weapons, (base) =>
      normalizeAlbionEquipmentName(base),
    );
    return (['main', 'good', 'basic', 'locked'] as const)
      .filter((key) => groups[key].length > 0)
      .map((key) => ({ key, weapons: groups[key], ...WEAPON_FIT_CHIP[key] }));
  });

  /** Open seats the moved member plays at Main or Good. */
  protected readonly carriedOpenFits = computed(() => {
    const member = this.carried();
    if (!member) return 0;
    return this.seats().filter((seat) => {
      if (seat.participant !== null) return false;
      const fit = weaponFit(member.weapons, seat.weapon_key);
      return fit === 'main' || fit === 'good';
    }).length;
  });

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected percent(part: number, whole: number): number {
    return whole > 0 ? Math.round((part / whole) * 100) : 0;
  }

  protected roleAccent(role: string): string {
    return roleColorVar(role);
  }

  protected roleName(role: string): string {
    const key = roleLabelKey(role);
    return key ? this.t(key) : role;
  }

  protected partyName(partyNumber: number): string {
    return this.parties().find((party) => party.partyNumber === partyNumber)?.heading ?? '';
  }

  protected weaponIcon(weapon: CarriedWeapon): string {
    return albionCombatIconUrl(weapon.base);
  }

  protected adviceSeatKey(item: CompAdvice): string | null {
    return 'seat' in item ? item.seat.key : null;
  }

  protected adviceTone(item: CompAdvice): 'error' | 'warning' | 'success' | 'info' {
    switch (item.kind) {
      case 'locked':
        return 'error';
      case 'not_declared':
      case 'missing_role':
        return 'warning';
      case 'bench_match':
        return 'success';
      case 'no_bench':
        return 'info';
    }
  }

  protected adviceIcon(item: CompAdvice): IconName {
    switch (item.kind) {
      case 'locked':
        return 'lock';
      case 'not_declared':
      case 'missing_role':
        return 'alert';
      case 'bench_match':
        return 'sparkles';
      case 'no_bench':
        return 'users';
    }
  }

  protected adviceText(item: CompAdvice): string {
    switch (item.kind) {
      case 'locked':
        return this.t('events.compStatus.adviceLocked', {
          name: item.username,
          build: item.seat.build_name,
          party: this.partyName(item.seat.party_number),
        });
      case 'not_declared':
        return this.t('events.compStatus.adviceNotDeclared', {
          name: item.username,
          build: item.seat.build_name,
          party: this.partyName(item.seat.party_number),
        });
      case 'bench_match':
        return this.t('events.compStatus.adviceBenchMatch', {
          name: item.username,
          level: this.t(WEAPON_FIT_CHIP[item.proficiency].labelKey),
          build: item.seat.build_name,
          party: this.partyName(item.seat.party_number),
        });
      case 'missing_role':
        return this.t('events.compStatus.adviceMissingRole', {
          party: this.partyName(item.partyNumber),
          role: this.roleName(item.role),
        });
      case 'no_bench':
        return this.t('events.compStatus.adviceNoBench', { count: item.openSeats });
    }
  }
}
