import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import type {
  EventParty,
  EventRosterParticipant,
  EventRosterSeat,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Avatar } from '../../../shared/components/avatar/avatar';
import {
  groupSeatsByRole,
  partyForBoardNumber,
  partyHeading,
  seatPartyLabel,
  roleColorVar,
  roleGlyph,
  roleLabelKey,
  type LobbyBuildGroup,
} from './roster-lobby';

/**
 * The member-facing view of the comp: every role, its builds, who holds each seat and how many
 * seats are still open, plus the players still waiting for a seat. Read-only; pressing a build
 * asks the page to show that build's equipment.
 */
@Component({
  selector: 'app-event-role-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar],
  template: `
    <section class="role-board" aria-labelledby="role-board-heading">
      <header class="role-board__head">
        <div class="min-w-0">
          <h2 id="role-board-heading" class="role-board__title">{{ t('events.lobby.roles') }}</h2>
          <p class="role-board__hint">{{ t('events.lobby.rolesHint') }}</p>
        </div>
        <p class="role-board__total">
          <strong>{{ filledSeats() }}</strong><span>/{{ seats().length }}</span>
          <span class="sr-only">{{ t('events.lobby.seatsTaken') }}</span>
        </p>
      </header>

      @if (groups().length > 0) {
        <div class="role-board__grid">
          @for (group of groups(); track group.role) {
            <article class="role-tile" [style.--role-accent]="roleColor(group.role)">
              <header class="role-tile__head">
                <span class="role-tile__glyph" aria-hidden="true">{{ glyph(group.role) }}</span>
                <h3 class="role-tile__name">{{ roleName(group.role) }}</h3>
                <span class="role-tile__count" [class.role-tile__count--full]="group.filled === group.total">
                  @if (group.filled === group.total) {
                    {{ t('events.lobby.full') }}
                  } @else {
                    {{ t('events.lobby.openSeats', { count: group.total - group.filled }) }}
                  }
                </span>
              </header>
              <div class="role-tile__meter" aria-hidden="true">
                <span [style.width.%]="percent(group.filled, group.total)"></span>
              </div>

              <ul class="role-tile__builds">
                @for (build of group.builds; track build.buildId) {
                  <li class="build-line">
                    <button
                      type="button"
                      class="build-line__button"
                      (click)="inspect.emit(build.seats[0])"
                      [attr.aria-label]="t('events.lobby.buildDetails', { build: build.buildName })"
                    >
                      @if (buildIcons().get(build.buildId); as icon) {
                        <img class="build-line__icon" [src]="icon" alt="" loading="lazy" />
                      } @else {
                        <span class="build-line__icon build-line__icon--glyph" aria-hidden="true">
                          {{ glyph(group.role) }}
                        </span>
                      }
                      <span class="build-line__name">{{ build.buildName }}</span>
                      <span class="build-line__count">{{ build.filled }}/{{ build.total }}</span>
                    </button>
                    <ul class="build-line__players" [attr.aria-label]="build.buildName">
                      @for (occupant of occupants(build); track occupant.user_id) {
                        <li
                          class="player-chip"
                          [class.player-chip--you]="occupant.user_id === currentUserId()"
                        >
                          <app-avatar [username]="occupant.username" size="xs" />
                          <span class="player-chip__name">{{ occupant.username }}</span>
                          @if (occupant.partyLabel) {
                            <span class="player-chip__party">{{ occupant.partyLabel }}</span>
                          }
                          @if (occupant.user_id === currentUserId()) {
                            <span class="player-chip__you">{{ t('events.lobby.you') }}</span>
                          }
                        </li>
                      }
                      @if (build.total - build.filled > 0) {
                        <li class="player-chip player-chip--open">
                          {{ t('events.lobby.openSeats', { count: build.total - build.filled }) }}
                        </li>
                      }
                    </ul>
                  </li>
                }
              </ul>
            </article>
          }
        </div>
      } @else {
        <p class="role-board__empty">{{ t('events.detail.no_parties') }}</p>
      }

      <footer class="role-board__waiting" aria-labelledby="role-board-waiting">
        <h3 id="role-board-waiting" class="role-board__waiting-title">
          {{ t('events.lobby.waitingList') }}
          <span class="role-board__waiting-count">{{ bench().length }}</span>
        </h3>
        @if (bench().length > 0) {
          <ul class="role-board__waiting-list">
            @for (member of bench(); track member.user_id) {
              <li
                class="player-chip"
                [class.player-chip--you]="member.user_id === currentUserId()"
              >
                <app-avatar [username]="member.username" size="xs" />
                <span class="player-chip__name">{{ member.username }}</span>
                <span class="player-chip__build">{{ member.primary_build_name }}</span>
              </li>
            }
          </ul>
        } @else {
          <p class="role-board__hint">{{ t('events.lobby.waitingEmpty') }}</p>
        }
      </footer>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .role-board {
      display: grid;
      gap: 1rem;
      padding: 1.25rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface);
    }
    .role-board__head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }
    .role-board__title {
      font-family: var(--font-display);
      font-size: 1rem;
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--color-text);
    }
    .role-board__hint {
      margin-top: 0.125rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .role-board__total {
      flex: none;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .role-board__total strong {
      font-size: 1.5rem;
      color: var(--color-text);
    }
    .role-board__grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
      gap: 0.75rem;
      align-items: start;
    }
    .role-board__empty {
      padding: 1.5rem;
      text-align: center;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .role-tile {
      display: grid;
      align-content: start;
      gap: 0.625rem;
      padding: 0.875rem;
      border: 1px solid var(--color-border);
      border-top: 4px solid var(--role-accent);
      border-radius: var(--radius-smallcards);
      background: var(--color-surface-1, var(--color-bg));
    }
    .role-tile__head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .role-tile__glyph {
      display: inline-flex;
      min-width: 1.75rem;
      height: 1.75rem;
      padding: 0 0.375rem;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-badges);
      background: var(--role-accent);
      color: #fff;
      font-family: var(--font-display);
      font-size: 0.75rem;
      font-weight: 800;
    }
    .role-tile__name {
      flex: 1;
      min-width: 0;
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--color-text);
    }
    .role-tile__count {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .role-tile__count--full {
      color: var(--color-success);
    }
    .role-tile__meter {
      height: 0.375rem;
      overflow: hidden;
      border-radius: var(--radius-full);
      background: var(--color-surface-2, var(--color-surface-muted));
    }
    .role-tile__meter span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--role-accent);
      transition: width 300ms ease;
    }
    .role-tile__builds {
      display: grid;
      gap: 0.625rem;
    }
    .build-line {
      display: grid;
      gap: 0.375rem;
    }
    .build-line__button {
      display: flex;
      width: 100%;
      min-height: 2.75rem;
      align-items: center;
      gap: 0.625rem;
      padding: 0.25rem 0.375rem 0.25rem 0.25rem;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      color: var(--color-text);
      text-align: left;
      transition: background-color var(--motion-fast), border-color var(--motion-fast);
    }
    .build-line__button:hover {
      border-color: var(--color-border);
      background: var(--color-surface-hover);
    }
    .build-line__button:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .build-line__icon {
      width: 2.25rem;
      height: 2.25rem;
      flex: none;
      object-fit: contain;
      border-radius: var(--radius-md);
      background: var(--color-surface-2, var(--color-surface-muted));
    }
    .build-line__icon--glyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.75rem;
      font-weight: 800;
      color: var(--role-accent);
    }
    .build-line__name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-size: 0.8125rem;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .build-line__count {
      flex: none;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .build-line__players,
    .role-board__waiting-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.375rem;
    }
    .build-line__players {
      padding-left: 2.875rem;
    }
    .player-chip {
      display: inline-flex;
      max-width: 100%;
      min-height: 1.75rem;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.625rem 0.125rem 0.125rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-surface);
      font-size: 0.75rem;
      color: var(--color-text);
    }
    .player-chip--you {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .player-chip--open {
      padding: 0.125rem 0.625rem;
      border-style: dashed;
      background: transparent;
      color: var(--color-text-secondary);
    }
    .player-chip__name {
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .player-chip__party {
      font-size: 0.625rem;
      font-weight: 700;
      color: var(--color-text-secondary);
    }
    .player-chip__you {
      font-size: 0.625rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-primary);
    }
    .player-chip__build {
      color: var(--color-text-secondary);
    }
    .role-board__waiting {
      display: grid;
      gap: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--color-border);
    }
    .role-board__waiting-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .role-board__waiting-count {
      padding: 0 0.5rem;
      border-radius: var(--radius-full);
      background: var(--color-warning-container);
      color: var(--color-warning);
      font-family: var(--font-mono);
    }
    @media (prefers-reduced-motion: reduce) {
      .role-tile__meter span,
      .build-line__button {
        transition: none;
      }
    }
  `,
})
export class EventRoleBoard {
  private readonly translate = inject(TranslateService);

