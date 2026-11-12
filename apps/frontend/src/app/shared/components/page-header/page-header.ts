import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { TranslateService } from '../../../core/services/translate.service';
import { Icon } from '../icon/icon';
import { Menu, type MenuItem } from '../menu/menu';

/** One crumb of the trail above the title. The last one is the current page and needs no link. */
export interface PageCrumb {
  /** Already translated label. */
  readonly label: string;
  /** Router commands; omit for the current page. */
  readonly link?: string | readonly unknown[];
}

/**
 * Standard header of a list, hub or form page: title, optional badge and subtitle, a back link or
 * breadcrumb trail, ONE primary action, an overflow menu for the rest, and an optional tab bar.
 * (Detail pages of a single record use `app-entity-header` instead.)
 *
 * Slots (all optional):
 * - actions: any `button`, `a`, `[pageActions]` or `[headerActions]` child. Project the primary
 *   action only (`btn btn--primary`) plus at most one secondary (`btn btn--outline`); everything
 *   else goes in `menuItems`.
 * - tabs: `app-tabs` or any `[pageTabs]` element, placed under the title.
 *
 * @example
 * ```html
 * <app-page-header
 *   [title]="t('splits.title')"
 *   [subtitle]="t('splits.subtitle')"
 *   [menuItems]="menu()"
 *   (menuSelect)="onMenu($event)"
 * >
 *   <button type="button" class="btn btn--primary">New split</button>
 *   <app-tabs pageTabs [options]="tabs()" [active]="tab()" (activeChange)="tab.set($event)" />
 * </app-page-header>
 * ```
 */
@Component({
  selector: 'app-page-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Menu, RouterLink],
  styles: `
    :host { display: block; }
    .page-header { margin-block-end: 1rem; }
    .page-header__nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.5rem;
      margin: 0 0 0.5rem;
      padding: 0;
      list-style: none;
      font-size: var(--ui-text-sm);
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .page-header__nav a {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      min-height: 1.5rem;
      border-radius: var(--radius-sm);
      color: var(--color-text-secondary);
      text-decoration: none;
    }
    .page-header__nav a:hover { color: var(--color-text); text-decoration: underline; }
    .page-header__nav a:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-ring-offset); }
    .page-header__sep { color: var(--color-text-disabled); }
    /* Wrap-based rather than breakpoint-based: the header sits inside the
       content column, which is far narrower than the viewport whenever the
       sidebar and tenant rail are showing. A viewport media query stacks it at
       the wrong moment and lets the actions overflow the column in between. */
    .page-header__row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 0.75rem 1rem; }
    .page-header__identity { display: flex; flex: 1 1 16rem; flex-direction: column; min-inline-size: 0; }
    .page-header__subtitle { min-inline-size: 0; margin: 0.25rem 0 0 0; color: var(--color-text-secondary); font-size: var(--ui-text-sm); line-height: 1.4; }
    .page-header__actions { display: flex; flex: 0 1 auto; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .page-header__tabs { margin-block-start: 0.75rem; }
    .page-header__tabs:empty { display: none; }
  `,
  template: `
    <header class="page-header">
      @if (breadcrumbs().length > 0) {
        <nav [attr.aria-label]="t('ui.breadcrumb.label')">
          <ol class="page-header__nav">
            @for (crumb of breadcrumbs(); track $index; let last = $last) {
              <li>
                @if (crumb.link !== undefined && !last) {
                  <a [routerLink]="crumb.link">{{ crumb.label }}</a>
                } @else {
                  <span [attr.aria-current]="last ? 'page' : null">{{ crumb.label }}</span>
                }
              </li>
              @if (!last) {
                <li class="page-header__sep" aria-hidden="true">/</li>
              }
            }
          </ol>
        </nav>
      } @else if (backLink() !== null && backLink() !== undefined) {
        <p class="page-header__nav">
          <a [routerLink]="backLink()">
            <app-icon name="chevron-left" size="0.875rem" />
            {{ backLabel() || t('ui.pageHeader.back') }}
          </a>
        </p>
      }
      <div class="page-header__row">
        <div class="page-header__identity">
          <div class="flex items-center gap-2 flex-wrap">
            <h1 class="page-title">{{ title() }}</h1>
            @if (badge()) {
              <span class="chip chip--neutral font-mono">{{ badge() }}</span>
            }
          </div>
          @if (subtitle()) {
            <p class="page-header__subtitle">{{ subtitle() }}</p>
          }
        </div>
        @if (actions() || menuItems().length > 0) {
          <div class="page-header__actions">
            @if (actions()) {
              <ng-content select="button, a, [pageActions], [headerActions]" />
            }
            <app-menu
              appearance="outline"
              [items]="menuItems()"
              [label]="menuLabel() || t('ui.menu.moreActions')"
              (itemSelect)="menuSelect.emit($event)"
            />
          </div>
        }
      </div>
      <div class="page-header__tabs">
        <ng-content select="[pageTabs], app-tabs" />
      </div>
    </header>
  `,
})
export class PageHeader {
  private readonly translate = inject(TranslateService);

  readonly title = input.required<string>();
  readonly subtitle = input<string>();
  readonly badge = input<string>();
  /** Pass any truthy value to render the actions slot (right-aligned). */
  readonly actions = input<boolean>(true);

  /** A single "back to the parent list" link above the title. Ignored when `breadcrumbs` is set. */
  readonly backLink = input<string | readonly unknown[] | null | undefined>(undefined);
  /** Visible text of the back link, already translated ("Back to splits"). Defaults to "Back". */
  readonly backLabel = input('');
  /** Breadcrumb trail above the title; the last crumb is the current page. Prefer a back link for one level. */
  readonly breadcrumbs = input<readonly PageCrumb[]>([]);

  /** Secondary actions for the overflow menu, already translated. Hidden when empty. */
  readonly menuItems = input<readonly MenuItem[]>([]);
  /** Accessible name of the menu button; defaults to "More actions". */
  readonly menuLabel = input('');
  /** Emits the `id` of the chosen menu entry. */
  readonly menuSelect = output<string>();


  protected readonly t = (key: 'ui.breadcrumb.label' | 'ui.pageHeader.back' | 'ui.menu.moreActions') =>
    this.translate.t(key);
}
