import { Directive, inject, input, TemplateRef } from '@angular/core';

/**
 * Structural directive that registers a per-column cell template inside
 * `DataTable`.
 *
 * Used together with content projection so each host component can render
 * arbitrary Angular markup (chips, images, action buttons) for a specific
 * column without leaking presentation concerns into the generic table.
 *
 * @example
 * ```html
 * <app-data-table [columns]="columns" [rows]="users" [trackBy]="trackBy">
 *   <ng-template dataTableCell="role" let-row>
 *     <span class="chip">{{ row.role }}</span>
 *   </ng-template>
 * </app-data-table>
 * ```
 */
@Directive({
  selector: '[dataTableCell]',
})
export class DataTableCell {
  /** Stable column key this template applies to. */
  readonly columnKey = input.required<string>({ alias: 'dataTableCell' });

  /** Template reference injected by Angular; context exposes the current `row`. */
  readonly templateRef = inject(TemplateRef);
}
