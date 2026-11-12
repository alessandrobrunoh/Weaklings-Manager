import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';

import { Icon, type IconName } from '../icon/icon';

/** One entry of the overflow menu. */
export interface EntityMenuItem {
  /** Stable id, emitted by `menuSelect` when the entry is chosen. */
  readonly id: string;
  /** Already translated, visible label. */
  readonly label: string;
  readonly icon?: IconName;
  /** Destructive actions (archive, delete) read in the error colour and the label stays the cue. */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Draws a divider above this entry, to separate the destructive group. */
  readonly separatorBefore?: boolean;
}

let nextEntityHeaderId = 0;

/**
 * Header of a detail page (a composition, a build): title, a meta line, ONE primary action and an
 * overflow menu for everything secondary.
 *
 * Content projection slots (all optional):
 * - `[entityBadges]` - small status chips right after the title (Archived, Shared...).
 * - `[entityMeta]` - the meta line: version switcher, category, author, date. Project one wrapper
 *   element that holds the facts and lays them out as a wrapping row.
 * - `[entityPrimary]` - the single primary action, usually `<button class="btn btn--primary">`.
 * - `[entitySummary]` - a band of key numbers under the title, separated by a hairline.
 *
 * The overflow menu is a real menu button: `aria-haspopup="menu"` and `aria-expanded` on the
 * trigger, `role="menu"` / `menuitem` entries, ArrowUp/ArrowDown/Home/End to move, Escape to close
 * and return focus to the trigger, Tab or an outside click to close. It is hidden when
 * `menuItems` is empty.
 *
 * @example
 * ```html
 * <app-entity-header
 *   [title]="comp.name"
 *   [menuItems]="menu()"
 *   [menuLabel]="t('entityHeader.moreActions')"
 *   (menuSelect)="onMenu($event)"
 * >
 *   <span entityBadges class="chip chip--neutral">Archived</span>
 *   <div entityMeta><span>ZvZ</span><span>by Kris</span></div>
 *   <button entityPrimary type="button" class="btn btn--primary">Edit</button>
 * </app-entity-header>
 * ```
 */
