import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { AbilitySlotView } from '../../data/albion-abilities';
import { albionAbilityIconUrl } from '../../data/albion-abilities';
import { Dialog } from '../dialog/dialog';

/** One picker change, ready to fold into the item's selection. */
export interface AbilityChoiceChange {
  kind: 'active' | 'passive';
  index: number;
  spellId: string | null;
}

/**
 * The ability bar for one equipped item.
 *
 * Read-only by default — the audience is the member reading a build before a fight, who needs to
 * know which spells to slot. With `canManage`, each slot becomes a select restricted to what that
 * item actually offers.
 *
 * The key badge (Q/W/E, D/R/F) carries the meaning, not colour, and every icon keeps its name
 * beside it, so the bar stays legible without images and in both themes.
 *
 * @example
 * ```html
 * <app-ability-bar
 *   [slots]="abilitySlots()"
 *   [canManage]="canManage()"
 *   (choiceChange)="onAbilityChange($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-ability-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog],
  template: `
    @if (slots().length > 0) {
      <ul class="ability-bar" role="list">
        @for (slot of slots(); track slot.kind + slot.index) {
          @let chosen = selectedChoice(slot);
          <li class="ability-bar__slot">
            <span class="ability-bar__key" aria-hidden="true">{{ slot.label }}</span>

            @if (canManage()) {
              <button
                type="button"
                class="ability-bar__picker-trigger"
                [attr.aria-label]="slot.label + ': scegli spell'"
                (click)="openPicker(slot)"
              >
                @if (chosen) {
                  <img
                    class="ability-bar__icon"
                    [src]="iconUrl(chosen.id)"
                    alt=""
                    width="44"
                    height="44"
                    loading="lazy"
                    (error)="onIconError($event)"
                  />
                  <span class="ability-bar__name">{{ chosen.name }}</span>
                } @else {
                  <span class="ability-bar__empty">{{ emptyLabel() }}</span>
                }
                <span class="ability-bar__picker-hint" aria-hidden="true">Scegli</span>
              </button>
              <div class="ability-bar__choices" role="group" [attr.aria-label]="slot.label + ' quick choices'">
                <button
                  type="button"
                  class="ability-bar__choice ability-bar__choice--empty"
                  [class.ability-bar__choice--selected]="!slot.selected"
                  [attr.aria-pressed]="!slot.selected"
                  [attr.aria-label]="slot.label + ': ' + emptyLabel()"
                  [title]="emptyLabel()"
                  (click)="clearChoice(slot)"
                >
                  <span aria-hidden="true">×</span>
                </button>
                @for (choice of slot.choices; track choice.id) {
                  <button
                    type="button"
                    class="ability-bar__choice"
                    [class.ability-bar__choice--selected]="choice.id === slot.selected"
                    [attr.aria-pressed]="choice.id === slot.selected"
                    [attr.aria-label]="slot.label + ': ' + choice.name"
                    [title]="choice.name"
                    (click)="selectChoice(slot, choice.id)"
                  >
                    <img
                      class="ability-bar__icon"
                      [src]="iconUrl(choice.id)"
                      alt=""
                      width="36"
                      height="36"
                      loading="lazy"
                      (error)="onIconError($event)"
                    />
                  </button>
                }
              </div>
            } @else if (chosen) {
              <span class="ability-bar__chosen">
                <img
                  class="ability-bar__icon"
                  [src]="iconUrl(chosen.id)"
                  [alt]="''"
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

      @if (pickerSlot(); as activeSlot) {
        <app-dialog
          [title]="activeSlot.label + ' — scegli spell'"
          subtitle="Scegli l'abilità direttamente dalla griglia delle icone."
          size="xl"
          (closed)="closePicker()"
        >
          <div class="ability-picker" role="listbox" [attr.aria-label]="activeSlot.label + ' spells'">
            <button
              type="button"
              class="ability-picker__option ability-picker__option--empty"
              [class.ability-picker__option--selected]="!activeSlot.selected"
              role="option"
              [attr.aria-selected]="!activeSlot.selected"
              (click)="selectChoice(activeSlot, null)"
            >
              <span class="ability-picker__empty-icon" aria-hidden="true">×</span>
              <strong>{{ emptyLabel() }}</strong>
            </button>
            @for (choice of activeSlot.choices; track choice.id) {
              <button
                type="button"
                class="ability-picker__option"
                [class.ability-picker__option--selected]="choice.id === activeSlot.selected"
                role="option"
                [attr.aria-selected]="choice.id === activeSlot.selected"
                [attr.aria-label]="choice.name"
                (click)="selectChoice(activeSlot, choice.id)"
              >
                <img
                  class="ability-picker__icon"
                  [src]="iconUrl(choice.id)"
                  alt=""
                  width="84"
                  height="84"
                  loading="lazy"
                  (error)="onIconError($event)"
                />
                <strong>{{ choice.name }}</strong>
                @if (choice.cooldown || choice.energy) {
                  <small>{{ choice.cooldown || '' }}{{ choice.cooldown && choice.energy ? ' · ' : '' }}{{ choice.energy || '' }}</small>
                }
              </button>
            }
          </div>
        </app-dialog>
      }
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
      flex-wrap: wrap;
      gap: 0.75rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    .ability-bar__slot {
      display: flex;
      flex: 1 1 100%;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 0.5rem;
      width: 100%;
      max-width: 100%;
      min-width: 0;
    }

    .ability-bar__picker-trigger {
      display: flex;
      flex: 1 1 12rem;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.375rem;
      max-width: 100%;
      min-width: 0;
      padding: 0.25rem 0.45rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface-1, transparent);
      color: var(--color-text);
      cursor: pointer;
      text-align: left;
    }

    .ability-bar__picker-trigger:hover,
    .ability-bar__picker-trigger:focus-visible {
      border-color: var(--color-primary);
    }

    .ability-bar__choices {
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      gap: 0.375rem;
      max-width: 100%;
      min-width: 0;
    }

    .ability-bar__choice {
      display: inline-flex;
      width: 2.25rem;
      height: 2.25rem;
      align-items: center;
      justify-content: center;
      padding: 0.125rem;
      border: 1px solid var(--color-border);
      border-radius: 0.375rem;
      background: var(--color-surface-1, transparent);
      cursor: pointer;
      transition: border-color 120ms ease-out, background-color 120ms ease-out;
    }

    .ability-bar__choice:hover,
    .ability-bar__choice:focus-visible {
      border-color: var(--color-primary);
    }

    .ability-bar__choice--selected {
      border-color: var(--color-primary);
      background: var(--color-primary-subtle);
      box-shadow: 0 0 0 1px var(--color-primary);
    }

    .ability-bar__choice--empty {
      color: var(--color-text-secondary);
      font-size: 1.25rem;
      line-height: 1;
    }

    .ability-bar__choice {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      padding: 0.125rem;
      border: 1px solid var(--color-border);
      border-radius: 0.375rem;
      background: var(--color-surface-1, transparent);
      cursor: pointer;
      transition: border-color 120ms ease-out, background-color 120ms ease-out;
    }

    .ability-bar__choice:hover,
    .ability-bar__choice:focus-visible {
      border-color: var(--color-primary);
    }

    .ability-bar__choice--selected {
      border-color: var(--color-primary);
      background: var(--color-primary-subtle);
      box-shadow: 0 0 0 1px var(--color-primary);
    }

    .ability-bar__choice--empty {
      color: var(--color-text-secondary);
      font-size: 1.25rem;
      line-height: 1;
    }

    .ability-bar__key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 1.75rem;
      height: 1.75rem;
      padding: 0 0.375rem;
      border: 1px solid var(--color-border);
      border-radius: 0.375rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
      background: var(--color-surface-muted, transparent);
    }

    .ability-bar__chosen {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
    }

    .ability-bar__icon {
      width: 1.75rem;
      height: 1.75rem;
      border-radius: 0.25rem;
      object-fit: contain;
    }

    .ability-bar__name {
      font-size: 0.875rem;
      color: var(--color-text);
      overflow-wrap: anywhere;
    }

    .ability-bar__empty {
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }

    .ability-bar__picker-hint {
      padding-left: 0.25rem;
      color: var(--color-text-secondary);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .ability-picker {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
      gap: 0.75rem;
      max-height: min(58vh, 38rem);
      overflow: auto;
      padding: 0.25rem;
    }

    .ability-picker__option {
      display: flex;
      min-height: 10.5rem;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      padding: 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface-1);
      color: var(--color-text);
      cursor: pointer;
      text-align: center;
      transition: border-color 120ms ease-out, background-color 120ms ease-out, transform 120ms ease-out;
    }

    .ability-picker__option:hover,
    .ability-picker__option:focus-visible,
    .ability-picker__option--selected {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
      transform: translateY(-1px);
    }

    .ability-picker__icon {
      width: 5.25rem;
      height: 5.25rem;
      object-fit: contain;
    }

    .ability-picker__option strong,
    .ability-picker__option small {
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ability-picker__option small {
      color: var(--color-text-secondary);
    }

    .ability-picker__empty-icon {
      display: inline-flex;
      width: 5.25rem;
      height: 5.25rem;
      align-items: center;
      justify-content: center;
      border: 1px dashed var(--color-border);
      border-radius: var(--radius-cards);
      color: var(--color-text-secondary);
      font-size: 2rem;
    }
  `,
})
export class AbilityBar {
  /** The slots this item offers, already resolved against the ability catalog. */
  readonly slots = input.required<readonly AbilitySlotView[]>();
  /** Turns each slot into a picker. Read-only when false. */
  readonly canManage = input(false);
  /** Text for "nothing chosen", supplied by the parent so it stays translated. */
  readonly emptyLabel = input('—');

  readonly choiceChange = output<AbilityChoiceChange>();

  protected readonly iconUrl = albionAbilityIconUrl;
  protected readonly pickerSlot = signal<AbilitySlotView | null>(null);

  /** The full choice behind a slot's selection, so the name and icon can be shown together. */
  protected selectedChoice(slot: AbilitySlotView) {
    return slot.choices.find((choice) => choice.id === slot.selected) ?? null;
  }

  protected openPicker(slot: AbilitySlotView): void {
    this.pickerSlot.set(slot);
  }

  protected closePicker(): void {
    this.pickerSlot.set(null);
  }

  protected selectChoice(slot: AbilitySlotView, spellId: string | null): void {
    this.choiceChange.emit({ kind: slot.kind, index: slot.index, spellId });
    this.closePicker();
  }

  protected clearChoice(slot: AbilitySlotView): void {
    this.choiceChange.emit({ kind: slot.kind, index: slot.index, spellId: null });
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

  /** Exposed for the template's computed access without a second signal read. */
  protected readonly hasSlots = computed(() => this.slots().length > 0);
}
