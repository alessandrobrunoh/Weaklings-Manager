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
          class="flex h-12 w-12 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-sky-400 shadow-sm"
          style="box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.02)"
          aria-hidden="true"
        >
          <app-icon [name]="icon()" size="1.5rem" />
        </div>
      }
      <div class="max-w-sm">
        <p class="text-sm font-semibold tracking-tight text-white">{{ message() }}</p>
        @if (hint()) {
          <p class="mt-1 text-xs text-[var(--color-text-secondary)] leading-relaxed">{{ hint() }}</p>
        }
      </div>
      <ng-content />
    </div>
  `,
})
export class EmptyState {
  readonly message = input.required<string>();
  readonly hint = input<string>();
  readonly icon = input<IconName>('sparkles');
}
