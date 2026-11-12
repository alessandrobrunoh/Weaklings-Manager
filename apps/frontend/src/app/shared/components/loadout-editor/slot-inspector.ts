import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type {
  BuildItemSlot,
  BuildLoadout,
  BuildSlot,
  OpenAlbionItem,
} from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import {
  SLOT_LABEL_KEYS,
  slotSupportsEnchantment,
  slotSupportsQuality,
} from '../../../features/comps/build-loadouts';
import type { AbilitySlotView } from '../../data/albion-abilities';
import {
  albionItemSupportsEnchantment,
  albionItemSupportsQuality,
} from '../../data/albion-equipment-catalog';
import { ALBION_ITEM_ENCHANTMENTS, albionTierLabel } from '../../data/albion-item-enchantment';
import {
  ALBION_ITEM_QUALITIES,
  albionIconUrlWithQuality,
  normalizeAlbionItemQuality,
} from '../../data/albion-item-quality';
import { AbilityBar, type AbilityChoiceChange } from '../ability-bar/ability-bar';
import { ChoiceGroup, type ChoiceOption } from '../choice-group/choice-group';
import { Icon } from '../icon/icon';

let nextInspectorId = 0;

/**
 * The single editor for one equipment slot of the loadout editor: a side sheet on wide screens and
 * a full-screen sheet on a phone, built on the native `<dialog>` (focus trap, Escape and the top
 * layer come from the browser).
 *
 * It is presentational. The loadout editor owns the draft and the item search, and passes the
 * current draft values in, so the tier, enchantment and quality controls always show what the item
 * really has (they used to show T2 / Plain / Normal for a T8.3 Excellent item).
 *
 * Contents, top to bottom: the current item, tier, item search (empty when the sheet opens) with
 * its results, enchantment and quality for the chosen item, the item's ability choices as named
 * chips (one control per ability slot) and the slot actions.
 *
 * The result list is an ARIA combobox/listbox driven from the search field with the arrow keys and
 * Enter, so the whole list costs one Tab stop. Edits apply to the loadout draft immediately; the
 * sheet has no Save of its own, only Done.
 */
