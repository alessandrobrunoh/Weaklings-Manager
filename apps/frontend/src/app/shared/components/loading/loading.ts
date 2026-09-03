import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Inline loading spinner. Material-style: a small CSS ring plus a label.
 * Sized by the `size` input in pixels.
 */
@Component({
  selector: 'app-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex items-center justify-center gap-3"
      [attr.aria-label]="label()"
      role="status"
    >
      <span
        class="spinner"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.borderWidth.px]="Math.max(2, Math.round(size() / 8))"
        aria-hidden="true"
      ></span>
      @if (label()) {
        <span class="text-xs font-medium tracking-wide text-[var(--color-text-secondary)]">{{ label() }}</span>
      }
    </div>
  `,
  styles: [
    `
      .spinner {
        display: inline-block;
        border-style: solid;
        border-color: var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.75s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class Loading {
  protected readonly Math = Math;
  readonly size = input(20);
  readonly label = input<string>('');
}
