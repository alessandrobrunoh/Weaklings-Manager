import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import type {
  BuildItemSlot,
  BuildSlot,
  OpenAlbionItemAbilities,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { albionAbilityIconUrl } from '../../data/albion-abilities';
import { albionTierLabel } from '../../data/albion-item-enchantment';
import {
  albionIconUrlWithQuality,
  DEFAULT_ALBION_ITEM_QUALITY,
  isAlbionItemQuality,
} from '../../data/albion-item-quality';
import { albionItemSupportsQuality } from '../../data/albion-equipment-catalog';
import {
  CORE_SLOTS,
  SLOT_LABEL_KEYS,
  SLOT_ORDER,
} from '../../../features/comps/build-loadouts';
import { AlbionAbilitiesService } from '../../services/albion-abilities.service';

const QUALITY_LABEL_KEYS: Readonly<Record<number, TranslationKey>> = {
  1: 'loadout.quality.1',
  2: 'loadout.quality.2',
  3: 'loadout.quality.3',
  4: 'loadout.quality.4',
  5: 'loadout.quality.5',
};

/** The in-game key each slot's active spells are bound to. */
const ACTIVE_KEYS: Partial<Record<BuildSlot, readonly string[]>> = {
  weapon: ['Q', 'W', 'E'],
  head: ['D'],
  armor: ['R'],
  shoes: ['F'],
};

/** One chosen spell, ready to render as an icon with an accessible name. */
interface SpellView {
  readonly id: string;
  /** In-game key (`Q`, `W`, `E`, `D`, `R`, `F`) or the localized "Passive". */
  readonly key: string;
  readonly name: string;
  readonly iconUrl: string;
}

/** One slot line of a loadout. `item` is `null` for an expected slot that is still empty. */
interface LoadoutRow {
  readonly id: string;
  readonly slotLabel: string;
  readonly item: BuildItemSlot | null;
  readonly name: string;
  readonly tier: string;
  readonly qualityText: string | null;
  readonly iconUrl: string;
  readonly spells: readonly SpellView[];
  /** Swap rows only: the main-loadout item this slot replaces. */
  readonly replaces: string | null;
}

let nextLoadoutId = 0;

/**
 * Read-only loadout of a build as compact slot rows (not a paper doll).
 *
 * Takes a build's items (both loadouts, as `BuildDetail.items` delivers them) and lists the main
 * set in reading order: weapon, off-hand, head, armor, shoes, cape, bag, food, potion, mount. Each
 * row is the item icon (with a text fallback when the image fails to load), its name, `T8.3`-style
 * tier, the quality *only when it is not the guild default*, and the chosen spells as small icons.
 *
 * The swap loadout renders beside the main set when the container is wide and below it when it is
 * narrow, listing only the slots the swap actually defines and naming what each one replaces.
 *
 * Spell names appear on hover, on keyboard focus and after a tap, never on hover alone. The
 * component loads the shared ability catalog itself to turn spell ids into names.
 *
 * @example
 * ```html
 * <app-loadout-view [items]="build.items" [loading]="loading()" />
 * ```
 */
@Component({
  selector: 'app-loadout-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  host: { '(keydown.escape)': 'closeSpell()' },
  styles: `
    :host {
      display: block;
      min-width: 0;
      color: var(--color-text);
    }
    .loadout {
      container-type: inline-size;
      container-name: loadout;
    }
    .loadout__grid {
      display: grid;
      gap: 1.25rem;
    }
    @container loadout (min-width: 40rem) {
      .loadout__grid--paired {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1.5rem;
        align-items: start;
      }
    }
    .loadout__section {
      container-type: inline-size;
      container-name: loadout-section;
      min-width: 0;
    }
    .loadout__heading {
      margin: 0 0 0.125rem;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .loadout__hint {
      margin: 0 0 0.25rem;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .loadout__message {
      margin: 0;
      padding: 0.5rem 0;
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .slots {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .slot {
      display: grid;
      grid-template-columns: 2rem minmax(0, 1fr);
      grid-template-areas:
        'icon label'
        'icon text'
        '. spells';
      column-gap: 0.625rem;
      row-gap: 0.0625rem;
      align-items: center;
      padding: 0.4375rem 0;
      border-top: 1px solid var(--color-border);
    }
    .slot:first-child {
      border-top: 0;
    }
    .slot__label {
      grid-area: label;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .slot__icon {
      grid-area: icon;
      align-self: start;
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .slot__icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .slot__text {
      grid-area: text;
      min-width: 0;
      font-size: 0.875rem;
      line-height: 1.25rem;
    }
    .slot__name {
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .slot__empty {
      color: var(--color-text-secondary);
      font-style: italic;
    }
    .slot__tier {
      margin-inline-start: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .slot__quality {
      margin-inline-start: 0.375rem;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .slot__replaces {
      display: block;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .slot__spells {
      grid-area: spells;
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      margin: 0.25rem 0 0;
      padding: 0;
      list-style: none;
    }
    .spell {
      position: relative;
      display: inline-grid;
      place-items: center;
      width: 1.75rem;
      height: 1.75rem;
      padding: 0;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
      font-size: 0.75rem;
      font-weight: 600;
      cursor: default;
    }
    .spell:hover,
    .spell--open {
      border-color: var(--color-border-strong);
    }
    .spell:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 1px;
    }
    .spell img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .spell__tip {
      position: absolute;
      inset-block-start: calc(100% + 0.25rem);
      inset-inline-start: 0;
      z-index: 20;
      display: none;
      width: max-content;
      max-width: min(16rem, 70vw);
      padding: 0.25rem 0.5rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: var(--color-surface-3);
      color: var(--color-text);
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1rem;
      text-align: start;
      white-space: normal;
      pointer-events: none;
    }
    .spell:hover .spell__tip,
    .spell:focus .spell__tip,
    .spell--open .spell__tip {
      display: block;
    }
    @container loadout-section (min-width: 28rem) {
      .slot {
        grid-template-columns: 5.5rem 2rem minmax(0, 1fr) auto;
        grid-template-areas: 'label icon text spells';
        align-items: center;
        column-gap: 0.75rem;
      }
      .slot__icon {
        align-self: center;
      }
      .slot__spells {
        margin: 0;
        justify-content: flex-end;
      }
      .spell__tip {
        inset-inline-start: auto;
        inset-inline-end: 0;
      }
    }
    .skeleton {
      height: 2.25rem;
      margin-block: 0.4375rem;
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
    }
    @media (prefers-reduced-motion: no-preference) {
      .skeleton {
        animation: loadout-pulse 1.4s ease-in-out infinite;
      }
    }
    @keyframes loadout-pulse {
      50% {
        opacity: 0.5;
      }
    }
  `,
  template: `
    <div class="loadout" [attr.aria-busy]="loading()">
      @if (loading()) {
        <div role="status">
          <span class="sr-only">{{ t('loadout.loading') }}</span>
          <div class="skeleton" aria-hidden="true"></div>
          <div class="skeleton" aria-hidden="true"></div>
          <div class="skeleton" aria-hidden="true"></div>
          <div class="skeleton" aria-hidden="true"></div>
        </div>
      } @else if (unavailable()) {
        <p class="loadout__message" role="status">{{ t('loadout.unavailable') }}</p>
      } @else if (!hasItems()) {
        <p class="loadout__message">{{ t('loadout.empty') }}</p>
      } @else {
        <div class="loadout__grid" [class.loadout__grid--paired]="swapRows().length > 0">
          <section class="loadout__section" [attr.aria-labelledby]="mainHeadingId">
            <h3
              class="loadout__heading"
              [class.sr-only]="swapRows().length === 0"
              [id]="mainHeadingId"
            >
              {{ t('loadout.main') }}
            </h3>
            <ul class="slots">
              @for (row of mainRows(); track row.id) {
                <ng-container *ngTemplateOutlet="slotRow; context: { $implicit: row }" />
              }
            </ul>
          </section>

          @if (swapRows().length > 0) {
            <section class="loadout__section" [attr.aria-labelledby]="swapHeadingId">
              <h3 class="loadout__heading" [id]="swapHeadingId">{{ t('loadout.swap') }}</h3>
              <p class="loadout__hint">{{ t('loadout.swapHint') }}</p>
              <ul class="slots">
                @for (row of swapRows(); track row.id) {
                  <ng-container *ngTemplateOutlet="slotRow; context: { $implicit: row }" />
                }
              </ul>
            </section>
          }
        </div>
      }
    </div>

    <ng-template #slotRow let-row>
      <li class="slot">
        <span class="slot__label">{{ row.slotLabel }}</span>
        <span class="slot__icon">
          @if (row.item && row.iconUrl && !iconFailed(row.iconUrl)) {
            <img
              [src]="row.iconUrl"
              alt=""
              width="32"
              height="32"
              loading="lazy"
              (error)="markIconFailed(row.iconUrl)"
            />
          } @else {
            <span aria-hidden="true">{{ row.item ? initial(row.name) : '–' }}</span>
          }
        </span>
        <span class="slot__text">
          @if (row.item) {
            <span class="slot__name">{{ row.name }}</span>
            @if (row.tier) {
              <span class="slot__tier">{{ row.tier }}</span>
            }
            @if (row.qualityText) {
              <span class="slot__quality">{{ row.qualityText }}</span>
            }
            @if (row.replaces) {
              <span class="slot__replaces">{{ t('loadout.replaces', { item: row.replaces }) }}</span>
            }
          } @else {
            <span class="slot__empty">{{ t('loadout.slotEmpty') }}</span>
          }
        </span>
        @if (row.spells.length > 0) {
          <ul class="slot__spells" [attr.aria-label]="t('loadout.spells')">
            @for (spell of row.spells; track spell.key + spell.id) {
              <li>
                <button
                  type="button"
                  class="spell"
                  [class.spell--open]="openSpell() === row.id + spell.id"
                  [attr.aria-label]="spell.key + ': ' + spell.name"
                  (click)="toggleSpell(row.id + spell.id)"
                  (blur)="closeSpell()"
                >
                  @if (!iconFailed(spell.iconUrl)) {
                    <img
                      [src]="spell.iconUrl"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                      (error)="markIconFailed(spell.iconUrl)"
                    />
                  } @else {
                    <span aria-hidden="true">{{ spell.key }}</span>
                  }
                  <span class="spell__tip" aria-hidden="true">{{ spell.key }} · {{ spell.name }}</span>
                </button>
              </li>
            }
          </ul>
        }
      </li>
    </ng-template>
  `,
})
export class LoadoutView {
  private readonly translate = inject(TranslateService);
  private readonly abilities = inject(AlbionAbilitiesService);
  private readonly uid = ++nextLoadoutId;

  /**
   * The build's items, both loadouts mixed (`BuildDetail.items`). An item with no `loadout` counts
   * as part of the main set, like everywhere else.
   */
  readonly items = input<readonly BuildItemSlot[] | null | undefined>(undefined);
  /** Shows a skeleton instead of the rows while the build's detail is being fetched. */
  readonly loading = input(false);
  /** True when the build's detail could not be loaded; shows an unavailable message. */
  readonly unavailable = input(false);

  protected readonly mainHeadingId = `loadout-main-${this.uid}`;
  protected readonly swapHeadingId = `loadout-swap-${this.uid}`;

  private readonly catalog = signal<Readonly<Record<string, OpenAlbionItemAbilities>>>({});
  private readonly failedImages = signal<ReadonlySet<string>>(new Set());
  /** Identifies the spell whose name is pinned open by a tap or click (touch has no hover). */
  protected readonly openSpell = signal<string | null>(null);

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  /** Spell id to display name, from the shared ability catalog. */
  private readonly spellNames = computed(() => {
    const names = new Map<string, string>();
    for (const entry of Object.values(this.catalog())) {
      for (const choices of [...Object.values(entry.active), ...Object.values(entry.passive)]) {
        for (const choice of choices) {
          names.set(choice.id, choice.name);
        }
      }
    }
    return names;
  });

  protected readonly hasItems = computed(() => (this.items()?.length ?? 0) > 0);
  private readonly mainItems = computed(() => this.itemsFor('main'));
  private readonly swapItems = computed(() => this.itemsFor('swap'));

  protected readonly mainRows = computed<LoadoutRow[]>(() => {
    const present = new Map(this.mainItems().map((item) => [item.slot, item] as const));
    return SLOT_ORDER.flatMap((slot) => {
      const item = present.get(slot) ?? null;
      if (!item && !CORE_SLOTS.has(slot)) {
        return [];
      }
      return [this.toRow('main', slot, item, null)];
    });
  });

  protected readonly swapRows = computed<LoadoutRow[]>(() => {
    const main = new Map(this.mainItems().map((item) => [item.slot, item] as const));
    const swap = new Map(this.swapItems().map((item) => [item.slot, item] as const));
    return SLOT_ORDER.flatMap((slot) => {
      const item = swap.get(slot);
      return item ? [this.toRow('swap', slot, item, main.get(slot)?.openalbion_item_name ?? null)] : [];
    });
  });

  constructor() {
    // Static application data; one fetch serves every loadout on the page.
    void this.abilities
      .load()
      .then((catalog) => this.catalog.set(catalog))
      .catch(() => this.catalog.set({}));
  }

  private itemsFor(loadout: 'main' | 'swap'): BuildItemSlot[] {
    return (this.items() ?? []).filter((item) => (item.loadout ?? 'main') === loadout);
  }

  private toRow(
    loadout: 'main' | 'swap',
    slot: BuildSlot,
    item: BuildItemSlot | null,
    replaces: string | null,
  ): LoadoutRow {
    const slotLabel = this.translate.t(SLOT_LABEL_KEYS[slot]);
    if (!item) {
      return {
        id: `${loadout}-${slot}`,
        slotLabel,
        item: null,
        name: '',
        tier: '',
        qualityText: null,
        iconUrl: '',
        spells: [],
        replaces: null,
      };
    }
    const supportsQuality = this.supportsQuality(item);
    const quality = item.openalbion_item_quality;
    const showQuality =
      supportsQuality &&
      quality != null &&
      isAlbionItemQuality(quality) &&
      quality !== DEFAULT_ALBION_ITEM_QUALITY;
    return {
      id: `${loadout}-${slot}`,
      slotLabel,
      item,
      name: item.openalbion_item_name,
      tier: albionTierLabel(item.openalbion_item_tier, item.openalbion_item_enchantment),
      qualityText: showQuality ? this.translate.t(QUALITY_LABEL_KEYS[quality as number]) : null,
      iconUrl: albionIconUrlWithQuality(item.openalbion_item_icon, supportsQuality ? quality : 1),
      spells: this.spellsFor(item),
      replaces,
    };
  }

  private supportsQuality(item: BuildItemSlot): boolean {
    if (item.slot === 'potion' || item.slot === 'food' || item.slot === 'mount') {
      return false;
    }
    const identifier = item.openalbion_item_icon?.match(/\/item\/([^.?]+)/)?.[1];
    return albionItemSupportsQuality(identifier);
  }

  private spellsFor(item: BuildItemSlot): SpellView[] {
    const names = this.spellNames();
    const keys = ACTIVE_KEYS[item.slot] ?? [];
    const view = (id: string, key: string): SpellView => ({
      id,
      key,
      name: names.get(id) ?? id,
      iconUrl: albionAbilityIconUrl(id),
    });
    const actives = Object.entries(item.spells?.active ?? {})
      .map(([index, id]) => [Number(index), id] as const)
      .sort(([left], [right]) => left - right)
      .map(([index, id]) => view(id, keys[index - 1] ?? String(index)));
    const passives = Object.entries(item.spells?.passive ?? {})
      .map(([index, id]) => [Number(index), id] as const)
      .sort(([left], [right]) => left - right)
      .map(([, id]) => view(id, this.translate.t('loadout.passive')));
    return [...actives, ...passives];
  }

  protected iconFailed(url: string): boolean {
    return this.failedImages().has(url);
  }

  protected markIconFailed(url: string): void {
    this.failedImages.update((current) => new Set(current).add(url));
  }

  protected initial(name: string): string {
    return name.trim().charAt(0).toUpperCase();
  }

  protected toggleSpell(id: string): void {
    this.openSpell.update((current) => (current === id ? null : id));
  }

  protected closeSpell(): void {
    if (this.openSpell() !== null) {
      this.openSpell.set(null);
    }
  }
}
