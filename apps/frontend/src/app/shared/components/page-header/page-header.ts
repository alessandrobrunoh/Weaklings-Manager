import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard page header with title, optional badge, subtitle, action buttons, and tabs.
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; }
    .page-header { margin-block-end: 1.5rem; }
    .page-header__row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    .page-header__identity { display: flex; flex-direction: column; min-inline-size: 0; }
    .page-header__title { margin: 0; color: var(--color-text); font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; line-height: 1.25; }
    @media (min-width: 40rem) {
      .page-header__title { font-size: 1.875rem; }
    }
    .page-header__subtitle { min-inline-size: 0; margin: 0.25rem 0 0 0; color: var(--color-text-tertiary); font-size: 0.875rem; line-height: 1.4; }
    .page-header__actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .page-header__tabs { margin-block-start: 1rem; }
    .page-header__tabs:empty { display: none; }
    @media (max-width: 40rem) {
      .page-header__row { align-items: flex-start; flex-direction: column; gap: 0.75rem; }
      .page-header__actions { width: 100%; justify-content: flex-start; }
    }
  `,
  template: `
    <header class="page-header">
      <div class="page-header__row">
        <div class="page-header__identity">
          <div class="flex items-center gap-2 flex-wrap">
            <h1 class="page-header__title">{{ title() }}</h1>
            @if (badge()) {
              <span class="chip chip--neutral font-mono text-[10px]">{{ badge() }}</span>
            }
          </div>
          @if (subtitle()) {
            <p class="page-header__subtitle">{{ subtitle() }}</p>
          }
        </div>
        @if (actions()) {
          <div class="page-header__actions">
            <ng-content select="button, a, [pageActions], [headerActions]" />
          </div>
        }
      </div>
      <div class="page-header__tabs">
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

