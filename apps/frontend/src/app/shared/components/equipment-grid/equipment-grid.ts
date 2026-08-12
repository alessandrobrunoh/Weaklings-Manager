import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { BuildItemSlot, BuildSlot, OpenAlbionItem } from '../../../core/models/api.models';

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
 * />
 * ```
 */
@Component({
  selector: 'app-equipment-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
              [src]="entry?.openalbion_item_icon"
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
            @if (entry.openalbion_item_tier) {
              <span class="equipment-slot__tier">{{ entry.openalbion_item_tier }}</span>
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
            <div
              class="equipment-popover equipment-popover--{{ popoverAlign(slot) }}"
              role="dialog"
              [attr.aria-label]="slotLabel(slot) + ' picker'"
              (click)="$event.stopPropagation()"
            >
              <div class="grid gap-2">
                <label class="text-left">
                  <span class="label">Tier</span>
                  <select class="select" [value]="draftTier()" (change)="onTierChange($event)">
                    @for (tier of tiers(); track tier) {
                      <option [value]="tier">{{ tier }}</option>
                    }
                  </select>
                </label>

                <label class="text-left">
                  <span class="label">Search item</span>
                  <input
                    class="input"
                    type="search"
                    placeholder="Type item name…"
                    [value]="draftSearch()"
                    (input)="onSearchInput($event)"
                  />
                </label>

                <label class="text-left">
                  <span class="label">Result</span>
                  <select class="select" [value]="draftItemId()" (change)="onItemSelect($event)">
                    <option value="">
                      {{ searchLoading() ? 'Searching…' : 'Select an item' }}
                    </option>
                    @for (item of searchResults(); track item.id) {
                      <option [value]="item.id">{{ item.name }} · {{ item.tier }}</option>
                    }
                  </select>
                </label>
              </div>

              <div class="flex justify-between gap-2">
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
            </div>
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

  /** Slot currently being edited — drives which popover is open. */
  readonly editingSlot = input<BuildSlot | null>(null);

  /** Tier filter bound to the open popover's tier `<select>`. */
  readonly draftTier = input('T8');

  /** Search box value of the open popover. */
  readonly draftSearch = input('');

  /** Currently selected OpenAlbion item id (string to ease `<select>` binding). */
  readonly draftItemId = input('');

  /** OpenAlbion search results to populate the popover's item dropdown. */
  readonly searchResults = input<readonly OpenAlbionItem[]>([]);

  /** Loading flag rendered inside the popover's empty option. */
  readonly searchLoading = input(false);

  /** Tier options shown in the popover's tier select. */
  readonly tiers = input<readonly string[]>(['T4', 'T5', 'T6', 'T7', 'T8']);

  /** Fired when the user clicks anywhere on a slot card. */
  readonly slotToggle = output<BuildSlot>();

  /** Fired when the user changes the tier dropdown inside the popover. */
  readonly tierChange = output<string>();

  /** Fired on each search input keystroke (parent debounces the API call). */
  readonly searchChange = output<string>();

  /** Fired with the picked item id from the search results dropdown. */
  readonly itemSelect = output<string>();

  /** Fired when the user confirms the popover (Save). Slot is echoed for context. */
  readonly saveSlot = output<BuildSlot>();

  /** Fired when the user dismisses the popover (Cancel). */
  readonly cancelEdit = output<void>();

  /** Fired when the user clicks the inline clear (×) button on a filled slot. */
  readonly removeItem = output<BuildSlot>();

  protected readonly slots = SLOT_ORDER;

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

  /**
   * Anchor the popover so it never overflows the viewport edge.
   *
   * Slots in the leftmost column open right-aligned (popover grows toward
   * the centre); rightmost column opens left-aligned; centre slots can
   * safely centre the popover.
   */
  protected popoverAlign(slot: BuildSlot): 'left' | 'right' | 'center' {
    switch (slot) {
      case 'bag':
      case 'weapon':
      case 'potion':
        return 'left';
      case 'cape':
      case 'off_hand':
      case 'food':
        return 'right';
      default:
        return 'center';
    }
  }

  protected onTierChange(event: Event): void {
    this.tierChange.emit((event.target as HTMLSelectElement).value);
  }

  protected onSearchInput(event: Event): void {
    this.searchChange.emit((event.target as HTMLInputElement).value);
  }

  protected onItemSelect(event: Event): void {
    this.itemSelect.emit((event.target as HTMLSelectElement).value);
  }

  /**
   * Stop the synthetic full-card click so the clear action does not also
   * toggle the popover open.
   */
  protected onClearClick(event: MouseEvent, slot: BuildSlot): void {
    event.stopPropagation();
    this.removeItem.emit(slot);
  }
}
