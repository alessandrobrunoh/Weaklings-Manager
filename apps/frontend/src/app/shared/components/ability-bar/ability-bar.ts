import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { AbilitySlotView } from '../../data/albion-abilities';
import { albionAbilityIconUrl } from '../../data/albion-abilities';
import { ChoiceGroup, type ChoiceOption } from '../choice-group/choice-group';

/** One picker change, ready to fold into the item's selection. */
export interface AbilityChoiceChange {
  kind: 'active' | 'passive';
  index: number;
  spellId: string | null;
}

/** One ability slot, with everything the template needs already worked out. */
interface AbilityRow {
  readonly slot: AbilitySlotView;
  /** The chosen spell, or `null` when the slot is empty. */
  readonly chosen: { readonly id: string; readonly name: string } | null;
  /** "None" first, then every spell the slot accepts. */
  readonly options: readonly ChoiceOption[];
}

/**
 * The ability bar for one equipped item.
 *
 * Read-only by default — the audience is the member reading a build before a fight, who needs to
 * know which spells to slot. With `canManage`, each slot becomes ONE control: a row of named chips
 * (icon and spell name, plus a "None" chip), restricted to what that item actually offers. There is
 * a single way to choose a spell, with one Tab stop per slot and arrow keys inside it.
 *
 * The key badge (Q/W/E, D/R/F, Passive) carries the meaning, not colour, and every spell keeps its
 * name beside its icon, so the bar stays legible without images and in both themes.
 *
 * @example
 * ```html
 * <app-ability-bar
 *   [slots]="abilitySlots()"
 *   [canManage]="canManage()"
 *   [emptyLabel]="t('comps.noAbility')"
 *   (choiceChange)="onAbilityChange($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-ability-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChoiceGroup],
  template: `
    @if (rows().length > 0) {
      <ul class="ability-bar" role="list">
        @for (row of rows(); track row.slot.kind + row.slot.index) {
          <li class="ability-bar__slot">
            <span class="ability-bar__key">{{ row.slot.label }}</span>

            @if (canManage()) {
              <app-choice-group
                class="ability-bar__choices"
                [options]="row.options"
                [value]="row.slot.selected ?? ''"
                [ariaLabel]="slotAriaLabel(row)"
                (valueChange)="choose(row.slot, $event)"
              />
            } @else if (row.chosen; as chosen) {
              <span class="ability-bar__chosen">
                <img
                  class="ability-bar__icon"
                  [src]="iconUrl(chosen.id)"
                  alt=""
                  width="28"
                  height="28"
                  loading="lazy"
                  (error)="onIconError($event)"
                />
                <span class="ability-bar__name">{{ chosen.name }}</span>
              </span>
            } @else {
              <span class="ability-bar__empty">{{ emptyLabel() }}</span>
            }
          </li>
        }
      </ul>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
    }

    .ability-bar {
      display: flex;
      width: 100%;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .ability-bar__slot {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      min-width: 0;
      max-width: 100%;
    }

    .ability-bar__choices {
      flex: 1 1 auto;
      min-width: 0;
    }

    .ability-bar__key {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      min-width: 1.75rem;
      min-height: 2rem;
      padding: 0 0.375rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 600;
    }

    .ability-bar__chosen {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-height: 2rem;
      min-width: 0;
    }

    .ability-bar__icon {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: var(--radius-sm);
      object-fit: contain;
    }

    .ability-bar__name {
      font-size: 0.875rem;
      color: var(--color-text);
      overflow-wrap: anywhere;
    }

    .ability-bar__empty {
      display: inline-flex;
      align-items: center;
      min-height: 2rem;
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
  `,
})
export class AbilityBar {
  private readonly translate = inject(TranslateService);

  /** The slots this item offers, already resolved against the ability catalog. */
  readonly slots = input.required<readonly AbilitySlotView[]>();
  /** Turns each slot into a chip group. Read-only when false. */
  readonly canManage = input(false);
  /** Text for "nothing chosen", supplied by the parent so it stays translated. */
  readonly emptyLabel = input('—');

  /** Fires when a chip is chosen; `spellId` is `null` for the "None" chip. */
  readonly choiceChange = output<AbilityChoiceChange>();

  protected readonly iconUrl = albionAbilityIconUrl;

  protected readonly rows = computed<AbilityRow[]>(() => {
    const empty = this.emptyLabel();
    return this.slots().map((slot) => {
      const choice = slot.choices.find((entry) => entry.id === slot.selected);
      return {
        slot,
        chosen: choice ? { id: choice.id, name: choice.name } : null,
        options: [
          { id: '', label: empty },
          ...slot.choices.map((entry) => ({
            id: entry.id,
            label: entry.name,
            iconUrl: albionAbilityIconUrl(entry.id),
          })),
        ],
      };
    });
  });

  protected slotAriaLabel(row: AbilityRow): string {
    return this.translate.t('loadoutEditor.ability.slot', { key: row.slot.label });
  }

  protected choose(slot: AbilitySlotView, spellId: string): void {
    this.choiceChange.emit({ kind: slot.kind, index: slot.index, spellId: spellId || null });
  }

  /**
   * Hides an icon the CDN cannot render.
   *
   * A couple of gatherer passives have no sprite upstream; the name beside the icon already carries
   * the meaning, so dropping the broken image is better than a broken-image glyph.
   */
  protected onIconError(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }
}
