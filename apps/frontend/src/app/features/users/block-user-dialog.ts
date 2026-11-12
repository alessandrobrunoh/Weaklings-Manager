import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { UserProfile } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';

/** Longest block reason the backend accepts. */
export const BLOCK_REASON_MAX = 500;

/**
 * Confirm dialog for blocking or unblocking a member.
 *
 * Blocking explains what happens (the member loses the manager on the web and through the bot,
 * nothing changes on Discord) and takes an optional reason that only role managers can read.
 * The dialog does the API call itself and hands the updated profile back through `updated`, so
 * the members list and the member page share one implementation.
 *
 * @example
 * <app-block-user-dialog [member]="row" mode="block" (updated)="onUpdated($event)" (closed)="close()" />
 */
@Component({
  selector: 'app-block-user-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog],
  template: `
    <app-dialog
      [title]="
        mode() === 'block'
          ? t('users.block.title', { name: member().username })
          : t('users.unblock.title', { name: member().username })
      "
      icon="user-x"
      size="sm"
      (closed)="closed.emit()"
    >
      <form id="block-user-form" class="grid gap-3" (submit)="confirm($event)">
        @if (mode() === 'block') {
          <p class="text-sm" style="color: var(--color-text-secondary)">
            {{ t('users.block.consequence', { name: member().username }) }}
          </p>
          <label>
            <span class="label">{{ t('users.block.reason') }}</span>
            <textarea
              id="block-user-reason"
              name="block-user-reason"
              class="input min-h-24"
              [attr.maxlength]="reasonMax"
              aria-describedby="block-user-reason-hint"
              [value]="reason()"
              (input)="onReason($event)"
            ></textarea>
            <span
              id="block-user-reason-hint"
              class="mt-1 block text-xs"
              style="color: var(--color-text-secondary)"
            >
              {{ t('users.block.reasonHint') }}
            </span>
          </label>
        } @else {
          <p class="text-sm" style="color: var(--color-text-secondary)">
            {{ t('users.unblock.consequence', { name: member().username }) }}
          </p>
        }
      </form>
      <div dialogFooter class="flex justify-end gap-2">
        <button type="button" class="btn btn--ghost btn--sm" (click)="closed.emit()">
          {{ t('common.cancel') }}
        </button>
        <button
          type="submit"
          form="block-user-form"
          class="btn btn--sm"
          [class.btn--danger]="mode() === 'block'"
          [class.btn--primary]="mode() === 'unblock'"
          [disabled]="saving()"
        >
          {{ mode() === 'block' ? t('users.block.confirm') : t('users.unblock.confirm') }}
        </button>
      </div>
    </app-dialog>
  `,
})
export class BlockUserDialog {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** The member being blocked or unblocked. */
  readonly member = input.required<UserProfile>();
  /** Which action the dialog confirms. */
  readonly mode = input.required<'block' | 'unblock'>();

  /** Emitted with the member's fresh profile after the backend accepted the change. */
  readonly updated = output<UserProfile>();
  /** Emitted when the dialog is dismissed, after a success or a cancel. */
  readonly closed = output<void>();

  protected readonly reasonMax = BLOCK_REASON_MAX;
  protected readonly reason = signal('');
  protected readonly saving = signal(false);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirm(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) {
      return;
    }
    const member = this.member();
    this.saving.set(true);
    try {
      const updated =
        this.mode() === 'block'
          ? await firstValueFrom(
              this.api.post<UserProfile>(`api/users/${member.id}/block`, {
                reason: this.reason().trim() || null,
              }),
            )
          : ((await firstValueFrom(
              this.api.delete<UserProfile>(`api/users/${member.id}/block`),
            )) as UserProfile);
      this.toasts.success(
        this.t(this.mode() === 'block' ? 'users.block.success' : 'users.unblock.success', {
          name: member.username,
        }),
      );
      this.updated.emit(updated);
      this.closed.emit();
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