@Component({
  selector: 'app-slot-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AbilityBar, ChoiceGroup, Icon],
  styles: `
    :host {
      display: contents;
    }
    .sheet {
      margin: 0;
      margin-inline-start: auto;
      padding: 0;
      border: 0;
      border-inline-start: 1px solid var(--color-border-strong);
      width: min(28rem, 100vw);
      max-width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      background: var(--color-surface);
      color: var(--color-text);
    }
    .sheet[open] {
      display: flex;
      flex-direction: column;
    }
    .sheet::backdrop {
      background: rgb(0 0 0 / 0.5);
    }
    @media (max-width: 40rem) {
      .sheet {
        width: 100vw;
        border-inline-start: 0;
      }
    }
    .sheet__header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 1rem 1rem 0.75rem;
      border-bottom: 1px solid var(--color-border);
    }
    .sheet__title {
      margin: 0;
      font-family: var(--font-display);
      font-size: 1.125rem;
      font-weight: 500;
      line-height: 1.5rem;
      color: var(--color-text-heading);
    }
    .sheet__sub {
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .sheet__body {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 1.25rem;
      min-height: 0;
      padding: 1rem;
      overflow-y: auto;
    }
    .sheet__footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface);
    }
    .sheet__footer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .field__label {
      display: block;
      margin: 0 0 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .current {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-height: 3rem;
    }
    .current__icon {
      display: grid;
      flex: 0 0 auto;
      place-items: center;
      width: 3rem;
      height: 3rem;
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .current__icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .current__name,
    .current__meta {
      display: block;
    }
    .current__name {
      font-size: 0.9375rem;
      font-weight: 500;
      line-height: 1.25rem;
      overflow-wrap: anywhere;
    }
    .current__meta {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .current__note {
      margin: 0;
      font-size: 0.875rem;
      color: var(--color-text-secondary);
    }
    .results {
      max-height: 15rem;
      margin: 0.5rem 0 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    @media (max-width: 40rem) {
      .results {
        max-height: 40dvh;
      }
    }
    .result {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      min-height: 2.75rem;
      padding: 0.25rem 0.625rem;
      cursor: pointer;
    }
    .result + .result {
      border-top: 1px solid var(--color-border);
    }
    .result:hover,
    .result--active {
      background: var(--color-surface-hover);
    }
    .result--active {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .result[aria-selected='true'] {
      background: var(--color-primary-subtle);
      font-weight: 600;
    }
    .result__icon {
      flex: 0 0 auto;
      width: 2rem;
      height: 2rem;
      object-fit: contain;
    }
    .result__name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.875rem;
      overflow-wrap: anywhere;
    }
    .result__tier {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .result__check {
      flex: 0 0 auto;
      display: inline-flex;
      color: var(--color-text);
    }
    .results__note {
      margin: 0.375rem 0 0;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .abilities {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
  `,
  template: `
    <dialog
      #sheet
      class="sheet"
      [attr.aria-labelledby]="titleId"
      [attr.closedby]="'any'"
      (close)="closed.emit()"
      (click)="onBackdropClick($event)"
    >
      <header class="sheet__header">
        <div>
          <h2 class="sheet__title" [id]="titleId">{{ slotLabel() }}</h2>
          <p class="sheet__sub">{{ loadoutLabel() }}</p>
        </div>
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          [attr.aria-label]="t('common.close')"
          (click)="dismiss()"
        >
          <app-icon name="close" size="1.125rem" />
        </button>
      </header>

      <div class="sheet__body">
        <section class="current" [attr.aria-label]="t('loadoutEditor.inspector.current')">
          @if (item(); as current) {
            <span class="current__icon">
              @if (currentIcon() && currentIcon() !== failedIcon()) {
                <img
                  [src]="currentIcon()"
                  alt=""
                  width="48"
                  height="48"
                  (error)="failedIcon.set(currentIcon())"
                />
              } @else {
                <span aria-hidden="true">{{ current.openalbion_item_name.charAt(0) }}</span>
              }
            </span>
            <span>
              <span class="current__name">{{ current.openalbion_item_name }}</span>
              <span class="current__meta">{{ currentMeta() }}</span>
            </span>
          } @else if (mainItem(); as main) {
            <p class="current__note">
              {{ t('loadoutEditor.swap.sameAsMainWith', { item: main.openalbion_item_name }) }}
            </p>
          } @else {
            <p class="current__note">{{ t('loadoutEditor.inspector.noItem') }}</p>
          }
        </section>

        <div>
          <span class="field__label" [id]="tierLabelId">{{ t('equipment.tier') }}</span>
          <app-choice-group
            [options]="tierOptions()"
            [value]="searchTier()"
            [ariaLabel]="t('equipment.tier')"
            (valueChange)="tierChange.emit($event)"
          />
        </div>

        <div>
          <label class="field__label" [for]="searchId">{{ t('equipment.searchLabel') }}</label>
          <input
            #search
            class="input"
            type="search"
            role="combobox"
            autocomplete="off"
            [id]="searchId"
            [attr.autofocus]="item() ? null : ''"
            [attr.aria-expanded]="results().length > 0"
            [attr.aria-controls]="listId"
            [attr.aria-activedescendant]="activeOptionId()"
            [placeholder]="t('equipment.searchPlaceholder')"
            [value]="query()"
            (input)="onQueryInput($event)"
            (keydown)="onSearchKeydown($event)"
          />
          @if (searching()) {
            <p class="results__note" role="status">{{ t('equipment.searching') }}</p>
          } @else if (searchFailed()) {
            <p class="results__note" role="alert">{{ t('loadoutEditor.inspector.searchFailed') }}</p>
          } @else if (results().length === 0) {
            <p class="results__note" role="status">{{ t('equipment.noItems') }}</p>
          } @else {
            <p class="results__note" role="status">
              {{
                results().length >= resultCap()
                  ? t('loadoutEditor.inspector.resultsCapped', { count: results().length })
                  : t('loadoutEditor.inspector.resultsCount', { count: results().length })
              }}
            </p>
          }
          <ul
            class="results"
            role="listbox"
            [id]="listId"
            [attr.aria-label]="t('equipment.availableItems')"
            [hidden]="results().length === 0"
          >
            @for (result of results(); track result.id; let index = $index) {
              <li
                class="result"
                role="option"
                [id]="optionId(index)"
                [class.result--active]="activeIndex() === index"
                [attr.aria-selected]="isSelected(result)"
                (click)="pick(result)"
              >
                @if (result.icon) {
                  <img class="result__icon" [src]="result.icon" alt="" width="32" height="32" loading="lazy" />
                }
                <span class="result__name">{{ result.name }}</span>
                <span class="result__tier">{{ resultTier(result) }}</span>
                @if (isSelected(result)) {
                  <span class="result__check">
                    <app-icon name="check" size="1rem" />
                    <span class="sr-only">{{ t('equipment.selected') }}</span>
                  </span>
                }
              </li>
            }
          </ul>
        </div>

        @if (item()) {
          @if (showEnchantment()) {
            <div>
              <span class="field__label">{{ t('equipment.enchantment') }}</span>
              <app-choice-group
                [options]="enchantmentOptions()"
                [value]="'' + enchantment()"
                [ariaLabel]="t('equipment.enchantment')"
                (valueChange)="enchantmentChange.emit(+$event)"
              />
            </div>
          }
          @if (showQuality()) {
            <div>
              <span class="field__label">{{ t('equipment.quality') }}</span>
              <app-choice-group
                [options]="qualityOptions()"
                [value]="'' + quality()"
                [ariaLabel]="t('equipment.quality')"
                (valueChange)="qualityChange.emit(+$event)"
              />
            </div>
          }
          @if (abilitySlots().length > 0) {
            <div class="abilities">
              <span class="field__label">{{ t('equipment.abilities') }}</span>
              <app-ability-bar
                [slots]="abilitySlots()"
                [canManage]="true"
                [emptyLabel]="t('comps.noAbility')"
                (choiceChange)="abilityChange.emit($event)"
              />
            </div>
          }
        }
      </div>

      <footer class="sheet__footer">
        <div class="sheet__footer-actions">
          @if (item()) {
            <button type="button" class="btn btn--outline btn--sm" (click)="clear.emit()">
              {{ loadout() === 'swap' ? t('loadoutEditor.swap.sameAsMain') : t('loadoutEditor.inspector.clear') }}
            </button>
          } @else if (loadout() === 'swap' && mainItem()) {
            <button type="button" class="btn btn--outline btn--sm" (click)="copyFromMain.emit()">
              {{ t('loadoutEditor.swap.startFromMain') }}
            </button>
          }
        </div>
        <button type="button" class="btn btn--primary btn--sm" (click)="dismiss()">
          {{ t('loadoutEditor.inspector.done') }}
        </button>
      </footer>
    </dialog>
  `,
})
export class SlotInspector {
  private readonly translate = inject(TranslateService);
  private readonly sheet = viewChild.required<ElementRef<HTMLDialogElement>>('sheet');

