import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';

/**
 * Confirmation before a composition or a build is archived from a list.
 *
 * Archiving never fails on references (the row only leaves the pickers), so the dialog has no
 * blocking-reference branch; it names what is about to be archived and says it can be undone.
 */
@Component({
  selector: 'app-list-archive-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog],
  template: `
    <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closed.emit()">
      <p class="text-sm">{{ t('comps.archiveConfirm') }}</p>
      <p class="mt-2 text-sm font-medium">{{ name() }}</p>
      <div dialogFooter>
        <button type="button" class="btn btn--ghost" (click)="closed.emit()">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="btn btn--tonal" [disabled]="saving()" (click)="confirm.emit()">
          {{ t('comps.archive') }}
        </button>
      </div>
    </app-dialog>
  `,
})
export class ListArchiveDialog {
  private readonly translate = inject(TranslateService);

  /** Name of the row being archived. */
  readonly name = input.required<string>();
  readonly saving = input(false);
  readonly confirm = output<void>();
  readonly closed = output<void>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
