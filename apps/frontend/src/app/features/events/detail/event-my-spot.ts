import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type {
  BuildItemSlot,
  BuildSlot,
  EventParticipant,
  EventRosterSeat,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import type { AbilitySlotView } from '../../../shared/data/albion-abilities';
import { AbilityBar } from '../../../shared/components/ability-bar/ability-bar';
import { EquipmentGrid } from '../../../shared/components/equipment-grid/equipment-grid';
import { Icon } from '../../../shared/components/icon/icon';
import { roleColorVar, roleGlyph, roleLabelKey } from './roster-lobby';

/** One equipped item that offers ability choices, as the page computes them. */
export interface MySpotAbilityRow {
  readonly slot: BuildSlot;
  readonly itemName: string;
  readonly slots: AbilitySlotView[];
}

/** Where the viewer stands on this event's roster. */
export type MySpotState = 'not-joined' | 'waiting' | 'seated';

/**
 * "Your spot": the viewer's own place on the roster.
 *
 * Not signed up → a single call to join. Signed up but not placed → the builds they picked and a
 * note that the organizer still has to place them. Placed → party, seat, role and the build they
 * must bring, with its equipment and abilities.
 */
@Component({
  selector: 'app-event-my-spot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbilityBar, EquipmentGrid, Icon],
  template: `
    <section
      class="my-spot"
      [class.my-spot--seated]="state() === 'seated'"
      [class.my-spot--waiting]="state() === 'waiting'"
      [style.--role-accent]="accent()"
      aria-labelledby="my-spot-heading"
    >
      <p class="my-spot__eyebrow">{{ t('events.lobby.yourSpot') }}</p>

      @switch (state()) {
        @case ('not-joined') {
          <div class="my-spot__hero">
            <span class="my-spot__badge my-spot__badge--muted" aria-hidden="true">
              <app-icon name="users" size="1.5rem" />
            </span>
            <div class="min-w-0">
              <h2 id="my-spot-heading" class="my-spot__title">
                {{ t('events.lobby.notJoinedTitle') }}
              </h2>
              <p class="my-spot__text">{{ t('events.lobby.notJoinedBody') }}</p>
            </div>
          </div>
          @if (canJoin()) {
            <button type="button" class="btn btn--primary my-spot__cta" (click)="join.emit()">
              <app-icon name="plus" size="1rem" />
              {{ t('events.participate') }}
            </button>
          }
        }

        @case ('waiting') {
          <div class="my-spot__hero">
            <span class="my-spot__badge my-spot__badge--waiting" aria-hidden="true">
              <app-icon name="loader" size="1.5rem" />
            </span>
            <div class="min-w-0">
              <h2 id="my-spot-heading" class="my-spot__title">
                {{ t('events.lobby.waitingTitle') }}
              </h2>
              <p class="my-spot__text">{{ t('events.lobby.waitingBody') }}</p>
            </div>
          </div>
          <dl class="my-spot__choices">
            <div class="my-spot__choice">
              <dt>{{ t('events.lobby.firstChoice') }}</dt>
              <dd>
                @if (weaponIcon(); as icon) {
                  <img [src]="icon" alt="" class="my-spot__choice-icon" loading="lazy" />
                }
                {{ primaryName() }}
              </dd>
            </div>
            @if (participant()?.secondary_build_name; as secondary) {
              <div class="my-spot__choice">
                <dt>{{ t('events.lobby.secondChoice') }}</dt>
                <dd>{{ secondary }}</dd>
              </div>
            }
          </dl>
        }

        @case ('seated') {
          @if (seat(); as current) {
            <div class="my-spot__hero">
              <span class="my-spot__weapon">
                @if (weaponIcon(); as icon) {
                  <img [src]="icon" [alt]="current.build_name" loading="lazy" />
                } @else {
                  <span aria-hidden="true">{{ glyph() }}</span>
                }
              </span>
              <div class="min-w-0">
                <p class="my-spot__role">
                  <span class="my-spot__role-chip">{{ roleName() }}</span>
                  <span class="my-spot__seat">
                    {{ t('events.lobby.partySeat', { party: current.party_number, position: current.position }) }}
                  </span>
                </p>
                <h2 id="my-spot-heading" class="my-spot__title my-spot__title--build">
                  {{ current.build_name }}
                </h2>
                @if (assignedDiffers()) {
                  <p class="my-spot__text">
                    {{ t('events.lobby.assignedDiffers', { picked: primaryName(), assigned: current.build_name }) }}
                  </p>
                }
              </div>
            </div>

            @if (hasSwap()) {
              <div class="my-spot__loadouts" role="group" [attr.aria-label]="t('events.lobby.equipment')">
                <button
                  type="button"
                  class="my-spot__loadout"
                  [attr.aria-pressed]="loadout() === 'main'"
                  (click)="loadout.set('main')"
                >
                  {{ t('events.lobby.mainSet') }}
                </button>
                <button
                  type="button"
                  class="my-spot__loadout"
                  [attr.aria-pressed]="loadout() === 'swap'"
                  (click)="loadout.set('swap')"
                >
                  {{ t('events.lobby.swapSet') }}
                </button>
              </div>
            }

            <div class="my-spot__gear">
              <div>
                <h3 class="my-spot__subhead">{{ t('events.lobby.equipment') }}</h3>
                <app-equipment-grid [items]="visibleItems()" />
              </div>
              <div class="grid gap-2 content-start">
                <h3 class="my-spot__subhead">{{ t('events.detail.abilities_chosen') }}</h3>
                @for (row of visibleAbilities(); track row.slot) {
                  <div class="my-spot__ability">
                    <p class="my-spot__ability-item">{{ row.itemName }}</p>
                    <app-ability-bar [slots]="row.slots" />
                  </div>
                } @empty {
                  <p class="my-spot__text">{{ t('events.detail.no_abilities_build') }}</p>
                }
              </div>
            </div>
          }
        }
      }

      @if (state() !== 'not-joined' && !archived()) {
        <div class="my-spot__actions">
          @if (state() === 'seated') {
            <button type="button" class="btn btn--outline btn--sm" (click)="showInParty.emit()">
              <app-icon name="users" size="0.875rem" />
              {{ t('events.lobby.showInParty') }}
            </button>
          }
          <button type="button" class="btn btn--outline btn--sm" (click)="changeBuild.emit()">
            <app-icon name="refresh" size="0.875rem" />
            {{ t('events.detail.change_build') }}
          </button>
          <button type="button" class="btn btn--ghost btn--sm my-spot__leave" (click)="leave.emit()">
            {{ t('events.leave') }}
          </button>
        </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .my-spot {
      --role-accent: var(--color-primary);
      position: relative;
      display: grid;
      gap: 1rem;
      overflow: hidden;
      padding: 1.25rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface);
    }
    .my-spot--seated {
      border-color: color-mix(in oklab, var(--role-accent) 55%, var(--color-border));
      background:
        linear-gradient(
          135deg,
          color-mix(in oklab, var(--role-accent) 16%, transparent),
          transparent 55%
        ),
        var(--color-surface);
    }
    .my-spot--waiting {
      border-color: color-mix(in oklab, var(--color-warning) 45%, var(--color-border));
    }
    .my-spot__eyebrow {
      font-size: 0.6875rem;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .my-spot__hero {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .my-spot__badge,
    .my-spot__weapon {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-cards);
    }
    .my-spot__badge {
      width: 3.5rem;
      height: 3.5rem;
    }
    .my-spot__badge--muted {
      background: var(--color-surface-2, var(--color-surface-muted));
      color: var(--color-text-secondary);
    }
    .my-spot__badge--waiting {
      background: var(--color-warning-container);
      color: var(--color-warning);
    }
    .my-spot__weapon {
      width: 5rem;
      height: 5rem;
      padding: 0.25rem;
      border: 2px solid var(--role-accent);
      background: var(--color-surface-2, var(--color-surface-muted));
      color: var(--role-accent);
      font-family: var(--font-display);
      font-size: 1.5rem;
      font-weight: 800;
    }
    .my-spot__weapon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .my-spot__title {
      font-family: var(--font-display);
      font-size: 1.25rem;
      font-weight: 800;
      line-height: 1.2;
      color: var(--color-text);
    }
    .my-spot__title--build {
      font-size: 1.5rem;
      overflow-wrap: anywhere;
    }
    .my-spot__text {
      margin-top: 0.25rem;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .my-spot__role {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }
    .my-spot__role-chip {
      padding: 0.125rem 0.5rem;
      border-radius: var(--radius-badges);
      background: var(--role-accent);
      color: #fff;
      font-size: 0.6875rem;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .my-spot__seat {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .my-spot__cta {
      justify-self: start;
      min-height: 2.75rem;
      padding-inline: 1.25rem;
    }
    .my-spot__choices {
      display: grid;
      gap: 0.5rem;
    }
    .my-spot__choice {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .my-spot__choice dt {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .my-spot__choice dd {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .my-spot__choice-icon {
      width: 1.75rem;
      height: 1.75rem;
      object-fit: contain;
    }
    .my-spot__loadouts {
      display: inline-flex;
      justify-self: start;
      gap: 0.25rem;
      padding: 0.25rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .my-spot__loadout {
      min-height: 2rem;
      padding: 0 0.75rem;
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .my-spot__loadout[aria-pressed='true'] {
      background: var(--color-surface-active);
      color: var(--color-text);
    }
    .my-spot__loadout:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .my-spot__gear {
      display: grid;
      gap: 1rem;
    }
    @media (min-width: 40rem) {
      .my-spot__gear {
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }
    }
    .my-spot__subhead {
      margin-bottom: 0.5rem;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }
    .my-spot__ability {
      display: grid;
      gap: 0.375rem;
    }
    .my-spot__ability-item {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text);
    }
    .my-spot__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--color-border);
    }
    .my-spot__leave {
      margin-left: auto;
      color: var(--color-error);
    }
  `,
})
export class EventMySpot {
  private readonly translate = inject(TranslateService);

  /** The viewer's signup, or `null` when they have not joined. */
  readonly participant = input<EventParticipant | null>(null);
  /** The seat the viewer holds, or `null` when they are not placed. */
  readonly seat = input<EventRosterSeat | null>(null);
  /** Whether the event can still be joined from the site. */
  readonly canJoin = input(true);
  /** Archived events are read-only: no join, change or leave. */
  readonly archived = input(false);
  /** Weapon icon of the seat's build (seated) or the first-choice build (waiting). */
  readonly weaponIcon = input('');
  /** The seat build's items, both loadouts. */
  readonly items = input<readonly BuildItemSlot[]>([]);
  readonly mainAbilities = input<readonly MySpotAbilityRow[]>([]);
  readonly swapAbilities = input<readonly MySpotAbilityRow[]>([]);

  readonly join = output<void>();
  readonly changeBuild = output<void>();
  readonly leave = output<void>();
  readonly showInParty = output<void>();

  protected readonly loadout = signal<'main' | 'swap'>('main');

  protected readonly state = computed<MySpotState>(() => {
    if (this.seat()) return 'seated';
    return this.participant() ? 'waiting' : 'not-joined';
  });

  protected readonly accent = computed(() => {
    const seat = this.seat();
    return seat ? roleColorVar(seat.role) : 'var(--color-primary)';
  });

  protected readonly hasSwap = computed(() =>
    this.items().some((item) => (item.loadout ?? 'main') === 'swap'),
  );

  protected readonly visibleItems = computed(() => {
    const loadout = this.hasSwap() ? this.loadout() : 'main';
    return this.items().filter((item) => (item.loadout ?? 'main') === loadout);
  });

  protected readonly visibleAbilities = computed(() =>
    this.hasSwap() && this.loadout() === 'swap' ? this.swapAbilities() : this.mainAbilities(),
  );

  protected readonly primaryName = computed(() => {
    const participant = this.participant();
    if (!participant) return '';
    return participant.primary_build_id === null
      ? this.t('events.detail.fill_option')
      : participant.primary_build_name;
  });

  /** The organizer placed the viewer on a different build than their first choice. */
  protected readonly assignedDiffers = computed(() => {
    const participant = this.participant();
    const seat = this.seat();
    return (
      participant !== null &&
      seat !== null &&
      participant.primary_build_id !== null &&
      participant.primary_build_id !== seat.build_id
    );
  });

  protected t(key: TranslationKey, params?: Record<string, string | number>): string {
    return this.translate.t(key, params);
  }

  protected roleName(): string {
    const seat = this.seat();
    if (!seat) return '';
    const key = roleLabelKey(seat.role);
    return key ? this.t(key) : seat.role;
  }

  protected glyph(): string {
    const seat = this.seat();
    return seat ? roleGlyph(seat.role) : '';
  }
}
