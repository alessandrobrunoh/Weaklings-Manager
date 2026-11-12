import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** What shape the loading placeholder takes. */
export type LoadingVariant = 'spinner' | 'table' | 'summary' | 'detail' | 'lines';

/**
 * Loading placeholder.
 *
 * - `spinner` (default): a small ring plus a label, for inline and button-sized waits.
 * - `table`, `summary`, `detail`, `lines`: skeletons that reserve the layout of what is coming
 *   (table rows, a summary band, a detail header + body, text lines), so the page does not jump
 *   when data lands. Prefer a skeleton over a spinner for any block that takes a region of the page.
 *
 * Every variant is a `role="status"` region named by `label` (pass the translated "Loading…"), and
 * the skeleton shapes are hidden from assistive technology. The shimmer stops under
 * `prefers-reduced-motion`.
 *
 * @example
 * <app-loading variant="table" [rows]="6" [label]="t('common.loading')" />
 */
@Component({
  selector: 'app-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (variant() === 'spinner') {
      <div class="flex items-center justify-center gap-3" [attr.aria-label]="label() || null" role="status">
        <span
          class="spinner"
          [style.width.px]="size()"
          [style.height.px]="size()"
          [style.borderWidth.px]="Math.max(2, Math.round(size() / 8))"
          aria-hidden="true"
        ></span>
        @if (label()) {
          <span class="text-xs font-medium text-[var(--color-text-secondary)]">{{ label() }}</span>
        }
      </div>
    } @else {
      <div class="skeleton" role="status" aria-busy="true" [attr.aria-label]="label() || null">
        @if (label()) {
          <span class="sr-only">{{ label() }}</span>
        }
        <div aria-hidden="true">
          @switch (variant()) {
            @case ('table') {
              <div class="sk-table">
                <span class="sk-bar sk-head"></span>
                @for (row of rowList(); track row) {
                  <span class="sk-bar sk-row" [style.width.%]="row % 3 === 0 ? 92 : 100"></span>
                }
              </div>
            }
            @case ('summary') {
              <div class="sk-summary">
                @for (cell of cellList(); track cell) {
                  <span class="sk-cell">
                    <span class="sk-bar sk-label"></span>
                    <span class="sk-bar sk-value"></span>
                  </span>
                }
              </div>
            }
            @case ('detail') {
              <div class="sk-detail">
                <span class="sk-bar sk-title"></span>
                <span class="sk-bar sk-meta"></span>
                <span class="sk-bar sk-block"></span>
              </div>
            }
            @default {
              <div class="sk-lines">
                @for (row of rowList(); track row) {
                  <span class="sk-bar sk-line" [style.width.%]="row === rowList().length ? 60 : 100"></span>
                }
              </div>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host { display: block; }
      .spinner {
        display: inline-block;
        border-style: solid;
        border-color: var(--color-border);
        border-top-color: var(--color-primary);
        border-radius: 50%;
        animation: spin 0.75s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .sk-bar {
        display: block;
        border-radius: var(--radius-sm);
        background: linear-gradient(
          90deg,
          var(--color-surface-2) 0%,
          var(--color-surface-3) 50%,
          var(--color-surface-2) 100%
        );
        background-size: 200% 100%;
        animation: shimmer 1.4s ease-in-out infinite;
      }
      @keyframes shimmer {
        from { background-position: 100% 0; }
        to { background-position: -100% 0; }
      }
      .sk-table { display: grid; gap: 0.5rem; }
      .sk-head { height: 1.75rem; }
      .sk-row { height: 1.5rem; }
      .sk-summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
        border: 1px solid var(--color-border);
        border-radius: var(--radius-smallcards);
        background: var(--color-surface);
      }
      .sk-cell { display: grid; gap: 0.5rem; padding: 0.75rem 0.875rem; }
      .sk-label { height: 0.75rem; width: 50%; }
      .sk-value { height: 1.25rem; width: 70%; }
      .sk-detail { display: grid; gap: 0.75rem; }
      .sk-title { height: 1.75rem; width: min(22rem, 70%); }
      .sk-meta { height: 1rem; width: min(14rem, 50%); }
      .sk-block { height: 10rem; }
      .sk-lines { display: grid; gap: 0.625rem; }
      .sk-line { height: 0.875rem; }
      @media (prefers-reduced-motion: reduce) {
        .sk-bar, .spinner { animation: none; }
      }
    `,
  ],
})
export class Loading {
  protected readonly Math = Math;
  /** Spinner diameter in pixels (spinner variant only). */
  readonly size = input(20);
  readonly label = input<string>('');
  readonly variant = input<LoadingVariant>('spinner');
  /** Rows of the `table` and `lines` skeletons. */
  readonly rows = input(5);
  /** Cells of the `summary` skeleton. */
  readonly cells = input(4);

  protected readonly rowList = computed(() => Array.from({ length: Math.max(1, this.rows()) }, (_, i) => i + 1));
  protected readonly cellList = computed(() => Array.from({ length: Math.max(1, this.cells()) }, (_, i) => i + 1));
}