  /** Every seat on the roster, across all parties. */
  readonly seats = input.required<readonly EventRosterSeat[]>();
  /** Signed-up players who do not have a seat yet. */
  readonly bench = input.required<readonly EventRosterParticipant[]>();
  /** The event's parties; with more than one, each player is tagged with their party. */
  readonly parties = input<readonly EventParty[]>([]);
  /** The viewer, highlighted wherever they appear. */
  readonly currentUserId = input<number | null>(null);
  /** Weapon icon per build id; builds without one show their role letter. */
  readonly buildIcons = input<ReadonlyMap<number, string>>(new Map());

  /** Asks the page to show the build behind a seat. */
  readonly inspect = output<EventRosterSeat>();

  protected readonly groups = computed(() => groupSeatsByRole(this.seats()));
  protected readonly filledSeats = computed(
    () => this.seats().filter((seat) => seat.participant !== null).length,
  );

  protected t(key: TranslationKey, params?: Record<string, string | number>): string {
    return this.translate.t(key, params);
  }

  protected roleName(role: string): string {
    const key = roleLabelKey(role);
    return key ? this.t(key) : role;
  }

  protected roleColor(role: string): string {
    return roleColorVar(role);
  }

  protected glyph(role: string): string {
    return roleGlyph(role);
  }

  protected percent(filled: number, total: number): number {
    return total > 0 ? Math.round((filled / total) * 100) : 0;
  }

  protected occupants(
    build: LobbyBuildGroup,
  ): (EventRosterParticipant & { partyLabel: string | null })[] {
    const tagged = this.parties().length > 1;
    const defaultName = (position: number): string => this.t('events.lobby.party', { number: position });
    return build.seats.flatMap((seat) => {
      if (!seat.participant) return [];
      const party = partyForBoardNumber(this.parties(), seat.party_number);
      const partyLabel = tagged
        ? party
          ? partyHeading(party, seat.party_number, defaultName)
          : seatPartyLabel(seat, defaultName)
        : null;
      return [{ ...seat.participant, partyLabel }];
    });
  }
}
