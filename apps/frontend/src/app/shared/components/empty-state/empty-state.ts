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
      class="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      role="status"
      aria-live="polite"
    >
      @if (icon()) {
        <div
          class="flex h-12 w-12 items-center justify-center rounded-full"
          style="background-color: var(--color-primary-container); color: var(--color-primary)"
          aria-hidden="true"
        >
          <app-icon [name]="icon()" size="1.5rem" />
        </div>
      }
      <p class="text-sm font-medium" style="color: var(--color-text)">{{ message() }}</p>
      @if (hint()) {
        <p class="text-xs" style="color: var(--color-text-secondary)">{{ hint() }}</p>
      }
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly icon = input<IconName>('sparkles');
}
