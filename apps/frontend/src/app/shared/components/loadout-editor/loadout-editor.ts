import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type {
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  OpenAlbionItem,
  OpenAlbionItemAbilities,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import {
  BUILD_ITEM_TIERS,
  DEFAULT_BUILD_ITEM_TIER,
  SLOT_LABEL_KEYS,
  SLOT_ORDER,
  slotSupportsEnchantment,
  slotSupportsQuality,
} from '../../../features/comps/build-loadouts';
import {
  abilityCatalogKey,
  abilityKeyForItem,
  abilitySlotsFor,
  withAbilityChoice,
} from '../../data/albion-abilities';
import {
  albionItemSupportsEnchantment,
  albionItemSupportsQuality,
  filterAlbionEquipmentCatalog,
} from '../../data/albion-equipment-catalog';
import {
  albionTierLabel,
  normalizeAlbionItemEnchantment,
} from '../../data/albion-item-enchantment';
import {
  DEFAULT_ALBION_ITEM_QUALITY,
  albionIconUrlWithQuality,
  normalizeAlbionItemQuality,
} from '../../data/albion-item-quality';
import { AlbionAbilitiesService } from '../../services/albion-abilities.service';
import { AlbionCatalogService } from '../../services/albion-catalog.service';
import type { AbilityChoiceChange } from '../ability-bar/ability-bar';
import { Icon } from '../icon/icon';
import { ViewToggle, type ViewToggleOption } from '../view-toggle/view-toggle';
import { SlotInspector } from './slot-inspector';

/** One slot that differs between the saved loadout and the draft. */
export interface LoadoutChange {
  readonly loadout: BuildLoadout;
  readonly slot: BuildSlot;
  /** The slot's new item, or `null` when the slot was cleared (or, in the swap, reverted to main). */
  readonly item: BuildItemSlot | null;
}

/** One line of the editor list. */
interface EditorRow {
  readonly id: string;
  readonly loadout: BuildLoadout;
  readonly slot: BuildSlot;
  readonly slotLabel: string;
  readonly item: BuildItemSlot | null;
  /** Swap rows without an item: the main item this slot falls back to. */
  readonly mainName: string | null;
  readonly name: string;
  readonly tier: string;
  readonly qualityText: string | null;
  readonly iconUrl: string;
  /** The chosen spells as one line, for example `Q Heroic Strike · Passive Deep Cuts`. */
  readonly spells: string;
  readonly edited: boolean;
}

type DraftKey = `${BuildLoadout}:${BuildSlot}`;

const keyOf = (loadout: BuildLoadout, slot: BuildSlot): DraftKey => `${loadout}:${slot}`;

/** The in-game key each slot's active spells are bound to. */
const ACTIVE_KEYS: Partial<Record<BuildSlot, readonly string[]>> = {
  weapon: ['Q', 'W', 'E'],
  head: ['D'],
  armor: ['R'],
  shoes: ['F'],
};

/** Slots that usually differ in a swap, copied by "copy from main". */
const SWAP_COPY_SLOTS: readonly BuildSlot[] = ['weapon', 'off_hand'];

/** How long the search waits for more typing before it filters. */
const SEARCH_DELAY_MS = 200;

const EMPTY_SPELLS = (): BuildItemSlot['spells'] => ({ active: {}, passive: {} });

function canonicalSpells(item: BuildItemSlot): string {
  const sorted = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).sort(([left], [right]) => Number(left) - Number(right));
  return JSON.stringify([sorted(item.spells?.active), sorted(item.spells?.passive)]);
}

/** True when two drafts describe the same equipped item, ignoring fields the slot does not have. */
function sameItem(left: BuildItemSlot | null, right: BuildItemSlot | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.openalbion_item_id === right.openalbion_item_id &&
    albionTierLabel(left.openalbion_item_tier, 0) === albionTierLabel(right.openalbion_item_tier, 0) &&
    normalizeAlbionItemEnchantment(left.openalbion_item_enchantment) ===
      normalizeAlbionItemEnchantment(right.openalbion_item_enchantment) &&
    (!slotSupportsQuality(left.slot) ||
      normalizeAlbionItemQuality(left.openalbion_item_quality) ===
        normalizeAlbionItemQuality(right.openalbion_item_quality)) &&
    canonicalSpells(left) === canonicalSpells(right)
  );
}

