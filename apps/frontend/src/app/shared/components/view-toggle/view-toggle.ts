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
  styles: `
    .toggle-scroll {
      max-width: 100%;
      overscroll-behavior-x: contain;
    }
    .toggle-container {
      display: flex;
      width: max-content;
      min-width: 100%;
      gap: 0.125rem;
      border-bottom: 1px solid var(--color-border);
    }
    .toggle-btn {
      display: inline-flex;
      min-height: 2rem;
      align-items: center;
      gap: 0.375rem;
      white-space: nowrap;
      border: 0;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      margin-bottom: -1px;
      padding: 0.375rem 0.625rem 0.4375rem;
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: color var(--motion-fast), border-color var(--motion-fast), background-color var(--motion-fast);
      color: var(--color-text-secondary);
      background: transparent;
    }
    .toggle-btn:hover:not([aria-selected="true"]) {
      color: var(--color-text);
      background: color-mix(in srgb, var(--color-surface-hover) 55%, transparent);
    }
    .toggle-btn[aria-selected="true"] {
      color: var(--color-text-heading);
      font-weight: 600;
      border-bottom-color: var(--color-primary);
    }
    .toggle-btn:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
      z-index: 1;
    }
    @media (prefers-reduced-motion: reduce) {
      .toggle-btn {
        transition: none;
      }
    }
  `,
  template: `
    <div class="toggle-scroll overflow-x-auto scrollbar-thin">
      <div
        class="toggle-container"
        role="tablist"
        (keydown)="onKeydown($event)"
      >
        @for (option of options(); track option.id; let i = $index) {
          <button
            #tab
            type="button"
            role="tab"
            class="toggle-btn"
            [attr.aria-selected]="option.id === active()"
            [attr.tabindex]="option.id === active() ? 0 : -1"
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
