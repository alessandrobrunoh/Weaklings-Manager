import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  PLATFORM_ID,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../icon/icon';

export type DialogSize = 'sm' | 'md' | 'lg';

let nextDialogTitleId = 0;

/**
 * Shared modal shell built on the native `<dialog>` element.
 *
 * Open with `showModal()` so the browser owns focus trapping, Esc, and the
 * top layer. Light-dismiss uses `closedby="any"` where supported, with a
 * click-on-backdrop fallback for Safari.
 */
@Component({
  selector: 'app-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <dialog
      #panel
      class="app-dialog"
      [class.app-dialog--sm]="size() === 'sm'"
      [class.app-dialog--md]="size() === 'md'"
      [class.app-dialog--lg]="size() === 'lg'"
      [attr.closedby]="'any'"
      [attr.aria-labelledby]="titleId"
      (close)="onNativeClose()"
      (click)="onBackdropClick($event)"
    >
      <header class="app-dialog__header">
        <h2 [id]="titleId" class="app-dialog__title">{{ title() }}</h2>
        <button
          type="button"
          class="btn btn--ghost btn--icon"
          [attr.aria-label]="closeLabel"
          (click)="dismiss()"
        >
          <app-icon name="close" size="1.25rem" />
        </button>
      </header>
      <div class="app-dialog__body">
        <ng-content />
      </div>
      <footer class="app-dialog__footer">
        <ng-content select="[dialogFooter]" />
      </footer>
    </dialog>
  `,
})
export class Dialog {
  private readonly translate = inject(TranslateService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly panel = viewChild<ElementRef<HTMLDialogElement>>('panel');

  /** Whether the dialog should be shown. */
  readonly open = input(true);
  /** Accessible title shown in the header. */
  readonly title = input.required<string>();
  /** Width preset. */
  readonly size = input<DialogSize>('md');

  /** Emitted when the dialog is dismissed (Esc, backdrop, close button, or `open` going false). */
  readonly closed = output<void>();

  protected readonly titleId = `app-dialog-title-${++nextDialogTitleId}`;
  protected readonly closeLabel = this.translate.t('common.close' satisfies TranslationKey);

  constructor() {
    effect(() => {
      if (!this.isBrowser) {
        return;
      }
      const element = this.panel()?.nativeElement;
      const shouldOpen = this.open();
      if (!element) {
        return;
      }
      if (shouldOpen && !element.open) {
        element.showModal();
      } else if (!shouldOpen && element.open) {
        element.close();
      }
    });
  }

  /** Close via the header button. Native `close` then notifies the parent. */
  protected dismiss(): void {
    this.panel()?.nativeElement.close();
  }

  protected onNativeClose(): void {
    this.closed.emit();
  }

  /**
   * Safari (and other engines without `closedby`) does not light-dismiss.
   * A click whose target is the dialog element itself, and whose coordinates
   * fall outside the content box, is a backdrop click.
   */
  protected onBackdropClick(event: MouseEvent): void {
    if ('closedBy' in HTMLDialogElement.prototype) {
      return;
    }
    const dialog = this.panel()?.nativeElement;
    if (!dialog || event.target !== dialog) {
      return;
    }
    const rect = dialog.getBoundingClientRect();
    const inside =
      rect.top <= event.clientY &&
      event.clientY <= rect.bottom &&
      rect.left <= event.clientX &&
      event.clientX <= rect.right;
    if (!inside) {
      dialog.close();
    }
  }
}