  /** The slot being edited. */
  readonly slot = input.required<BuildSlot>();
  /** Which loadout the slot belongs to; the swap loadout offers "same as main". */
  readonly loadout = input<BuildLoadout>('main');
  /** The slot's current draft item, or `null` when it is empty (or inherits main, in the swap). */
  readonly item = input<BuildItemSlot | null>(null);
  /** The main loadout's item for this slot, shown and copyable while editing the swap. */
  readonly mainItem = input<BuildItemSlot | null>(null);
  /** Tiers offered by the tier control. Include the current item's tier. */
  readonly tiers = input.required<readonly string[]>();
  /** The tier the item search is filtered to; follows the chosen item. */
  readonly searchTier = input.required<string>();
  /** The search box value. Empty when the sheet opens. */
  readonly query = input('');
  /** Items matching the search, in display order. */
  readonly results = input<readonly OpenAlbionItem[]>([]);
  /** Largest result list the search returns, so "showing the first N" can be said honestly. */
  readonly resultCap = input(100);
  /** The search is running. */
  readonly searching = input(false);
  /** The item catalog could not be loaded. */
  readonly searchFailed = input(false);
  /** Ability slots the current item offers, resolved against the draft's choices. */
  readonly abilitySlots = input<readonly AbilitySlotView[]>([]);

  /** The search box changed. */
  readonly queryChange = output<string>();
  /** The tier control changed. */
  readonly tierChange = output<string>();
  /** A search result was chosen. */
  readonly itemPick = output<OpenAlbionItem>();
  /** The enchantment control changed (0 to 4). */
  readonly enchantmentChange = output<number>();
  /** The quality control changed (1 to 5). */
  readonly qualityChange = output<number>();
  /** An ability chip was chosen. */
  readonly abilityChange = output<AbilityChoiceChange>();
  /** "Clear slot" (main) or "Same as main" (swap). */
  readonly clear = output<void>();
  /** "Start from main item" (swap, empty slot). */
  readonly copyFromMain = output<void>();
  /** The sheet was dismissed (Done, close button, Escape or a backdrop click). */
  readonly closed = output<void>();

  private readonly uid = ++nextInspectorId;
  protected readonly titleId = `slot-inspector-title-${this.uid}`;
  protected readonly tierLabelId = `slot-inspector-tier-${this.uid}`;
  protected readonly searchId = `slot-inspector-search-${this.uid}`;
  protected readonly listId = `slot-inspector-list-${this.uid}`;

  protected readonly activeIndex = signal(-1);
  /** URL of the current item's icon when it failed to load, so the first letter shows instead. */
  protected readonly failedIcon = signal('');

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly slotLabel = computed(() => this.t(SLOT_LABEL_KEYS[this.slot()]));
  protected readonly loadoutLabel = computed(() =>
    this.t(this.loadout() === 'swap' ? 'loadout.swap' : 'loadout.main'),
  );

