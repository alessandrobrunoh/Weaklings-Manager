import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { BuildItemSlot, BuildSlot, OpenAlbionItem } from '../../../core/models/api.models';
import type { AbilitySlotView } from '../../data/albion-abilities';
import {
  ALBION_ITEM_ENCHANTMENTS,
  albionTierLabel,
  DEFAULT_ALBION_ITEM_ENCHANTMENT,
} from '../../data/albion-item-enchantment';
import {
  ALBION_ITEM_QUALITIES,
  albionIconUrlWithQuality,
  albionItemQualityLabel,
  DEFAULT_ALBION_ITEM_QUALITY,
} from '../../data/albion-item-quality';
import { albionItemSupportsQuality } from '../../data/albion-equipment-catalog';
import { AbilityBar, type AbilityChoiceChange } from '../ability-bar/ability-bar';
import { Dialog } from '../dialog/dialog';

/**
 * Canonical character-sheet slot order.
 *
 * Order matters for keyboard tab-flow and for the empty-state count chip:
 * it mirrors the visual reading order of an Albion paper doll so screen
 * readers announce slots in the same sequence players scan them.
 */
const SLOT_ORDER: readonly BuildSlot[] = [
  'bag',
  'head',
  'cape',
  'weapon',
  'armor',
  'off_hand',
  'potion',
  'shoes',
  'food',
  'mount',
];

const SLOT_LABELS: Readonly<Record<BuildSlot, string>> = {
  bag: 'Bag',
  head: 'Helmet',
  cape: 'Cape',
  weapon: 'Weapon',
  armor: 'Armor',
  off_hand: 'Off-hand',
  potion: 'Potion',
  shoes: 'Boots',
  food: 'Food',
  mount: 'Mount',
};

