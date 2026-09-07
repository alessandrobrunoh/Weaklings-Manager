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
    /* Wrap-based rather than breakpoint-based: the header sits inside the
       content column, which is far narrower than the viewport whenever the
       sidebar and tenant rail are showing. A viewport media query stacks it at
       the wrong moment and lets the actions overflow the column in between. */
    .page-header__row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.75rem 1rem; }
    .page-header__identity { display: flex; flex: 1 1 16rem; flex-direction: column; min-inline-size: 0; }
    /* DESIGN.md's signature: display weight 800, all-caps, tight tracking —
       every page opens on the same stamped block. */
    .page-header__title {
      margin: 0;
      color: var(--color-text-heading);
      font-family: var(--font-display);
      font-size: 1.5rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: -0.01em;
      line-height: 1.1;
    }
    @media (min-width: 40rem) {
      .page-header__title { font-size: 1.875rem; }
    }
    .page-header__subtitle { min-inline-size: 0; margin: 0.5rem 0 0 0; color: var(--color-text-secondary); font-size: 0.875rem; line-height: 1.5; }
    .page-header__actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .page-header__tabs { margin-block-start: 1rem; }
    .page-header__tabs:empty { display: none; }
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

