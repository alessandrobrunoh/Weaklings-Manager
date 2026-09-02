import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Icon } from '../icon/icon';

/**
 * Recoverable-error placeholder, visually distinct from `EmptyState`.
 *
 * A failed fetch and a genuinely empty list are different situations: one is
 * "there is nothing here", the other is "we couldn't find out what's here,
 * try again". Rendering both the same way — which most pages used to do, by
 * just leaving a data list empty after a caught error — tells a member with
 * a flaky connection or a backend hiccup that a resource has zero rows when
 * it may not, and gives them no way to recover short of a full page reload.
 *
 * Use this whenever a load `catch` block would otherwise leave a list/table
 * empty; pair it with a `retry` handler that re-runs the same load.
 */
@Component({
  selector: 'app-error-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role="alert"
    >
      <div
        class="flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10 text-red-400 border border-red-500/20 shadow-sm"
        style="box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.05)"
        aria-hidden="true"
      >
        <app-icon name="alert" size="1.5rem" />
      </div>
      <div class="max-w-sm">
        <p class="text-sm font-semibold tracking-tight text-white">{{ message() }}</p>
        @if (hint()) {
          <p class="mt-1 text-xs text-[var(--color-text-secondary)] leading-relaxed">{{ hint() }}</p>
        }
      </div>
      <button
        type="button"
        class="btn btn--outline btn--sm mt-1 inline-flex items-center gap-1.5"
        (click)="retry.emit()"
      >
        <app-icon name="refresh" size="0.875rem" />
        {{ retryLabel() }}
      </button>
    </div>
  `,
})
export class ErrorState {
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly retryLabel = input.required<string>();
  readonly retry = output<void>();
}
