import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import { Icon } from '../icon/icon';

/**
 * Recoverable-error placeholder, visually distinct from `EmptyState`.
 *
 * A failed fetch and a genuinely empty list are different situations: one is
 * "there is nothing here", the other is "we couldn't find out what's here,
 * try again". Rendering both the same way tells a member with a flaky
 * connection that a resource has zero rows when it may not, and gives them no
 * way to recover short of a full page reload.
 *
 * Use this whenever a load `catch` block would otherwise leave a list/table
 * empty; pair it with a `retry` handler that re-runs the same load.
 *
 * `variant="not-found"` is the 404 form: the record or page does not exist (or the link is
 * wrong), so there is nothing to retry. It uses calmer neutral colours, default copy from
 * `ui.errorState.*`, and takes its actions (a "Back to list" link) from the default slot instead
 * of a retry button.
 *
 * @example
 * <app-error-state [message]="t('x.loadFailed')" [retryLabel]="t('common.retry')" (retry)="reload()" />
 * <app-error-state variant="not-found"><a class="btn btn--outline btn--sm" routerLink="/splits">Back</a></app-error-state>
 */
@Component({
  selector: 'app-error-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="error-state flex flex-col items-center justify-center text-center"
      [class.error-state--not-found]="variant() === 'not-found'"
      [attr.role]="variant() === 'not-found' ? 'status' : 'alert'"
    >
      <div class="error-state__icon flex items-center justify-center" aria-hidden="true">
        <app-icon [name]="variant() === 'not-found' ? 'search' : 'alert'" size="1.375rem" />
      </div>
      <div class="error-state__text">
        <p class="error-state__message">{{ shownMessage() }}</p>
        @if (shownHint()) {
          <p class="error-state__hint">{{ shownHint() }}</p>
        }
      </div>
      @if (retryLabel() && variant() === 'error') {
        <button type="button" class="btn btn--outline btn--sm" (click)="retry.emit()">
          <app-icon name="refresh" size="0.875rem" />
          {{ retryLabel() }}
        </button>
      }
      <ng-content />
    </div>
  `,
  styles: `
    .error-state {
      gap: 0.75rem;
      padding: 2.5rem 1.5rem;
    }
    .error-state__icon {
      width: 2.5rem;
      height: 2.5rem;
      border: 1px solid color-mix(in oklab, var(--color-error) 24%, var(--color-border));
      border-radius: var(--radius-md);
      background: var(--color-error-container);
      color: var(--color-error);
    }
    .error-state--not-found .error-state__icon {
      border-color: var(--color-border);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .error-state__text {
      max-width: 24rem;
    }
    .error-state__message {
      margin: 0;
      color: var(--color-text-heading);
      font-size: var(--ui-text-md);
      font-weight: 600;
      line-height: 1.375rem;
    }
    .error-state__hint {
      margin: 0.25rem 0 0;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-sm);
      line-height: 1.25rem;
    }
  `,
})
export class ErrorState {
  private readonly translate = inject(TranslateService);

  /** Headline. Optional: defaults to the generic error or, for `not-found`, "Not found". */
  readonly message = input('');
  readonly hint = input<string>();
  /** Label of the retry button; without it (or for `not-found`) no retry button renders. */
  readonly retryLabel = input('');
  /** `error` (default): a failed load that can be retried. `not-found`: the 404 form. */
  readonly variant = input<'error' | 'not-found'>('error');
  readonly retry = output<void>();

  protected readonly shownMessage = computed(
    () =>
      this.message() ||
      this.translate.t(this.variant() === 'not-found' ? 'ui.errorState.notFound' : 'common.error'),
  );
  protected readonly shownHint = computed(
    () => this.hint() || (this.variant() === 'not-found' ? this.translate.t('ui.errorState.notFoundHint') : ''),
  );
}
