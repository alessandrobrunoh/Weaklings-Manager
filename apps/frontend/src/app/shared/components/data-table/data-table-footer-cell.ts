import { Directive, inject, input, TemplateRef } from '@angular/core';

/**
 * Registers a cell of the totals row of `DataTable` for one column.
 *
 * When at least one footer cell is registered the table renders a `<tfoot>` row with a cell per
 * column; columns without a template stay empty, except the first one, which shows the
 * `footerLabel` (default "Total"). The row sums what the host passes: it totals the whole
 * dataset only if the host computes it that way, because the table itself only sees one page.
 *
 * @example
 * ```html
 * <app-data-table ...>
 *   <ng-template dataTableFooterCell="amount">{{ total() | number }}</ng-template>
 * </app-data-table>
 * ```
 */
@Directive({
  selector: '[dataTableFooterCell]',
})
export class DataTableFooterCell {
  /** Stable column key this footer template applies to. */
  readonly columnKey = input.required<string>({ alias: 'dataTableFooterCell' });

  readonly templateRef = inject(TemplateRef);
}
