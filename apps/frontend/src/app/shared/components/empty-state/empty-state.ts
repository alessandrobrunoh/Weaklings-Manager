import { booleanAttribute, ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Icon, type IconName } from '../icon/icon';

/**
 * Empty-state placeholder shown when a list or section has no data.
 *
 * Say what is empty and, when there is a next step, offer it: put the one action in the default
 * slot (`<button class="btn btn--primary btn--sm">`). Use `compact` inside a card or a table,
 * where a full-page block would dwarf its container. A failed load is NOT empty: use
 * `app-error-state` for that.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="empty-state flex flex-col items-center justify-center text-center"
      [class.empty-state--compact]="compact()"
      role="status"
      aria-live="polite"
    >
      @if (icon()) {
        <div class="empty-state__icon flex items-center justify-center" aria-hidden="true">
          <app-icon [name]="icon()" [size]="compact() ? '1.125rem' : '1.375rem'" />
        </div>
      }
      <div class="empty-state__text">
        <p class="empty-state__message">{{ message() }}</p>
        @if (hint()) {
          <p class="empty-state__hint">{{ hint() }}</p>
        }
      </div>
      <ng-content />
    </div>
  `,
  styles: `
    .empty-state {
      gap: 0.75rem;
      padding: 2.5rem 1.5rem;
    }
    .empty-state--compact {
      gap: 0.5rem;
      padding: 1.25rem 1rem;
    }
    .empty-state__icon {
      width: 2.5rem;
      height: 2.5rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      color: var(--color-text-secondary);
    }
    .empty-state--compact .empty-state__icon {
      width: 2rem;
      height: 2rem;
    }
    .empty-state__text {
      max-width: 24rem;
    }
    .empty-state__message {
      margin: 0;
      color: var(--color-text-heading);
      font-size: var(--ui-text-md);
      font-weight: 600;
      line-height: 1.375rem;
    }
    .empty-state__hint {
      margin: 0.25rem 0 0;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-sm);
      line-height: 1.25rem;
    }
  `,
})
export class EmptyState {
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly icon = input<IconName>('sparkles');
  /** Tighter padding and a smaller icon, for use inside a card or table. */
  readonly compact = input(false, { transform: booleanAttribute });
}
