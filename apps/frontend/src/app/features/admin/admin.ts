import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { AdminMessage } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';

/**
 * Admin operations page (Officer/Admin/SuperAdmin only — enforced by the route guard).
 *
 * Today it exposes a single action: hot-reloading the in-memory permission cache
 * after changing rows in `role_permissions`, so role/permission edits apply
 * without a backend restart.
 */
@Component({
  selector: 'app-admin',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader],
  template: `
    <app-page-header
      [title]="t('admin.title')"
      [subtitle]="t('admin.subtitle')"
      [actions]="false"
    />

    <section class="card max-w-xl p-6">
      <h2 class="mb-2 text-base font-semibold" style="color: var(--color-text)">
        {{ t('admin.permissions.reload') }}
      </h2>
      <p class="mb-4 text-sm" style="color: var(--color-text-secondary)">
        {{ t('admin.subtitle') }}
      </p>
      <button type="button" class="btn btn--primary" [disabled]="reloading()" (click)="reload()">
        @if (reloading()) {
          {{ t('common.loading') }}
        } @else {
          {{ t('admin.permissions.reload') }}
        }
      </button>
    </section>
  `,
})
export class Admin {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly reloading = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected async reload(): Promise<void> {
    if (this.reloading()) {
      return;
    }
    this.reloading.set(true);
    try {
      await firstValueFrom(this.api.post<AdminMessage>('api/admin/permissions/reload', null));
      this.toasts.success(this.t('admin.permissions.reloaded'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.reloading.set(false);
    }
  }
}
