import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';

import type { BuildRole } from '../../core/models/api.models';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import { BUILD_ROLES, roleLabelKey } from '../../shared/components/role-tag/role-tag';
import type { OwnershipScope } from '../../shared/data/ownership-scope';

let nextFilterBarId = 0;

/** A category the bar can filter by. */
export interface FilterCategory {
  readonly id: number;
  readonly name: string;
}

/**
 * The filter bar the compositions list and the builds list share.
 *
 * A labelled search box and the Mine / Everyone switch are always visible. Role, category, the
 * archived switch and anything the list projects (composition type, weapon family, grouping) live in
 * a panel: inline on a wide screen, behind a "Filters (n)" button on a phone, so the first result is
 * not pushed below the fold. The component holds no filter state; the list owns it and the bar
 * reports changes.
 *
 * @example
 * ```html
 * <app-list-filter-bar
 *   [searchLabel]="t('buildsList.searchLabel')"
 *   [query]="query()"
 *   [categories]="categories()"
 *   [showRole]="true"
 *   (queryChange)="query.set($event)"
 * >
 *   <label>...an extra facet...</label>
 * </app-list-filter-bar>
 * ```
 */
@Component({
  selector: 'app-list-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, OwnershipScopeToggle],
  styles: `
    :host {
      display: block;
    }
    .lf {
      display: grid;
      gap: 0.625rem;
    }
    .lf__top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .lf__search {
      position: relative;
      flex: 1 1 14rem;
      max-width: 26rem;
      min-width: 0;
    }
    .lf__search-icon {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0.625rem;
      display: flex;
      align-items: center;
      color: var(--color-text-secondary);
      pointer-events: none;
    }
    .lf__input {
      width: 100%;
      padding-inline: 2rem;
    }
    .lf__clear {
      position: absolute;
      inset-block: 0;
      inset-inline-end: 0;
      display: grid;
      place-items: center;
      width: 2rem;
      border: 0;
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .lf__clear:hover {
      color: var(--color-text);
    }
    .lf__clear:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
      border-radius: var(--radius-sm);
    }
    .lf__toggle {
      display: none;
    }
    .lf__panel {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.625rem 1rem;
    }
    .lf__field {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
    }
    .lf__label {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .lf__check {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      min-height: 2rem;
      font-size: 0.8125rem;
      cursor: pointer;
    }
    .lf__check input {
      accent-color: var(--color-primary);
    }
    @media (min-width: 40.0625rem) {
      .lf {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 0.625rem 1rem;
      }
      .lf__top,
      .lf__panel {
        display: contents;
      }
      .lf__search {
        flex: 1 1 16rem;
        max-width: 22rem;
      }
    }
    @media (max-width: 40rem) {
      .lf__toggle {
        display: inline-flex;
      }
      .lf__panel {
        display: none;
        padding: 0.75rem;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .lf__panel--open {
        display: grid;
        grid-template-columns: 1fr;
      }
      .lf__search {
        flex-basis: 100%;
        max-width: none;
      }
    }
  `,
  template: `
    <div class="lf" role="search" [attr.aria-label]="searchLabel()">
      <div class="lf__top">
        <label class="lf__search">
          <span class="sr-only">{{ searchLabel() }}</span>
          <span class="lf__search-icon"><app-icon name="search" size="0.875rem" /></span>
          <input
            type="text"
            inputmode="search"
            autocomplete="off"
            class="input lf__input"
            [placeholder]="searchPlaceholder()"
            [value]="query()"
            (input)="queryChange.emit($any($event.target).value)"
          />
          @if (query()) {
            <button
              type="button"
              class="lf__clear"
              [attr.aria-label]="t('compsList.filters.clearSearch')"
              (click)="queryChange.emit('')"
            >
              <app-icon name="close" size="0.75rem" />
            </button>
          }
        </label>

        <app-ownership-scope-toggle [scope]="scope()" (scopeChange)="scopeChange.emit($event)" />

        <button
          type="button"
          class="btn btn--outline btn--sm lf__toggle"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="panelId"
          (click)="open.set(!open())"
        >
          <app-icon name="filter" size="0.875rem" />
          {{ toggleLabel() }}
        </button>
      </div>

      <div class="lf__panel" [class.lf__panel--open]="open()" [id]="panelId">
        @if (showRole()) {
          <label class="lf__field">
            <span class="lf__label">{{ t('common.role') }}</span>
            <select class="select select--sm" [value]="role() ?? ''" (change)="onRole($event)">
              <option value="">{{ t('compsList.filters.allRoles') }}</option>
              @for (option of roles; track option) {
                <option [value]="option">{{ t(roleKey(option)) }}</option>
              }
            </select>
          </label>
        }
        <label class="lf__field">
          <span class="lf__label">{{ t('common.category') }}</span>
          <select class="select select--sm" [value]="categoryId() ?? ''" (change)="onCategory($event)">
            <option value="">{{ t('comps.allCategories') }}</option>
            @for (category of categories(); track category.id) {
              <option [value]="category.id">{{ category.name }}</option>
            }
          </select>
        </label>

        <ng-content />

        @if (canShowArchived()) {
          <label class="lf__check">
            <input
              type="checkbox"
              [checked]="showArchived()"
              (change)="showArchivedChange.emit($any($event.target).checked)"
            />
            {{ t('comps.showArchived') }}
          </label>
        }

        @if (activeCount() > 0) {
          <button type="button" class="btn btn--ghost btn--sm" (click)="clear.emit()">
            {{ t('compsList.filters.clear') }}
          </button>
        }
      </div>
    </div>
  `,
})
export class ListFilterBar {
  private readonly translate = inject(TranslateService);

  /** Accessible name of the search box (and of the whole search region). */
  readonly searchLabel = input.required<string>();
  readonly searchPlaceholder = input('');
  readonly query = input('');
  readonly scope = input<OwnershipScope>('mine');
  readonly categories = input<readonly FilterCategory[]>([]);
  readonly categoryId = input<number | null>(null);
  /** Whether the role facet is offered (builds yes, compositions no). */
  readonly showRole = input(false);
  readonly role = input<BuildRole | null>(null);
  /** Whether the caller may see the archive at all; hides the switch otherwise. */
  readonly canShowArchived = input(false);
  readonly showArchived = input(false);
  /** Filters in force inside the panel (including projected ones), for the badge and the clear button. */
  readonly activeCount = input(0);

  readonly queryChange = output<string>();
  readonly scopeChange = output<OwnershipScope>();
  readonly categoryIdChange = output<number | null>();
  readonly roleChange = output<BuildRole | null>();
  readonly showArchivedChange = output<boolean>();
  /** The officer asked to drop every filter. */
  readonly clear = output<void>();

  protected readonly roles = BUILD_ROLES;
  protected readonly roleKey = roleLabelKey;
  protected readonly open = signal(false);
  protected readonly panelId = `list-filters-${++nextFilterBarId}`;
  protected readonly toggleLabel = computed(() =>
    this.activeCount() > 0
      ? this.t('compsList.filters.buttonCount', { count: this.activeCount() })
      : this.t('compsList.filters.button'),
  );

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected onRole(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.roleChange.emit(value ? (value as BuildRole) : null);
  }

  protected onCategory(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.categoryIdChange.emit(value ? Number(value) : null);
  }
}
