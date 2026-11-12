import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../icon/icon';

let nextFilterBarId = 0;

/**
 * THE filter bar of the product: a labelled search box, an always-visible primary slot, and a
 * panel of facets that is inline on a wide screen and sits behind a "Filters (n)" button on a
 * phone, so the first result is not pushed below the fold.
 *
 * The bar holds no filter state. The page owns it and the bar reports changes: `queryChange` for
 * the search text, `clear` when the officer asks to drop every filter.
 *
 * Slots:
 * - `[filterPrimary]` - always visible, next to the search box: the Mine/Everyone switch, a status
 *   segmented control. Keep to one or two things.
 * - default content - the facets (selects, checkboxes). Wrap each select in
 *   `<label class="filter-field"><span class="filter-field__label">Role</span><select class="select select--sm">...`
 *   and a checkbox in `<label class="filter-check">`. They are laid out as a wrapping row and sit
 *   inside the collapsible panel on a phone.
 *
 * @example
 * ```html
 * <app-filter-bar
 *   [searchLabel]="t('members.search')"
 *   [query]="query()"
 *   [activeCount]="activeFacets()"
 *   (queryChange)="query.set($event)"
 *   (clear)="reset()"
 * >
 *   <app-tabs filterPrimary variant="segmented" ... />
 *   <label class="filter-field"><span class="filter-field__label">Role</span> <select class="select select--sm">...</select></label>
 * </app-filter-bar>
 * ```
 */
@Component({
  selector: 'app-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styles: `
    :host {
      display: block;
    }
    .fb {
      display: grid;
      gap: 0.625rem;
    }
    .fb__top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .fb__search {
      position: relative;
      flex: 1 1 14rem;
      max-width: 26rem;
      min-width: 0;
    }
    .fb__search-icon {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0.625rem;
      display: flex;
      align-items: center;
      color: var(--color-text-secondary);
      pointer-events: none;
    }
    .fb__input {
      width: 100%;
      padding-inline: 2rem;
    }
    .fb__clear {
      position: absolute;
      inset-block: 0;
      inset-inline-end: 0;
      display: grid;
      place-items: center;
      width: var(--control-h);
      border: 0;
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .fb__clear:hover {
      color: var(--color-text);
    }
    .fb__clear:focus-visible {
      outline: var(--focus-ring);
      outline-offset: -2px;
      border-radius: var(--radius-sm);
    }
    .fb__toggle {
      display: none;
    }
    .fb__panel {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.625rem 1rem;
    }
    @media (min-width: 40.0625rem) {
      .fb {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 0.625rem 1rem;
      }
      .fb__top,
      .fb__panel {
        display: contents;
      }
      .fb__search {
        flex: 1 1 16rem;
        max-width: 22rem;
      }
    }
    @media (max-width: 40rem) {
      .fb__toggle {
        display: inline-flex;
      }
      .fb__panel {
        display: none;
        padding: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .fb__panel--open {
        display: grid;
        grid-template-columns: 1fr;
      }
      .fb__search {
        flex-basis: 100%;
        max-width: none;
      }
    }
  `,
  template: `
    <div class="fb" role="search" [attr.aria-label]="searchLabel()">
      <div class="fb__top">
        <label class="fb__search">
          <span class="sr-only">{{ searchLabel() }}</span>
          <span class="fb__search-icon"><app-icon name="search" size="0.875rem" /></span>
          <input
            type="text"
            inputmode="search"
            autocomplete="off"
            class="input fb__input"
            [placeholder]="searchPlaceholder()"
            [value]="query()"
            (input)="queryChange.emit($any($event.target).value)"
          />
          @if (query()) {
            <button
              type="button"
              class="fb__clear"
              [attr.aria-label]="t('ui.filters.clearSearch')"
              (click)="queryChange.emit('')"
            >
              <app-icon name="close" size="0.75rem" />
            </button>
          }
        </label>

        <ng-content select="[filterPrimary]" />

        <button
          type="button"
          class="btn btn--outline btn--sm fb__toggle"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="panelId"
          (click)="open.set(!open())"
        >
          <app-icon name="filter" size="0.875rem" />
          {{ toggleLabel() }}
        </button>
      </div>

      <div class="fb__panel" [class.fb__panel--open]="open()" [id]="panelId">
        <ng-content />

        @if (activeCount() > 0) {
          <button type="button" class="btn btn--ghost btn--sm" (click)="clear.emit()">
            {{ t('ui.filters.clear') }}
          </button>
        }
      </div>
    </div>
  `,
})
export class FilterBar {
  private readonly translate = inject(TranslateService);

  /** Accessible name of the search box (and of the whole search region). */
  readonly searchLabel = input.required<string>();
  readonly searchPlaceholder = input('');
  readonly query = input('');
  /** Facets in force inside the panel (including projected ones), for the phone badge and the clear button. */
  readonly activeCount = input(0);

  /** The search text changed (also emits `''` from the clear-search button). */
  readonly queryChange = output<string>();
  /** The officer asked to drop every filter. The page resets its own state. */
  readonly clear = output<void>();

  protected readonly open = signal(false);
  protected readonly panelId = `filter-bar-${++nextFilterBarId}`;
  protected readonly toggleLabel = computed(() =>
    this.activeCount() > 0
      ? this.t('ui.filters.buttonCount', { count: this.activeCount() })
      : this.t('ui.filters.button'),
  );

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
