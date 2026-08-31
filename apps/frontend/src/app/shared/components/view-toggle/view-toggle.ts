import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChildren,
} from '@angular/core';

import { Icon, type IconName } from '../icon/icon';

/** One segment of the toggle. */
export interface ViewToggleOption {
  readonly id: string;
  readonly label: string;
  /** Optional leading icon, for toggles dense enough to need one (e.g. many segments). */
  readonly icon?: IconName;
}

/**
 * Segmented control for switching between views of the same data.
 *
 * Rendered as a tablist so keyboard and screen-reader users get the semantics
 * the visual grouping implies. Scrolls horizontally rather than wrapping, so a
 * long set of tabs cannot push the page into a horizontal scroll of its own.
 *
 * Follows the ARIA APG tabs pattern: only the active tab sits in the Tab
 * order (roving `tabindex`), and Left/Right/Home/End move focus *and*
 * activate — automatic activation, the standard behaviour for a lightweight
 * pill switcher like this one where selecting a tab has no separate cost.
 * Without this, a keyboard user had to Tab through every option one at a
 * time to reach the one they wanted, worst on the page with the most tabs.
 *
 * @example
 * <app-view-toggle [options]="tabs" [active]="tab()" (activeChange)="tab.set($event)" />
 */
@Component({
  selector: 'app-view-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div class="overflow-x-auto scrollbar-thin">
      <div
        class="inline-flex gap-0.5 rounded-md border p-0.5"
        style="background-color: var(--color-surface-2); border-color: var(--color-border)"
        role="tablist"
        (keydown)="onKeydown($event)"
      >
        @for (option of options(); track option.id; let i = $index) {
          <button
            #tab
            type="button"
            role="tab"
            class="inline-flex min-h-7 items-center gap-1.5 whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium"
            [attr.aria-selected]="option.id === active()"
            [attr.tabindex]="option.id === active() ? 0 : -1"
            [style.background-color]="option.id === active() ? 'var(--color-surface-3)' : 'transparent'"
            [style.color]="option.id === active() ? 'var(--color-text)' : 'var(--color-text-tertiary)'"
            (click)="select(i)"
          >
            @if (option.icon) {
              <app-icon [name]="option.icon" size="0.95rem" />
            }
            {{ option.label }}
          </button>
        }
      </div>
    </div>
  `,
})
export class ViewToggle {
  readonly options = input.required<readonly ViewToggleOption[]>();
  readonly active = input.required<string>();
  readonly activeChange = output<string>();

  private readonly tabs = viewChildren<ElementRef<HTMLButtonElement>>('tab');

  protected select(index: number): void {
    const option = this.options()[index];
    if (option) {
      this.activeChange.emit(option.id);
    }
  }

  /** Left/Right/Home/End roving focus, wrapping at the ends. */
  protected onKeydown(event: KeyboardEvent): void {
    const count = this.options().length;
    if (count === 0) {
      return;
    }
    const current = this.options().findIndex((option) => option.id === this.active());

    let next: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1 + count) % count;
        break;
      case 'ArrowLeft':
        next = (current - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    this.select(next);
    this.tabs()[next]?.nativeElement.focus();
  }
}
