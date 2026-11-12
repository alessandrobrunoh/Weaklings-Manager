import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';

import { Icon, type IconName } from '../icon/icon';

/** One entry of an {@link Menu}. */
export interface MenuItem {
  /** Stable id, emitted by `itemSelect` when the entry is chosen. */
  readonly id: string;
  /** Already translated, visible label. */
  readonly label: string;
  readonly icon?: IconName;
  /** Destructive actions (archive, delete) read in the error colour; the label stays the cue. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Draws a divider above this entry, to separate the destructive group. */
  readonly separatorBefore?: boolean;
}

let nextMenuId = 0;

/** Approximate height of one entry plus padding, used only to decide whether to open upwards. */
const ROW_PX = 38;

/**
 * Overflow menu: the "more actions" button of a page header, a list row or a card.
 *
 * A real menu button (WAI-ARIA menu button pattern): `aria-haspopup="menu"` and `aria-expanded`
 * on the trigger, `role="menu"` with `menuitem` buttons that are not in the Tab order,
 * ArrowUp/ArrowDown/Home/End to move (wrapping, skipping disabled entries), ArrowDown/ArrowUp on
 * the trigger to open on the first/last entry, Escape to close and return focus to the trigger,
 * Tab or an outside click to close. Choosing an entry closes the menu and returns focus.
 *
 * The panel is `position: fixed`, placed from the trigger's rectangle, so it is never clipped by a
 * scrolling table wrapper or a card; it flips upwards near the bottom of the viewport and closes
 * when anything scrolls or the window resizes. It renders nothing when `items` is empty, so a row
 * the caller may not change shows no empty button.
 *
 * Use it for SECONDARY actions only; the one primary action stays a visible button.
 *
 * @example
 * ```html
 * <app-menu [items]="menu(row)" [label]="t('x.rowActions', { name })" (itemSelect)="run($event, row)" />
 * <app-menu appearance="outline" [triggerLabel]="t('common.export')" [items]="exports" [label]="t('common.export')" />
 * ```
 */
