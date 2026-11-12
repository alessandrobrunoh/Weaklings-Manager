import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import type { BuildRole } from '../../core/models/api.models';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import { BUILD_ROLES, roleLabelKey } from '../../shared/components/role-tag/role-tag';
import type { OwnershipScope } from '../../shared/data/ownership-scope';

/** A category the bar can filter by. */
export interface FilterCategory {
  readonly id: number;
  readonly name: string;
}

/**
 * The comps / builds flavour of the shared {@link FilterBar}: the Mine / Everyone switch is the
 * primary slot; role, category, the archived switch and anything the list projects (composition
 * type, weapon family, grouping) are the facets. The component holds no filter state; the list
 * owns it and the bar reports changes.
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
 *   <label class="filter-field">...an extra facet...</label>
 * </app-list-filter-bar>
 * ```
 */
@Component({
  selector: 'app-list-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FilterBar, OwnershipScopeToggle],
  styles: `
    :host {
      display: block;
    }
  `,
  template: `
    <app-filter-bar
      [searchLabel]="searchLabel()"
      [searchPlaceholder]="searchPlaceholder()"
      [query]="query()"
      [activeCount]="activeCount()"
      (queryChange)="queryChange.emit($event)"
      (clear)="clear.emit()"
    >
      <app-ownership-scope-toggle filterPrimary [scope]="scope()" (scopeChange)="scopeChange.emit($event)" />

      @if (showRole()) {
        <label class="filter-field">
          <span class="filter-field__label">{{ t('common.role') }}</span>
          <select class="select select--sm" [value]="role() ?? ''" (change)="onRole($event)">
            <option value="">{{ t('compsList.filters.allRoles') }}</option>
            @for (option of roles; track option) {
              <option [value]="option">{{ t(roleKey(option)) }}</option>
            }
          </select>
        </label>
      }
      <label class="filter-field">
        <span class="filter-field__label">{{ t('common.category') }}</span>
        <select class="select select--sm" [value]="categoryId() ?? ''" (change)="onCategory($event)">
          <option value="">{{ t('comps.allCategories') }}</option>
          @for (category of categories(); track category.id) {
            <option [value]="category.id">{{ category.name }}</option>
          }
        </select>
      </label>

      <ng-content />

      @if (canShowArchived()) {
        <label class="filter-check">
          <input
            type="checkbox"
            [checked]="showArchived()"
            (change)="showArchivedChange.emit($any($event.target).checked)"
          />
          {{ t('comps.showArchived') }}
        </label>
      }
    </app-filter-bar>
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
