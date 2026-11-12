import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Menu, type MenuItem } from '../menu/menu';

/** One entry of the overflow menu (kept as an alias of the shared {@link MenuItem}). */
export type EntityMenuItem = MenuItem;

/**
 * Header of a detail page (a composition, a build): title, a meta line, ONE primary action and an
 * overflow menu for everything secondary.
 *
 * Content projection slots (all optional):
 * - `[entityBadges]` - small status chips right after the title (Archived, Shared...).
 * - `[entityMeta]` - the meta line: version switcher, category, author, date. Project one wrapper
 *   element that holds the facts and lays them out as a wrapping row.
 * - `[entityPrimary]` - the single primary action, usually `<button class="btn btn--primary">`.
 * - `[entitySummary]` - a band of key numbers under the title, separated by a hairline.
 *
 * The overflow menu is the shared `app-menu` (a real menu button: arrow keys, Escape, focus
 * return). It is hidden when `menuItems` is empty.
 *
 * @example
 * ```html
 * <app-entity-header
 *   [title]="comp.name"
 *   [menuItems]="menu()"
 *   [menuLabel]="t('entityHeader.moreActions')"
 *   (menuSelect)="onMenu($event)"
 * >
 *   <span entityBadges class="chip chip--neutral">Archived</span>
 *   <div entityMeta><span>ZvZ</span><span>by Kris</span></div>
 *   <button entityPrimary type="button" class="btn btn--primary">Edit</button>
 * </app-entity-header>
 * ```
 */
@Component({
  selector: 'app-entity-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Menu],
  styles: `
    :host {
      display: block;
      margin-block-end: 1rem;
    }
    .eh__top {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
    }
    .eh__identity {
      display: flex;
      flex: 1 1 16rem;
      flex-direction: column;
      gap: 0.375rem;
      min-width: 0;
    }
    .eh__title-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.625rem;
    }
    .eh__title {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .eh__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 1rem;
      font-size: var(--ui-text-sm);
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .eh__meta:empty {
      display: none;
    }
    .eh__description {
      margin: 0.125rem 0 0;
      max-width: 60ch;
      font-size: 0.875rem;
      line-height: 1.375rem;
      color: var(--color-text-secondary);
      white-space: pre-line;
    }
    .eh__actions {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 0.5rem;
    }
    .eh__summary {
      margin-block-start: 1rem;
      padding-block-start: 0.875rem;
      border-top: 1px solid var(--color-border);
    }
    .eh__summary:empty {
      display: none;
    }
  `,
  template: `
    <header>
      <div class="eh__top">
        <div class="eh__identity">
          <div class="eh__title-row">
            <h1 class="page-title eh__title">{{ title() }}</h1>
            <ng-content select="[entityBadges]" />
          </div>
          <div class="eh__meta"><ng-content select="[entityMeta]" /></div>
          @if (description(); as text) {
            <p class="eh__description">{{ text }}</p>
          }
        </div>

        <div class="eh__actions">
          <ng-content select="[entityPrimary]" />
          <app-menu
            appearance="outline"
            [items]="menuItems()"
            [label]="menuLabel()"
            (itemSelect)="menuSelect.emit($event)"
          />
        </div>
      </div>
      <div class="eh__summary"><ng-content select="[entitySummary]" /></div>
    </header>
  `,
})
export class EntityHeader {
  /** The page title, rendered as the page's `h1`. */
  readonly title = input.required<string>();
  /** Optional free-text description shown under the meta line. */
  readonly description = input<string | null | undefined>(undefined);
  /** Secondary actions for the overflow menu, already translated. */
  readonly menuItems = input<readonly EntityMenuItem[]>([]);
  /** Accessible name of the menu button and of the menu (e.g. "More actions"). */
  readonly menuLabel = input('More actions');

  /** Emits the `id` of the chosen menu entry. */
  readonly menuSelect = output<string>();
}