  protected readonly currentIcon = computed(() => {
    const current = this.item();
    return current ? albionIconUrlWithQuality(current.openalbion_item_icon, this.quality()) : '';
  });

  protected readonly currentMeta = computed(() => {
    const current = this.item();
    if (!current) {
      return '';
    }
    const tier = albionTierLabel(current.openalbion_item_tier, current.openalbion_item_enchantment);
    return this.showQuality()
      ? `${tier} · ${this.t(`loadout.quality.${this.quality()}` as TranslationKey)}`
      : tier;
  });

  protected readonly enchantment = computed(() => this.item()?.openalbion_item_enchantment ?? 0);
  protected readonly quality = computed(() =>
    normalizeAlbionItemQuality(this.item()?.openalbion_item_quality),
  );

  private readonly identifier = computed(
    () => this.item()?.openalbion_item_icon?.match(/\/item\/([^.?]+)/)?.[1] ?? null,
  );

  protected readonly showEnchantment = computed(
    () => slotSupportsEnchantment(this.slot()) && albionItemSupportsEnchantment(this.identifier()),
  );
  protected readonly showQuality = computed(
    () => slotSupportsQuality(this.slot()) && albionItemSupportsQuality(this.identifier()),
  );

  protected readonly tierOptions = computed<ChoiceOption[]>(() =>
    this.tiers().map((tier) => ({ id: tier, label: tier })),
  );

  protected readonly enchantmentOptions = computed<ChoiceOption[]>(() =>
    ALBION_ITEM_ENCHANTMENTS.map((level) => ({
      id: String(level),
      label: level === 0 ? this.t('equipment.plain') : `.${level}`,
      ariaLabel:
        level === 0 ? this.t('equipment.plain') : `${this.t('equipment.enchantment')} ${level}`,
    })),
  );

  protected readonly qualityOptions = computed<ChoiceOption[]>(() =>
    ALBION_ITEM_QUALITIES.map((grade) => ({
      id: String(grade.id),
      label: this.t(`loadout.quality.${grade.id}` as TranslationKey),
    })),
  );

  protected readonly activeOptionId = computed(() =>
    this.activeIndex() >= 0 ? this.optionId(this.activeIndex()) : null,
  );

  constructor() {
    afterNextRender(() => {
      const dialog = this.sheet().nativeElement;
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    });
  }

  protected optionId(index: number): string {
    return `${this.listId}-opt-${index}`;
  }

  protected isSelected(result: OpenAlbionItem): boolean {
    return result.id === this.item()?.openalbion_item_id;
  }

  protected resultTier(result: OpenAlbionItem): string {
    return albionTierLabel(result.tier, 0);
  }

  protected dismiss(): void {
    const dialog = this.sheet().nativeElement;
    if (typeof dialog.close === 'function') {
      dialog.close();
    } else {
      this.closed.emit();
    }
  }

  /** Safari and older engines do not light-dismiss; a click on the backdrop lands on the dialog. */
  protected onBackdropClick(event: MouseEvent): void {
    if ('closedBy' in HTMLDialogElement.prototype) {
      return;
    }
    const dialog = this.sheet().nativeElement;
    if (event.target !== dialog) {
      return;
    }
    const rect = dialog.getBoundingClientRect();
    const inside =
      rect.top <= event.clientY &&
      event.clientY <= rect.bottom &&
      rect.left <= event.clientX &&
      event.clientX <= rect.right;
    if (!inside) {
      this.dismiss();
    }
  }

  protected onQueryInput(event: Event): void {
    this.activeIndex.set(-1);
    this.queryChange.emit((event.target as HTMLInputElement).value);
  }

  protected pick(result: OpenAlbionItem): void {
    this.itemPick.emit(result);
  }

  /** Arrow keys move through the results while focus stays in the search field; Enter chooses. */
  protected onSearchKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    if (count === 0) {
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveActive(Math.min(this.activeIndex() + 1, count - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveActive(Math.max(this.activeIndex() - 1, 0));
        break;
      case 'Enter': {
        const active = this.results()[this.activeIndex()];
        if (active) {
          event.preventDefault();
          this.pick(active);
        }
        break;
      }
    }
  }

  private moveActive(index: number): void {
    this.activeIndex.set(index);
    queueMicrotask(() =>
      (this.sheet().nativeElement.querySelector(`#${this.optionId(index)}`) as HTMLElement | null)
        ?.scrollIntoView?.({ block: 'nearest' }),
    );
  }
}
