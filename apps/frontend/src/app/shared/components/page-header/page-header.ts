import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Standard page header with title, optional badge, subtitle, action buttons, and tabs.
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; }
    .page-header { margin-block-end: 1rem; }
    .page-header__row { display: flex; min-block-size: 2.25rem; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .page-header__identity { display: flex; min-inline-size: 0; align-items: baseline; gap: 0.5rem; }
    .page-header__title { margin: 0; color: var(--color-text); font-family: var(--font-sans); font-size: 1rem; font-weight: 510; letter-spacing: -0.018em; line-height: 1.25; }
    .page-header__subtitle { min-inline-size: 0; margin: 0; overflow: hidden; color: var(--color-text-tertiary); font-size: 0.75rem; line-height: 1.25; text-overflow: ellipsis; white-space: nowrap; }
    .page-header__actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .page-header__tabs { margin-block-start: 0.625rem; }
    @media (max-width: 40rem) {
      .page-header__row { align-items: flex-start; flex-direction: column; }
      .page-header__actions { width: 100%; }
    }
  `,
  template: `
    <header class="page-header">
      <div class="page-header__row">
        <div class="page-header__identity">
          <h1 class="page-header__title">{{ title() }}</h1>
          @if (badge()) {
            <span class="chip chip--neutral">{{ badge() }}</span>
          }
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