/**
 * Editor for a build's loadout: one row per slot, one slot inspector, one Save.
 *
 * Replaces the paper doll whose every slot turned interactive and opened a dialog inside a dialog.
 * The editor lists the slots in the same order as `app-loadout-view` (weapon, off-hand, head,
 * armor, shoes, cape, bag, food, potion, mount). Choosing a row opens a single inspector sheet
 * (`app-slot-inspector`) with item search, tier / enchantment / quality as segmented controls, the
 * item's ability choices as named chips and "Clear slot". Every edit lands in a draft; nothing is
 * saved until the editor's Save, which reports all changes at once, and Discard throws the draft
 * away. The bar shows how many slots differ from the saved loadout.
 *
 * The swap tab lists the same slots but reads as "differences from main": a slot with no swap item
 * says "Same as main" and falls back to the main item. "Copy from main" fills an empty swap weapon
 * and off-hand from the main set, and an inspector button reverts a slot to main.
 *
 * The component never calls the API. The host persists `save`'s changes (or, with
 * `[showActions]="false"`, listens to `itemsChange` and owns Save itself, as a create dialog does).
 *
 * @example
 * ```html
 * <app-loadout-editor
 *   [items]="build.items"
 *   [saving]="saving()"
 *   (save)="saveLoadout($event)"
 *   (discard)="exitEdit()"
 *   (dirtyChange)="dirty.set($event)"
 * />
 * ```
 */
