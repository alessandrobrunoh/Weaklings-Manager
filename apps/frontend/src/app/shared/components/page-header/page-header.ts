import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard page header with title, subtitle, and an optional actions slot.
 *
 * Every feature page renders `<app-page-header>` at the top so the visual
 * rhythm of titles is identical across modules.
 *
 * @example
 * <app-page-header [title]="'Bank'" [subtitle]="'Your ledger'">
 *   <button class="btn btn--primary">New</button>
 * </app-page-header>
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="display text-2xl" style="color: var(--color-text)">
          {{ title() }}
        </h1>
        @if (subtitle()) {
          <p class="mt-1 text-sm" style="color: var(--color-text-secondary)">
            {{ subtitle() }}
          </p>
        }
      </div>
      @if (actions()) {
        <div class="flex flex-wrap items-center gap-2">
          <ng-content />
        </div>
      }
    </header>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
  /** Pass any truthy value to render the actions slot (right-aligned). */
  readonly actions = input<boolean>(true);
}