/**
 * Slot cards laid out as a 3×3 character sheet plus a centred mount.
 *
 * Why a dedicated component: both the build authoring form and the build
 * detail page render the same paper-doll UI with the same popover-style
 * searchable select. Keeping it here avoids two diverging implementations
 * and lets the parent component stay focused on its data flow.
 *
 * The grid is intentionally dumb: the parent owns all search and selection
 * state (because search hits the OpenAlbion API and depends on the active
 * build/slot context). Inputs mirror that state into the grid; outputs
 * bubble every interaction back so the parent can mutate its draft.
 *
 * @example
 * ```html
 * <app-equipment-grid
 *   [items]="items()"
 *   [canManage]="canManage()"
 *   [editingSlot]="editingSlot()"
 *   [draftTier]="draftTier()"
 *   [draftSearch]="draftSearch()"
 *   [draftItemId]="draftItemId()"
 *   [searchResults]="searchResults()"
 *   [searchLoading]="searchLoading()"
 *   (slotToggle)="onSlotToggle($event)"
 *   (tierChange)="onTierChange($event)"
 *   (searchChange)="onSearchChange($event)"
 *   (itemSelect)="onItemSelect($event)"
 *   (saveSlot)="onSaveSlot()"
 *   (cancelEdit)="onCancelEdit()"
 *   (removeItem)="onRemoveItem($event)"
 *   [draftAbilitySlots]="draftAbilitySlots()"
 *   (abilityChoice)="onDraftAbilityChange($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-equipment-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbilityBar, Dialog],
  styles: `
    .equipment-picker__toolbar {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.75rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--color-border);
    }

    .equipment-picker__search {
      grid-column: 1 / -1;
    }

    .equipment-picker__results {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
      gap: 0.75rem;
      max-height: min(52vh, 34rem);
      overflow: auto;
      padding: 0.25rem;
    }

    .equipment-picker__option {
      display: flex;
      min-height: 9.5rem;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      padding: 0.7rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface-1);
      color: var(--color-text);
      cursor: pointer;
      text-align: center;
      transition: border-color 120ms ease-out, background-color 120ms ease-out, transform 120ms ease-out;
    }

    .equipment-picker__option:hover,
    .equipment-picker__option:focus-visible,
    .equipment-picker__option--selected {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
      transform: translateY(-1px);
    }

    .equipment-picker__option-icon {
      width: 4.5rem;
      height: 4.5rem;
      object-fit: contain;
      image-rendering: auto;
    }

    .equipment-picker__option-copy {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
      width: 100%;
    }

    .equipment-picker__option-copy strong,
    .equipment-picker__option-copy small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .equipment-picker__option-copy small {
      color: var(--color-text-secondary);
    }

    .equipment-picker__empty {
      grid-column: 1 / -1;
      padding: 2rem 1rem;
      color: var(--color-text-secondary);
      text-align: center;
    }

    @media (max-width: 640px) {
      .equipment-picker__toolbar {
        grid-template-columns: 1fr;
      }
    }
  `,
  template: `
    <div class="equipment-grid equipment-grid--paperdoll" role="group" aria-label="Equipment">
      @for (slot of slots; track slot) {
        @let entry = entryForSlot(slot);
        <div
          class="equipment-slot equipment-slot--{{ slot }}"
          [class.equipment-slot--filled]="!!entry"
          [class.equipment-slot--editing]="editingSlot() === slot"
          [class.equipment-slot--interactive]="canManage()"
        >
          @if (entry?.openalbion_item_icon) {
            <img
              class="equipment-slot__icon"
              [src]="itemIcon(entry)"
              [alt]="entry?.openalbion_item_name ?? ''"
              loading="lazy"
            />
          } @else {
            <span class="equipment-slot__placeholder" aria-hidden="true">
              {{ entry ? '★' : '+' }}
            </span>
          }

          <span class="equipment-slot__label">{{ slotLabel(slot) }}</span>

          @if (entry) {
            <span class="equipment-slot__name" [title]="entry.openalbion_item_name">
              {{ entry.openalbion_item_name }}
            </span>
            @if (tierLabel(entry)) {
              <span class="equipment-slot__tier">{{ tierLabel(entry) }}</span>
            }
            @if (supportsQuality(entry.openalbion_item_icon, entry.slot)) {
              <span
                class="equipment-slot__quality equipment-slot__quality--{{ itemQuality(entry) }}"
                [title]="qualityLabel(entry)"
              >
                {{ qualityShort(entry) }}
              </span>
            }
          }

          @if (canManage()) {
            @if (entry) {
              <button
                type="button"
                class="equipment-slot__clear"
                [attr.aria-label]="'Remove ' + slotLabel(slot)"
                [title]="'Clear ' + slotLabel(slot)"
                (click)="onClearClick($event, slot)"
              >
                ×
              </button>
            }
            <button
              type="button"
              class="equipment-slot__trigger"
              [attr.aria-label]="'Edit ' + slotLabel(slot)"
              (click)="slotToggle.emit(slot)"
            ></button>
          }

          @if (editingSlot() === slot) {
            <app-dialog
              [title]="slotLabel(slot) + ' — scegli equipaggiamento'"
              subtitle="Cerca per nome e scegli direttamente l'icona dell'oggetto."
              size="xl"
              (closed)="cancelEdit.emit()"
            >
              <div class="grid gap-4">
                <div class="equipment-picker__toolbar">
                  <label class="equipment-picker__search text-left">
                    <span class="label">Cerca oggetto</span>
                    <input
                      class="input"
                      type="search"
                      placeholder="Nome oggetto…"
                      [value]="draftSearch()"
                      (input)="onSearchInput($event)"
                    />
                  </label>

                <label class="text-left">
                  <span class="label">Tier</span>
                  <select class="select" [value]="draftTier()" (change)="onTierChange($event)">
                    @for (tier of tiers(); track tier) {
                      <option [value]="tier">{{ tier }}</option>
                    }
                  </select>
                </label>

                @if (supportsEnchantmentForSlot(slot)) {
                  <label class="text-left">
                    <span class="label">Enchantment</span>
                    <select
                      class="select"
                      [value]="draftEnchantment()"
                      (change)="onEnchantmentChange($event)"
                    >
                      @for (level of enchantments; track level) {
                        <option [value]="level">{{ level === 0 ? 'Plain' : '.' + level }}</option>
                      }
                    </select>
                  </label>
                }

                @if (supportsQualityForSlot(slot)) {
                  <label class="text-left">
                    <span class="label">Quality</span>
                    <select class="select" [value]="draftQuality()" (change)="onQualityChange($event)">
                      @for (grade of qualities; track grade.id) {
                        <option [value]="grade.id">{{ grade.label }}</option>
                      }
                    </select>
                  </label>
                }

                </div>

                <div class="text-left">
                  <div class="flex items-center justify-between gap-3">
                    <span class="label">Oggetti disponibili</span>
                    <span class="chip">{{ searchResults().length }}</span>
                  </div>
                  <div
                    class="equipment-picker__results"
                    role="listbox"
                    aria-label="Oggetti disponibili"
                    [attr.aria-busy]="searchLoading()"
                  >
                    @if (searchLoading()) {
                      <p class="equipment-picker__empty" role="status">Ricerca in corso…</p>
                    } @else if (searchResults().length === 0) {
                      <p class="equipment-picker__empty">Nessun oggetto disponibile per questo slot.</p>
                    } @else {
                      @for (item of searchResults(); track item.id) {
                        <button
                          type="button"
                          class="equipment-picker__option"
                          role="option"
                          [class.equipment-picker__option--selected]="isSelected(item)"
                          [attr.aria-selected]="isSelected(item)"
                          [attr.aria-label]="item.name + ', ' + item.tier"
                          (click)="selectItem(item)"
                        >
                          <img
                            class="equipment-picker__option-icon"
                            [src]="item.icon ?? ''"
                            alt=""
                            width="72"
                            height="72"
                            loading="lazy"
                          />
                          <span class="equipment-picker__option-copy">
                            <strong>{{ item.name }}</strong>
                            <small>{{ item.tier }} · {{ item.identifier ?? '' }}</small>
                          </span>
                          @if (isSelected(item)) {
                            <span class="equipment-picker__check" aria-hidden="true">✓ Selezionato</span>
                          }
                        </button>
                      }
                    }
                  </div>
                </div>

                @if (draftAbilitySlots().length > 0) {
                  <div class="text-left">
                    <span class="label">Abilities</span>
                    <app-ability-bar
                      [slots]="draftAbilitySlots()"
                      [canManage]="true"
                      (choiceChange)="abilityChoice.emit($event)"
                    />
                  </div>
                }
              </div>
              <div class="flex justify-between gap-2 mt-4">
                <button type="button" class="btn btn--ghost btn--sm" (click)="cancelEdit.emit()">
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn--primary btn--sm"
                  [disabled]="!draftItemId()"
                  (click)="saveSlot.emit(slot)"
                >
                  Save
                </button>
              </div>
            </app-dialog>
          }
        </div>
      }
    </div>
  `,
})
export class EquipmentGrid {
  /** All slots currently configured for the build (draft or persisted). */
  readonly items = input<readonly BuildItemSlot[]>([]);

  /** Whether the slot cards are interactive (parent has manage permission). */
  readonly canManage = input(false);

  /** Slot currently being edited — drives which large native dialog is open. */
  readonly editingSlot = input<BuildSlot | null>(null);

  /** Tier filter bound to the open picker dialog's tier `<select>`. */
  readonly draftTier = input('T8');

  /** Albion quality (1..=5) bound to the open picker dialog's quality `<select>`. */
  readonly draftQuality = input(DEFAULT_ALBION_ITEM_QUALITY);

  /** Albion enchantment (0..=4) bound to the open picker dialog's enchantment `<select>`. */
  readonly draftEnchantment = input<number>(DEFAULT_ALBION_ITEM_ENCHANTMENT);

  /** Search box value of the open picker dialog. */
  readonly draftSearch = input('');

  /** Currently selected OpenAlbion item id. */
  readonly draftItemId = input('');

  /** OpenAlbion search results shown as large icon cards. */
  readonly searchResults = input<readonly OpenAlbionItem[]>([]);

  /** Loading flag rendered inside the icon grid. */
  readonly searchLoading = input(false);

  /** Tier options shown in the picker dialog's tier select. */
  readonly tiers = input<readonly string[]>(['T4', 'T5', 'T6', 'T7', 'T8']);

  /**
   * Ability slots the currently drafted item offers, already resolved against the ability catalog
   * and the draft's in-progress choices. Empty for an item with nothing to pick — off-hands,
   * capes, bags, consumables, mounts — or before any item is selected, so no bar renders.
   */
  readonly draftAbilitySlots = input<readonly AbilitySlotView[]>([]);

  /** Fired when the user clicks anywhere on a slot card. */
  readonly slotToggle = output<BuildSlot>();

  /** Fired when the user changes the tier dropdown inside the picker dialog. */
  readonly tierChange = output<string>();

  /** Fired when the user changes the quality dropdown inside the picker dialog. */
  readonly qualityChange = output<number>();

  /** Fired when the user changes the enchantment dropdown inside the picker dialog. */
  readonly enchantmentChange = output<number>();

  /** Fired on each search input keystroke (parent debounces the catalogue filter). */
  readonly searchChange = output<string>();

  /** Fired with the picked item id from the icon grid. */
  readonly itemSelect = output<string>();

  /** Fired when the user confirms the picker dialog (Save). Slot is echoed for context. */
  readonly saveSlot = output<BuildSlot>();

  /** Fired when the user dismisses the picker dialog (Cancel). */
  readonly cancelEdit = output<void>();

  /** Fired when the user clicks the inline clear (×) button on a filled slot. */
  readonly removeItem = output<BuildSlot>();

  /** Fired when the user picks an ability in the draft item's bar, before the slot is saved. */
  readonly abilityChoice = output<AbilityChoiceChange>();

  protected readonly slots = SLOT_ORDER;
  protected readonly qualities = ALBION_ITEM_QUALITIES;

  protected readonly enchantments = ALBION_ITEM_ENCHANTMENTS;

  /** Pre-indexed lookup so per-slot rendering stays O(1) at scale. */
  private readonly itemsBySlot = computed(() => {
    const map = new Map<BuildSlot, BuildItemSlot>();
    for (const item of this.items()) {
      map.set(item.slot, item);
    }
    return map;
  });

  protected entryForSlot(slot: BuildSlot): BuildItemSlot | undefined {
    return this.itemsBySlot().get(slot);
  }

  protected slotLabel(slot: BuildSlot): string {
    return SLOT_LABELS[slot] ?? slot;
  }

  protected isSelected(item: OpenAlbionItem): boolean {
    return String(item.id) === this.draftItemId();
  }

  protected selectItem(item: OpenAlbionItem): void {
    this.itemSelect.emit(String(item.id));
  }

  protected onTierChange(event: Event): void {
    this.tierChange.emit((event.target as HTMLSelectElement).value);
  }

  protected onQualityChange(event: Event): void {
    this.qualityChange.emit(Number((event.target as HTMLSelectElement).value));
  }

  protected onEnchantmentChange(event: Event): void {
    this.enchantmentChange.emit(Number((event.target as HTMLSelectElement).value));
  }

  /** The slot chip's tier, written the way the game does it: `T8.2`, or `T8` when plain. */
  protected tierLabel(entry: BuildItemSlot | undefined): string {
    return albionTierLabel(entry?.openalbion_item_tier, entry?.openalbion_item_enchantment);
  }

  protected itemQuality(entry: BuildItemSlot | undefined): number {
    return entry?.openalbion_item_quality && entry.openalbion_item_quality >= 1
      ? entry.openalbion_item_quality
      : DEFAULT_ALBION_ITEM_QUALITY;
  }

  protected qualityLabel(entry: BuildItemSlot | undefined): string {
    return albionItemQualityLabel(entry?.openalbion_item_quality);
  }

  protected qualityShort(entry: BuildItemSlot | undefined): string {
    const quality = this.itemQuality(entry);
    return ALBION_ITEM_QUALITIES.find((grade) => grade.id === quality)?.short ?? 'E';
  }

  protected supportsQuality(icon: string | null | undefined, slot: BuildSlot): boolean {
    const identifier = icon?.match(/\/item\/([^.?]+)/)?.[1];
    return albionItemSupportsQuality(identifier) && this.supportsQualityForSlot(slot);
  }

  protected supportsQualityForSlot(slot: BuildSlot): boolean {
    return slot !== 'potion' && slot !== 'food' && slot !== 'mount';
  }

  protected supportsEnchantmentForSlot(slot: BuildSlot): boolean {
    return slot !== 'mount';
  }

  protected itemIcon(entry: BuildItemSlot | undefined): string {
    const quality = entry && this.supportsQualityForSlot(entry.slot) ? entry.openalbion_item_quality : 1;
    return albionIconUrlWithQuality(entry?.openalbion_item_icon, quality);
  }

  protected onSearchInput(event: Event): void {
    this.searchChange.emit((event.target as HTMLInputElement).value);
  }

  /** Stop the synthetic full-card click so the clear action does not also open the picker. */
  protected onClearClick(event: MouseEvent, slot: BuildSlot): void {
    event.stopPropagation();
    this.removeItem.emit(slot);
  }
}