@Component({
  selector: 'app-loadout-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SlotInspector, ViewToggle],
  styles: `
    :host {
      display: block;
      min-width: 0;
      color: var(--color-text);
    }
    .le__tools {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      margin-block-end: 0.5rem;
    }
    .le__hint {
      margin: 0 0 0.5rem;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .le__rows {
      margin: 0;
      padding: 0;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .le__rows > li + li {
      border-top: 1px solid var(--color-border);
    }
    .row {
      display: grid;
      grid-template-columns: 5rem 2rem minmax(0, 1fr) auto;
      align-items: center;
      column-gap: 0.75rem;
      width: 100%;
      min-height: 3rem;
      padding: 0.5rem 0.75rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .row--selected {
      background: var(--color-surface-2);
    }
    @media (max-width: 30rem) {
      .row {
        grid-template-columns: 2rem minmax(0, 1fr) auto;
        grid-template-areas:
          'icon label chev'
          'icon text chev';
        column-gap: 0.625rem;
      }
      .row__label {
        grid-area: label;
      }
      .row__icon {
        grid-area: icon;
        align-self: start;
      }
      .row__text {
        grid-area: text;
      }
      .row__end {
        grid-area: chev;
      }
    }
    .row__label {
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .row__icon {
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
    .row__icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .row__text {
      min-width: 0;
      font-size: 0.875rem;
      line-height: 1.25rem;
    }
    .row__name {
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .row__empty,
    .row__inherit {
      color: var(--color-text-secondary);
    }
    .row__tier {
      margin-inline-start: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .row__quality {
      margin-inline-start: 0.375rem;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .row__spells {
      display: block;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
      overflow-wrap: anywhere;
    }
    .row__end {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--color-text-secondary);
    }
    .row__edited {
      padding: 0 0.375rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text);
    }
    .bar {
      position: sticky;
      inset-block-end: 0;
      z-index: 5;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      margin-block-start: 0.75rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .bar__status {
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .bar__status--dirty {
      color: var(--color-text);
      font-weight: 500;
    }
    .bar__actions {
      display: flex;
      gap: 0.5rem;
    }
  `,
  template: `
    <div role="group" [attr.aria-label]="t('loadoutEditor.title')">
      <div class="le__tools">
        @if (allowSwap()) {
          <app-view-toggle [options]="tabOptions()" [active]="tab()" (activeChange)="setTab($event)" />
        }
        @if (tab() === 'swap') {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            [disabled]="!canCopyFromMain()"
            (click)="copyWeaponsFromMain()"
          >
            {{ t('loadoutEditor.swap.copy') }}
          </button>
        }
      </div>

      @if (tab() === 'swap') {
        <p class="le__hint">{{ t('loadoutEditor.swap.hint') }}</p>
      }

      <ul class="le__rows">
        @for (row of rows(); track row.id) {
          <li>
            <button
              type="button"
              class="row"
              aria-haspopup="dialog"
              [class.row--selected]="isSelected(row)"
              [attr.aria-label]="rowLabel(row)"
              (click)="openSlot(row.loadout, row.slot)"
            >
              <span class="row__label">{{ row.slotLabel }}</span>
              <span class="row__icon">
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
                  <span aria-hidden="true">{{ row.item ? row.name.charAt(0).toUpperCase() : '–' }}</span>
                }
              </span>
              <span class="row__text">
                @if (row.item) {
                  <span class="row__name">{{ row.name }}</span>
                  <span class="row__tier">{{ row.tier }}</span>
                  @if (row.qualityText) {
                    <span class="row__quality">{{ row.qualityText }}</span>
                  }
                  @if (row.spells) {
                    <span class="row__spells">{{ row.spells }}</span>
                  }
                } @else if (row.loadout === 'swap') {
                  <span class="row__inherit">
                    {{
                      row.mainName
                        ? t('loadoutEditor.swap.sameAsMainWith', { item: row.mainName })
                        : t('loadoutEditor.swap.sameAsMain')
                    }}
                  </span>
                } @else {
                  <span class="row__empty">{{ t('loadoutEditor.row.empty') }}</span>
                }
              </span>
              <span class="row__end">
                @if (row.edited) {
                  <span class="row__edited">{{ t('loadoutEditor.row.edited') }}</span>
                }
                <app-icon name="chevron-right" size="1rem" />
              </span>
            </button>
          </li>
        }
      </ul>

      @if (showActions()) {
        <div class="bar" role="group" [attr.aria-label]="t('loadoutEditor.bar')">
          <span class="bar__status" [class.bar__status--dirty]="dirty() > 0" role="status">
            {{
              dirty() === 0
                ? t('loadoutEditor.noChanges')
                : t('loadoutEditor.unsaved', { count: dirty() })
            }}
          </span>
          <span class="bar__actions">
            <button type="button" class="btn btn--ghost btn--sm" [disabled]="saving()" (click)="discard.emit()">
              {{ t('loadoutEditor.discard') }}
            </button>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              [disabled]="saving() || dirty() === 0"
              (click)="save.emit(changes())"
            >
              {{ saving() ? t('loadoutEditor.saving') : t('loadoutEditor.save') }}
            </button>
          </span>
        </div>
      }

      @if (selected(); as target) {
        <app-slot-inspector
          [slot]="target.slot"
          [loadout]="target.loadout"
          [item]="selectedItem()"
          [mainItem]="selectedMainItem()"
          [tiers]="inspectorTiers()"
          [searchTier]="searchTier()"
          [query]="query()"
          [results]="results()"
          [searching]="searching()"
          [searchFailed]="searchFailed()"
          [abilitySlots]="selectedAbilitySlots()"
          (queryChange)="onQueryChange($event)"
          (tierChange)="onTierChange($event)"
          (itemPick)="pickItem($event)"
          (enchantmentChange)="setEnchantment($event)"
          (qualityChange)="setQuality($event)"
          (abilityChange)="setAbility($event)"
          (clear)="clearSelected()"
          (copyFromMain)="copySelectedFromMain()"
          (closed)="closeSlot()"
        />
      }
    </div>
  `,
})
export class LoadoutEditor {
  private readonly translate = inject(TranslateService);
  private readonly catalogService = inject(AlbionCatalogService);
  private readonly abilitiesService = inject(AlbionAbilitiesService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * The saved items, both loadouts mixed, exactly as `BuildDetail.items` delivers them (an empty
   * list for a build that does not exist yet). The draft is kept as differences from this list, so
   * when the host reloads the build after a partial save the changes already stored drop out of the
   * unsaved count by themselves.
   */
  readonly items = input<readonly BuildItemSlot[]>([]);
  /** Shows the Main / Swap tabs. Without them the editor edits the main loadout only. */
  readonly allowSwap = input(true);
  /** Shows the bar with the unsaved count, Discard and Save. Hide it when the host has its own. */
  readonly showActions = input(true);
  /** The host is saving: Discard and Save are disabled. */
  readonly saving = input(false);
  /** Tiers offered by the tier control (the item's own tier is always added). */
  readonly tiers = input<readonly string[]>(BUILD_ITEM_TIERS);

  /** Save was pressed. Carries every slot that differs from `items`, main before swap. */
  readonly save = output<readonly LoadoutChange[]>();
  /** Discard was pressed. The host decides whether to confirm and leaves the editor. */
  readonly discard = output<void>();
  /** Number of slots that differ from `items`; fires on every edit and whenever `items` changes. */
  readonly dirtyChange = output<number>();
  /** The whole draft (both loadouts, saved items plus edits) after every edit. */
  readonly itemsChange = output<readonly BuildItemSlot[]>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly tab = signal<BuildLoadout>('main');
  protected readonly selected = signal<{ loadout: BuildLoadout; slot: BuildSlot } | null>(null);

  /** Slots edited since `items`, as `null` for a cleared slot. Entries equal to the saved item are removed. */
  private readonly overrides = signal<ReadonlyMap<DraftKey, BuildItemSlot | null>>(new Map());
  private readonly failedImages = signal<ReadonlySet<string>>(new Set());
  private readonly abilityCatalog = signal<Readonly<Record<string, OpenAlbionItemAbilities>>>({});

  // ---- item search ------------------------------------------------------------------------
  protected readonly query = signal('');
  protected readonly searchTier = signal(DEFAULT_BUILD_ITEM_TIER);
  protected readonly results = signal<readonly OpenAlbionItem[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchFailed = signal(false);
  private catalog: readonly OpenAlbionItem[] | null = null;
  private searchRun = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly baseline = computed(() => {
    const map = new Map<DraftKey, BuildItemSlot>();
    for (const item of this.items()) {
      map.set(keyOf(item.loadout ?? 'main', item.slot), item);
    }
    return map;
  });

  /** The draft's item for a slot: the edit if there is one, else the saved item. */
  private effective(loadout: BuildLoadout, slot: BuildSlot): BuildItemSlot | null {
    const key = keyOf(loadout, slot);
    const overrides = this.overrides();
    return overrides.has(key) ? (overrides.get(key) ?? null) : (this.baseline().get(key) ?? null);
  }

  /** Slots that differ from the saved loadout, main before swap, in slot order. */
  protected readonly changes = computed<LoadoutChange[]>(() => {
    const overrides = this.overrides();
    const list: LoadoutChange[] = [];
    for (const loadout of ['main', 'swap'] as const) {
      for (const slot of SLOT_ORDER) {
        const key = keyOf(loadout, slot);
        if (overrides.has(key) && !sameItem(overrides.get(key) ?? null, this.baseline().get(key) ?? null)) {
          list.push({ loadout, slot, item: overrides.get(key) ?? null });
        }
      }
    }
    return list;
  });

  protected readonly dirty = computed(() => this.changes().length);

  /** Every equipped item of the draft, both loadouts. */
  private readonly draftItems = computed<BuildItemSlot[]>(() => {
    this.overrides();
    return (['main', 'swap'] as const).flatMap((loadout) =>
      SLOT_ORDER.flatMap((slot) => {
        const item = this.effective(loadout, slot);
        return item ? [item] : [];
      }),
    );
  });

  protected readonly tabOptions = computed<readonly ViewToggleOption[]>(() => [
    { id: 'main', label: this.t('loadout.main') },
    { id: 'swap', label: this.t('loadout.swap') },
  ]);

  private readonly spellNames = computed(() => {
    const names = new Map<string, string>();
    for (const entry of Object.values(this.abilityCatalog())) {
      for (const choices of [...Object.values(entry.active), ...Object.values(entry.passive)]) {
        for (const choice of choices) {
          names.set(choice.id, choice.name);
        }
      }
    }
    return names;
  });

  protected readonly rows = computed<EditorRow[]>(() => {
    const loadout = this.tab();
    const overrides = this.overrides();
    return SLOT_ORDER.map((slot) => {
      const item = this.effective(loadout, slot);
      const main = loadout === 'swap' ? this.effective('main', slot) : null;
      const edited = overrides.has(keyOf(loadout, slot));
      return this.toRow(loadout, slot, item, main?.openalbion_item_name ?? null, edited);
    });
  });

  protected readonly selectedItem = computed(() => {
    const target = this.selected();
    this.overrides();
    return target ? this.effective(target.loadout, target.slot) : null;
  });

  protected readonly selectedMainItem = computed(() => {
    const target = this.selected();
    this.overrides();
    return target?.loadout === 'swap' ? this.effective('main', target.slot) : null;
  });

  protected readonly selectedAbilitySlots = computed(() => {
    const item = this.selectedItem();
    const target = this.selected();
    if (!item || !target) {
      return [];
    }
    const key = abilityKeyForItem(item);
    return abilitySlotsFor(
      target.slot,
      key ? this.abilityCatalog()[key] : undefined,
      item.spells,
      this.t('loadout.passive'),
    );
  });

  /** The configured tiers plus the selected item's own tier, so an older tier never vanishes. */
  protected readonly inspectorTiers = computed(() => {
    const tiers = [...this.tiers()];
    const own = albionTierLabel(this.selectedItem()?.openalbion_item_tier, 0);
    if (own && !tiers.includes(own)) {
      tiers.push(own);
      tiers.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
    }
    return tiers;
  });

  protected readonly canCopyFromMain = computed(() =>
    SWAP_COPY_SLOTS.some((slot) => this.effective('swap', slot) === null && this.effective('main', slot) !== null),
  );

  constructor() {
    // Static application data; one fetch serves every editor in the session.
    void this.abilitiesService
      .load()
      .then((abilities) => this.abilityCatalog.set(abilities))
      .catch(() => this.abilityCatalog.set({}));

    effect(() => this.dirtyChange.emit(this.dirty()));
    effect(() => this.itemsChange.emit(this.draftItems()));

    this.destroyRef.onDestroy(() => this.clearSearchTimer());
  }

  // ---- rows ---------------------------------------------------------------------------------

  private toRow(
    loadout: BuildLoadout,
    slot: BuildSlot,
    item: BuildItemSlot | null,
    mainName: string | null,
    edited: boolean,
  ): EditorRow {
    const base = {
      id: keyOf(loadout, slot),
      loadout,
      slot,
      slotLabel: this.t(SLOT_LABEL_KEYS[slot]),
      mainName,
      edited,
    };
    if (!item) {
      return { ...base, item: null, name: '', tier: '', qualityText: null, iconUrl: '', spells: '' };
    }
    const supportsQuality = slotSupportsQuality(slot) && albionItemSupportsQuality(this.identifierOf(item));
    const quality = normalizeAlbionItemQuality(item.openalbion_item_quality);
    return {
      ...base,
      item,
      name: item.openalbion_item_name,
      tier: albionTierLabel(item.openalbion_item_tier, item.openalbion_item_enchantment),
      qualityText:
        supportsQuality && quality !== DEFAULT_ALBION_ITEM_QUALITY
          ? this.t(`loadout.quality.${quality}` as TranslationKey)
          : null,
      iconUrl: albionIconUrlWithQuality(item.openalbion_item_icon, supportsQuality ? quality : 1),
      spells: this.spellLine(item),
    };
  }

  private spellLine(item: BuildItemSlot): string {
    const names = this.spellNames();
    const keys = ACTIVE_KEYS[item.slot] ?? [];
    const sorted = (record: Record<string, string> | undefined) =>
      Object.entries(record ?? {}).sort(([left], [right]) => Number(left) - Number(right));
    return [
      ...sorted(item.spells?.active).map(
        ([index, id]) => `${keys[Number(index) - 1] ?? index} ${names.get(id) ?? id}`,
      ),
      ...sorted(item.spells?.passive).map(([, id]) => `${this.t('loadout.passive')} ${names.get(id) ?? id}`),
    ].join(' · ');
  }

  /** The catalog identifier (`T8_2H_BOW`) behind an item, read back out of its icon URL. */
  private identifierOf(item: BuildItemSlot): string | null {
    return item.openalbion_item_icon?.match(/\/item\/([^.?]+)/)?.[1] ?? null;
  }

  protected rowLabel(row: EditorRow): string {
    const state = row.item
      ? `${row.name} ${row.tier}`
      : row.loadout === 'swap'
        ? this.t('loadoutEditor.swap.sameAsMain')
        : this.t('loadoutEditor.row.empty');
    const edited = row.edited ? `, ${this.t('loadoutEditor.row.edited')}` : '';
    return `${row.slotLabel}: ${state}${row.spells ? `, ${row.spells}` : ''}${edited}`;
  }

  protected isSelected(row: EditorRow): boolean {
    const target = this.selected();
    return target?.loadout === row.loadout && target.slot === row.slot;
  }

  protected iconFailed(url: string): boolean {
    return this.failedImages().has(url);
  }

  protected markIconFailed(url: string): void {
    this.failedImages.update((current) => new Set(current).add(url));
  }

  // ---- tabs and slot selection ---------------------------------------------------------------

  protected setTab(id: string): void {
    this.tab.set(id === 'swap' ? 'swap' : 'main');
    this.closeSlot();
  }

  protected openSlot(loadout: BuildLoadout, slot: BuildSlot): void {
    const item = this.effective(loadout, slot) ?? (loadout === 'swap' ? this.effective('main', slot) : null);
    this.selected.set({ loadout, slot });
    this.query.set('');
    this.searchTier.set(
      item ? albionTierLabel(item.openalbion_item_tier, 0) || DEFAULT_BUILD_ITEM_TIER : DEFAULT_BUILD_ITEM_TIER,
    );
    void this.runSearch();
  }

  protected closeSlot(): void {
    this.selected.set(null);
    this.clearSearchTimer();
    this.results.set([]);
  }

  // ---- draft edits ----------------------------------------------------------------------------

  private setDraft(loadout: BuildLoadout, slot: BuildSlot, item: BuildItemSlot | null): void {
    const key = keyOf(loadout, slot);
    const next = new Map(this.overrides());
    if (sameItem(item, this.baseline().get(key) ?? null)) {
      next.delete(key);
    } else {
      next.set(key, item);
    }
    this.overrides.set(next);
  }

  /** Edits the item of the open slot in place. */
  private updateSelected(change: (item: BuildItemSlot) => BuildItemSlot): void {
    const target = this.selected();
    const item = this.selectedItem();
    if (!target || !item) {
      return;
    }
    this.setDraft(target.loadout, target.slot, change(item));
  }

  protected setEnchantment(level: number): void {
    this.updateSelected((item) => ({
      ...item,
      openalbion_item_enchantment: normalizeAlbionItemEnchantment(level),
    }));
  }

  protected setQuality(quality: number): void {
    this.updateSelected((item) => ({
      ...item,
      openalbion_item_quality: normalizeAlbionItemQuality(quality),
    }));
  }

  protected setAbility(change: AbilityChoiceChange): void {
    this.updateSelected((item) => ({
      ...item,
      spells: withAbilityChoice(item.spells, change.kind, change.index, change.spellId),
    }));
  }

  /** "Clear slot" on the main loadout, "Same as main" on the swap: both empty the slot's draft. */
  protected clearSelected(): void {
    const target = this.selected();
    if (target) {
      this.setDraft(target.loadout, target.slot, null);
    }
  }

  protected copySelectedFromMain(): void {
    const target = this.selected();
    const main = this.selectedMainItem();
    if (target && main) {
      this.setDraft(target.loadout, target.slot, { ...main, loadout: 'swap', spells: this.cloneSpells(main) });
    }
  }

  protected copyWeaponsFromMain(): void {
    for (const slot of SWAP_COPY_SLOTS) {
      const main = this.effective('main', slot);
      if (main && this.effective('swap', slot) === null) {
        this.setDraft('swap', slot, { ...main, loadout: 'swap', spells: this.cloneSpells(main) });
      }
    }
  }

  private cloneSpells(item: BuildItemSlot): BuildItemSlot['spells'] {
    return {
      active: { ...(item.spells?.active ?? {}) },
      passive: { ...(item.spells?.passive ?? {}) },
    };
  }

  /**
   * Puts a catalog item into the open slot.
   *
   * Tier-independent choices carry over from whatever was there: quality and enchantment (where
   * the new item has them) and the abilities when the item is the same family at another tier. A
   * different family offers different abilities, so those start empty.
   */
  protected pickItem(result: OpenAlbionItem): void {
    const target = this.selected();
    if (!target) {
      return;
    }
    const previous = this.effective(target.loadout, target.slot);
    this.setDraft(target.loadout, target.slot, this.itemFromCatalog(target, result, previous));
  }

  private itemFromCatalog(
    target: { loadout: BuildLoadout; slot: BuildSlot },
    result: OpenAlbionItem,
    previous: BuildItemSlot | null,
  ): BuildItemSlot {
    const supportsQuality = slotSupportsQuality(target.slot) && albionItemSupportsQuality(result.identifier);
    const supportsEnchantment =
      slotSupportsEnchantment(target.slot) && albionItemSupportsEnchantment(result.identifier);
    const family = result.identifier ? abilityCatalogKey(result.identifier) : null;
    const sameFamily = previous !== null && family !== null && family === abilityKeyForItem(previous);
    return {
      loadout: target.loadout,
      slot: target.slot,
      openalbion_item_type: result.type,
      openalbion_item_id: result.id,
      openalbion_item_name: result.name,
      openalbion_item_icon: result.icon ?? null,
      openalbion_item_tier: albionTierLabel(result.tier, 0),
      openalbion_item_quality: supportsQuality
        ? normalizeAlbionItemQuality(previous?.openalbion_item_quality)
        : DEFAULT_ALBION_ITEM_QUALITY,
      openalbion_item_enchantment: supportsEnchantment
        ? normalizeAlbionItemEnchantment(previous?.openalbion_item_enchantment)
        : 0,
      spells: sameFamily && previous ? this.cloneSpells(previous) : EMPTY_SPELLS(),
    };
  }

  // ---- item search ----------------------------------------------------------------------------

  protected onQueryChange(query: string): void {
    this.query.set(query);
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => void this.runSearch(), SEARCH_DELAY_MS);
  }

  /**
   * Changing the tier re-tiers the chosen item (the same weapon or armor at the new tier) and
   * filters the search to it. When the family does not exist at that tier the item stays as it is
   * and only the search moves.
   */
  protected onTierChange(tier: string): void {
    this.searchTier.set(tier);
    const target = this.selected();
    const item = this.selectedItem();
    const identifier = item ? this.identifierOf(item) : null;
    if (target && item && identifier && this.catalog) {
      const retiered = `${tier}_${identifier.replace(/^T\d+_/i, '')}`.toUpperCase();
      const match = this.catalog.find((entry) => entry.identifier?.toUpperCase() === retiered);
      if (match) {
        this.setDraft(target.loadout, target.slot, this.itemFromCatalog(target, match, item));
      }
    }
    void this.runSearch();
  }

  private async runSearch(): Promise<void> {
    const target = this.selected();
    if (!target) {
      this.results.set([]);
      return;
    }
    const run = ++this.searchRun;
    this.searching.set(true);
    this.searchFailed.set(false);
    try {
      const catalog = this.catalog ?? (await this.catalogService.load());
      this.catalog = catalog;
      if (run !== this.searchRun) {
        return;
      }
      this.results.set(
        filterAlbionEquipmentCatalog(catalog, this.query(), target.slot, this.searchTier()),
      );
    } catch {
      if (run !== this.searchRun) {
        return;
      }
      this.results.set([]);
      this.searchFailed.set(true);
    } finally {
      if (run === this.searchRun) {
        this.searching.set(false);
      }
    }
  }

  private clearSearchTimer(): void {
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }
}
