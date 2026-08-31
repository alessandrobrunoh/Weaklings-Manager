import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard page header with title, optional badge, subtitle, action buttons, and tabs.
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-header mb-6">
      <div class="flex flex-col gap-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-2.5 flex-wrap">
            <h1 class="text-xl sm:text-2xl font-bold tracking-tight" style="color: var(--color-text)">
              {{ title() }}
            </h1>
            @if (badge()) {
              <span class="chip chip--neutral text-[11px] font-medium">{{ badge() }}</span>
            }
          </div>
          @if (subtitle()) {
            <p class="mt-1 text-xs sm:text-sm" style="color: var(--color-text-secondary)">
              {{ subtitle() }}
            </p>
          }
        </div>
        @if (actions()) {
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <ng-content select="button, a, [pageActions], [headerActions]" />
          </div>
        }
      </div>
      <div class="page-header__tabs mt-4 empty:hidden">
        <ng-content select="[pageTabs], app-view-toggle" />
      </div>
    </header>
  `,
})
export class PageHeader {
  readonly title = input.required<string>();
  readonly subtitle = input<string>();
  readonly badge = input<string>();
  /** Pass any truthy value to render the actions slot (right-aligned). */
  readonly actions = input<boolean>(true);
}