@Component({
  selector: 'app-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(window:resize)': 'onViewportChange()',
    '[class.menu--open]': 'open()',
  },
  styles: `
    :host {
      position: relative;
      z-index: 1;
      display: inline-block;
    }
    :host(.menu--open) {
      z-index: 20;
    }
    .menu__trigger--ghost {
      display: inline-grid;
      place-items: center;
      width: var(--control-h);
      height: var(--control-h);
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .menu__trigger--ghost:hover,
    .menu__trigger--ghost[aria-expanded='true'] {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .menu__trigger--ghost:focus-visible {
      outline: var(--focus-ring);
      outline-offset: -2px;
    }
    .menu__panel {
      position: fixed;
      z-index: 60;
      display: flex;
      flex-direction: column;
      min-width: 11rem;
      max-width: min(20rem, calc(100vw - 2rem));
      padding: 0.25rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-surface-1);
      box-shadow: var(--shadow-3);
    }
    .menu__item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      width: 100%;
      min-height: var(--control-h);
      padding: 0.375rem 0.625rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      font-size: var(--ui-text-md);
      text-align: start;
      cursor: pointer;
    }
    .menu__item:hover:not(:disabled),
    .menu__item:focus-visible {
      background: var(--color-surface-hover);
    }
    .menu__item:focus-visible {
      outline: var(--focus-ring);
      outline-offset: -2px;
    }
    .menu__item:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .menu__item--danger {
      color: var(--color-error);
    }
    .menu__sep {
      height: 1px;
      margin: 0.25rem 0.125rem;
      background: var(--color-border);
    }
  `,
  template: `
    @if (items().length > 0) {
      <div (focusout)="onFocusOut($event)">
        <button
          #trigger
          type="button"
          [class]="triggerClass()"
          aria-haspopup="menu"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="open() ? menuId : null"
          [attr.aria-label]="triggerLabel() ? null : label()"
          (click)="toggle()"
          (keydown)="onTriggerKeydown($event)"
        >
          @if (triggerLabel(); as text) {
            <span>{{ text }}</span>
            <app-icon name="chevron-down" size="0.875rem" />
          } @else {
            <app-icon name="more-vertical" size="1.125rem" />
          }
        </button>
        @if (open()) {
          <div
            class="menu__panel"
            role="menu"
            [id]="menuId"
            [attr.aria-label]="label()"
            [style.top.px]="position().top"
            [style.bottom.px]="position().bottom"
            [style.left.px]="position().left"
            [style.right.px]="position().right"
            (keydown)="onMenuKeydown($event)"
          >
            @for (item of items(); track item.id) {
              @if (item.separatorBefore) {
                <div class="menu__sep" role="separator"></div>
              }
              <button
                #entry
                type="button"
                role="menuitem"
                class="menu__item"
                [class.menu__item--danger]="item.danger"
                [disabled]="item.disabled"
                tabindex="-1"
                (click)="choose(item)"
              >
                @if (item.icon) {
                  <app-icon [name]="item.icon" size="1rem" />
                }
                <span>{{ item.label }}</span>
              </button>
            }
          </div>
        }
      </div>
    }
  `,
})
export class Menu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly trigger = viewChildren<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entries = viewChildren<ElementRef<HTMLButtonElement>>('entry');

  /** Entries, already translated. The component renders nothing when this is empty. */
  readonly items = input<readonly MenuItem[]>([]);
  /** Accessible name of the menu (and of the trigger when it has no visible text). Say what it belongs to. */
  readonly label = input.required<string>();
  /** Visible text for a labelled trigger ("Export"); omit for the icon-only "more" button. */
  readonly triggerLabel = input('');
  /** `ghost` for rows and cards, `outline` next to a primary button in a header. */
  readonly appearance = input<'ghost' | 'outline'>('ghost');
  /** Which edge of the trigger the panel lines up with. */
  readonly align = input<'end' | 'start'>('end');

  /** Emits the `id` of the chosen entry. */
  readonly itemSelect = output<string>();

  protected readonly open = signal(false);
  protected readonly position = signal<{
    top: number | null;
    bottom: number | null;
    left: number | null;
    right: number | null;
  }>({ top: null, bottom: null, left: null, right: null });
  protected readonly menuId = `app-menu-${++nextMenuId}`;

  private readonly onAnyScroll = (): void => {
    if (this.open()) {
      this.open.set(false);
    }
  };

  constructor() {
    this.destroyRef.onDestroy(() => this.unwatchScroll());
  }

  protected triggerClass(): string {
    if (this.triggerLabel()) {
      return `btn btn--sm ${this.appearance() === 'outline' ? 'btn--outline' : 'btn--ghost'}`;
    }
    return this.appearance() === 'outline'
      ? 'btn btn--outline btn--icon'
      : 'menu__trigger--ghost';
  }

  protected toggle(): void {
    if (this.open()) {
      this.close(false);
    } else {
      this.openMenu('first');
    }
  }

  protected choose(item: MenuItem): void {
    if (item.disabled) {
      return;
    }
    this.close(true);
    this.itemSelect.emit(item.id);
  }

  protected onTriggerKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.openMenu('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.openMenu('last');
    }
  }

  protected onMenuKeydown(event: KeyboardEvent): void {
    const enabled = this.enabledEntries();
    if (enabled.length === 0) {
      return;
    }
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        enabled[(current + 1) % enabled.length].focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        enabled[(current - 1 + enabled.length) % enabled.length].focus();
        break;
      case 'Home':
        event.preventDefault();
        enabled[0].focus();
        break;
      case 'End':
        event.preventDefault();
        enabled[enabled.length - 1].focus();
        break;
      case 'Escape':
        // The page may sit inside a dialog or have its own Escape handling; this one is ours.
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
        break;
    }
  }

  /** Tab (or any other focus move) out of the menu closes it, like a native menu. */
  protected onFocusOut(event: FocusEvent): void {
    if (!this.open()) {
      return;
    }
    const next = event.relatedTarget as Node | null;
    const wrapper = event.currentTarget as HTMLElement;
    if (next && !wrapper.contains(next)) {
      this.open.set(false);
      this.unwatchScroll();
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
      this.unwatchScroll();
    }
  }

  protected onViewportChange(): void {
    if (this.open()) {
      this.open.set(false);
      this.unwatchScroll();
    }
  }

  private enabledEntries(): HTMLButtonElement[] {
    return this.entries()
      .map((entry) => entry.nativeElement)
      .filter((element) => !element.disabled);
  }

  private openMenu(first: 'first' | 'last'): void {
    this.place();
    this.open.set(true);
    this.watchScroll();
    afterNextRender(
      () => {
        const enabled = this.enabledEntries();
        (first === 'first' ? enabled[0] : enabled[enabled.length - 1])?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  /** Positions the fixed panel from the trigger rectangle; flips upwards when it would overflow. */
  private place(): void {
    const trigger = this.trigger()[0]?.nativeElement;
    if (!trigger || typeof window === 'undefined') {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const estimated = this.items().length * ROW_PX + 12;
    const up = rect.bottom + estimated + 8 > window.innerHeight && rect.top > estimated;
    const end = this.align() === 'end';
    this.position.set({
      top: up ? null : rect.bottom + 4,
      bottom: up ? window.innerHeight - rect.top + 4 : null,
      left: end ? null : Math.max(8, rect.left),
      right: end ? Math.max(8, window.innerWidth - rect.right) : null,
    });
  }

  private watchScroll(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('scroll', this.onAnyScroll, true);
    }
  }

  private unwatchScroll(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('scroll', this.onAnyScroll, true);
    }
  }

  private close(returnFocus: boolean): void {
    this.open.set(false);
    this.unwatchScroll();
    if (returnFocus) {
      this.trigger()[0]?.nativeElement.focus();
    }
  }
}
