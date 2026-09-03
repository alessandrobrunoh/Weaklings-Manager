import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Icon, type IconName } from '../icon/icon';

/**
 * Empty-state placeholder shown when a list or section has no data.
 * Encourages a consistent "friendly nudge" rather than a bare blank panel.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <div
      class="empty-state flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role="status"
      aria-live="polite"
    >
      @if (icon()) {
        <div
          class="empty-state__icon flex h-12 w-12 items-center justify-center border shadow-sm"
          aria-hidden="true"
        >
          <app-icon [name]="icon()" size="1.5rem" />
        </div>
      }
      <div class="max-w-sm">
        <p class="text-sm font-medium tracking-tight text-[var(--color-text-heading)]">{{ message() }}</p>
        @if (hint()) {
          <p class="mt-1 text-xs text-[var(--color-text-secondary)] leading-relaxed">{{ hint() }}</p>
        }
      </div>
      <ng-content />
    </div>
  `,
  styles: `
    .empty-state__icon {
      border-radius: var(--radius-xl, 12px);
      border-color: var(--color-border);
      background: var(--color-surface-2);
      color: var(--color-info);
      box-shadow: var(--shadow-subtle);
    }
  `,
})
export class EmptyState {
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly icon = input<IconName>('sparkles');
}
