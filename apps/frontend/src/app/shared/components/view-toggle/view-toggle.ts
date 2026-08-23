import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** One segment of the toggle. */
export interface ViewToggleOption {
  readonly id: string;
  readonly label: string;
}

/**
 * Segmented control for switching between views of the same data.
 *
 * Rendered as a tablist so keyboard and screen-reader users get the semantics
 * the visual grouping implies. Scrolls horizontally rather than wrapping, so a
 * long set of tabs cannot push the page into a horizontal scroll of its own.
 *
 * @example
 * <app-view-toggle [options]="tabs" [active]="tab()" (activeChange)="tab.set($event)" />
 */
@Component({
  selector: 'app-view-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overflow-x-auto scrollbar-thin">
      <div
        class="inline-flex gap-0.5 rounded-full border p-1"
        style="background-color: var(--color-surface-2); border-color: var(--color-border)"
        role="tablist"
      >
        @for (option of options(); track option.id) {
          <button
            type="button"
            role="tab"
            class="whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium"
            [attr.aria-selected]="option.id === active()"
            [style.background-color]="option.id === active() ? 'var(--color-surface)' : 'transparent'"
            [style.color]="
              option.id === active() ? 'var(--color-text)' : 'var(--color-text-secondary)'
            "
            (click)="activeChange.emit(option.id)"
          >
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
}
