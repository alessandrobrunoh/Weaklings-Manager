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

import { Icon } from '../../shared/components/icon/icon';
import type { EntityMenuItem } from '../../shared/components/entity-header/entity-header';

let nextRowMenuId = 0;

/**
 * Overflow menu of one list row (Clone, New variant, Archive).
 *
 * A real menu button, like the one in `app-entity-header`: `aria-haspopup`/`aria-expanded` on the
 * trigger, `role="menu"` with `menuitem` buttons, ArrowUp/ArrowDown/Home/End to move, Escape to close
 * and return focus to the trigger, Tab or an outside click to close. It renders nothing when there
 * are no items, so a row the caller may not change shows no empty button.
 *
 * @example
 * ```html
 * <app-row-menu [items]="menu(row)" [label]="t('compsList.menu.label', { name })" (select)="run($event, row)" />
 * ```
 */
@Component({
  selector: 'app-row-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '[class.rm--open]': 'open()',
  },
  styles: `
    :host {
      position: relative;
      z-index: 1;
      display: inline-block;
    }
    :host(.rm--open) {
      z-index: 20;
    }
    .rm__trigger {
      display: inline-grid;
      place-items: center;
      width: 2.25rem;
      height: 2.25rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .rm__trigger:hover,
    .rm__trigger[aria-expanded='true'] {
      background: var(--color-surface-hover);
      color: var(--color-text);
    }
    .rm__trigger:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .rm__panel {
      position: absolute;
      inset-block-start: calc(100% + 0.125rem);
      inset-inline-end: 0;
      z-index: 30;
      display: flex;
      flex-direction: column;
      min-width: 11rem;
      max-width: min(18rem, calc(100vw - 2rem));
      padding: 0.25rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-surface-1);
      box-shadow: var(--shadow-3);
    }
    .rm__item {
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
    .rm__item:hover:not(:disabled),
    .rm__item:focus-visible {
      background: var(--color-surface-hover);
    }
    .rm__item:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .rm__item:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .rm__item--danger {
      color: var(--color-error);
    }
    .rm__sep {
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
          class="rm__trigger"
          aria-haspopup="menu"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="open() ? menuId : null"
          [attr.aria-label]="label()"
          (click)="toggle()"
          (keydown)="onTriggerKeydown($event)"
        >
          <app-icon name="more-vertical" size="1.125rem" />
        </button>
        @if (open()) {
          <div
            class="rm__panel"
            role="menu"
            [id]="menuId"
            [attr.aria-label]="label()"
            (keydown)="onMenuKeydown($event)"
          >
            @for (item of items(); track item.id) {
              @if (item.separatorBefore) {
                <div class="rm__sep" role="separator"></div>
              }
              <button
                #entry
                type="button"
                role="menuitem"
                class="rm__item"
                [class.rm__item--danger]="item.danger"
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
export class RowMenu {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly trigger = viewChildren<ElementRef<HTMLButtonElement>>('trigger');
  private readonly entries = viewChildren<ElementRef<HTMLButtonElement>>('entry');

  /** Entries of the menu, already translated. */
  readonly items = input<readonly EntityMenuItem[]>([]);
  /** Accessible name of the button and the menu; say which row it belongs to. */
  readonly label = input.required<string>();
  /** Emits the `id` of the chosen entry. */
  readonly select = output<string>();

  protected readonly open = signal(false);
  protected readonly menuId = `row-menu-${++nextRowMenuId}`;

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
    this.select.emit(item.id);
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
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
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