@Component({
  selector: 'app-entity-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    '(document:click)': 'onDocumentClick($event)',
  },
  styles: `
    :host {
      display: block;
      margin-block-end: 1rem;
    }
    .eh__top {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
    }
    .eh__identity {
      display: flex;
      flex: 1 1 16rem;
      flex-direction: column;
      gap: 0.375rem;
      min-width: 0;
    }
    .eh__title-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.625rem;
    }
    .eh__title {
      margin: 0;
      min-width: 0;
      color: var(--color-text-heading);
      font-family: var(--font-display);
      font-size: 1.375rem;
      font-weight: 500;
      letter-spacing: -0.02em;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
    @media (min-width: 40rem) {
      .eh__title {
        font-size: 1.625rem;
      }
    }
    .eh__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 1rem;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .eh__meta:empty {
      display: none;
    }
    .eh__description {
      margin: 0.125rem 0 0;
      max-width: 60ch;
      font-size: 0.875rem;
      line-height: 1.375rem;
      color: var(--color-text-secondary);
      white-space: pre-line;
    }
    .eh__actions {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 0.5rem;
    }
    .eh__summary {
      margin-block-start: 1rem;
      padding-block-start: 0.875rem;
      border-top: 1px solid var(--color-border);
    }
    .eh__summary:empty {
      display: none;
    }
    .eh-menu {
      position: relative;
    }
    .eh-menu__panel {
      position: absolute;
      inset-block-start: calc(100% + 0.25rem);
      inset-inline-end: 0;
      z-index: 30;
      display: flex;
      flex-direction: column;
      min-width: 13rem;
      max-width: min(20rem, calc(100vw - 2rem));
      padding: 0.25rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-surface-1);
      box-shadow: var(--shadow-3);
    }
    .eh-menu__item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      width: 100%;
      min-height: 2.25rem;
      padding: 0.375rem 0.625rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text);
      font: inherit;
      font-size: 0.875rem;
      text-align: start;
      cursor: pointer;
    }
    .eh-menu__item:hover:not(:disabled),
    .eh-menu__item:focus-visible {
      background: var(--color-surface-hover);
    }
    .eh-menu__item:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .eh-menu__item:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .eh-menu__item--danger {
      color: var(--color-error);
    }
    .eh-menu__sep {
      height: 1px;
      margin: 0.25rem 0.125rem;
      background: var(--color-border);
    }
  `,
  template: `
    <header>
      <div class="eh__top">
        <div class="eh__identity">
          <div class="eh__title-row">
            <h1 class="eh__title">{{ title() }}</h1>
            <ng-content select="[entityBadges]" />
          </div>
          <div class="eh__meta"><ng-content select="[entityMeta]" /></div>
          @if (description(); as text) {
            <p class="eh__description">{{ text }}</p>
          }
        </div>

        <div class="eh__actions">
          <ng-content select="[entityPrimary]" />
          @if (menuItems().length > 0) {
            <div class="eh-menu" (focusout)="onFocusOut($event)">
              <button
                #trigger
                type="button"
                class="btn btn--outline btn--icon"
                aria-haspopup="menu"
                [attr.aria-expanded]="open()"
                [attr.aria-controls]="open() ? menuId : null"
                [attr.aria-label]="menuLabel()"
                (click)="toggle()"
                (keydown)="onTriggerKeydown($event)"
              >
                <app-icon name="more-vertical" size="1.125rem" />
              </button>
              @if (open()) {
                <div
                  class="eh-menu__panel"
                  role="menu"
                  [id]="menuId"
                  [attr.aria-label]="menuLabel()"
                  (keydown)="onMenuKeydown($event)"
                >
                  @for (item of menuItems(); track item.id) {
                    @if (item.separatorBefore) {
                      <div class="eh-menu__sep" role="separator"></div>
                    }
                    <button
                      #entry
                      type="button"
                      role="menuitem"
                      class="eh-menu__item"
                      [class.eh-menu__item--danger]="item.danger"
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
        </div>
      </div>
      <div class="eh__summary"><ng-content select="[entitySummary]" /></div>
    </header>
  `,
})
export class EntityHeader {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChildren<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entries = viewChildren<ElementRef<HTMLButtonElement>>('entry');

  /** The page title, rendered as the page's `h1`. */
  readonly title = input.required<string>();
  /** Optional free-text description shown under the meta line. */
  readonly description = input<string | null | undefined>(undefined);
  /** Secondary actions for the overflow menu, already translated. */
  readonly menuItems = input<readonly EntityMenuItem[]>([]);
  /** Accessible name of the menu button and of the menu (e.g. "More actions"). */
  readonly menuLabel = input('More actions');

  /** Emits the `id` of the chosen menu entry. */
  readonly menuSelect = output<string>();

  protected readonly open = signal(false);
  protected readonly menuId = `entity-header-menu-${++nextEntityHeaderId}`;

  protected toggle(): void {
    if (this.open()) {
      this.close(false);
    } else {
      this.openMenu('first');
    }
  }

  protected choose(item: EntityMenuItem): void {
    if (item.disabled) {
      return;
    }
    this.close(true);
    this.menuSelect.emit(item.id);
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
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (!this.open()) {
      return;
    }
    const wrapper = this.host.nativeElement.querySelector('.eh-menu');
    if (wrapper && !wrapper.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  private enabledEntries(): HTMLButtonElement[] {
    return this.entries()
      .map((entry) => entry.nativeElement)
      .filter((element) => !element.disabled);
  }

  private openMenu(first: 'first' | 'last'): void {
    this.open.set(true);
    afterNextRender(
      () => {
        const enabled = this.enabledEntries();
        (first === 'first' ? enabled[0] : enabled[enabled.length - 1])?.focus();
      },
      { injector: this.injector },
    );
  }

  private close(returnFocus: boolean): void {
    this.open.set(false);
    if (returnFocus) {
      this.trigger()[0]?.nativeElement.focus();
    }
  }
}
