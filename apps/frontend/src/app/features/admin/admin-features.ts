import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Tenant SuperAdmin toggles modules allowed by the assigned Rank.
 */
@Component({
  selector: 'app-admin-features',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [Checkbox, PageHeader, PageStack],
  template: `
    <app-page-header
      [title]="t('admin.features.title')"
      [subtitle]="t('admin.features.subtitle')"
      [badge]="view()?.rank_name ?? t('platform.tenants.none')"
    />

    <app-page-stack>
      @if (loading()) {
        <p class="text-sm" role="status">{{ t('common.loading') }}</p>
      } @else if (loadFailed()) {
        <p class="text-sm" style="color: var(--color-danger)">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else if (rows().length === 0) {
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('admin.features.empty') }}
        </p>
      } @else {
        <form class="card p-4 grid gap-3" (submit)="onSave($event)">
          <fieldset class="grid gap-3" [disabled]="saving()">
            <legend class="text-base font-bold">{{ t('admin.features.title') }}</legend>
            @for (item of rows(); track item.key) {
              <app-checkbox
                [inputId]="'tenant-flag-' + item.key"
                [name]="item.key"
                [label]="item.display_name"
                [hint]="item.description ? item.key + ' · ' + item.description : item.key"
                [checked]="item.enabled"
                [disabled]="saving()"
                (checkedChange)="onToggle(item.key, $event)"
              />
            }
          </fieldset>
          <div>
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving() || loading()">
              {{ saving() ? t('common.loading') : t('common.save') }}
            </button>
          </div>
        </form>
      }
    </app-page-stack>
  `,
})
export class AdminFeatures {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly view = signal<TenantFeaturesView | null>(null);
  protected readonly overrides = signal<Record<string, boolean>>({});
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);

  protected readonly rows = computed(() => {
    const data = this.view();
    if (!data) {
      return [];
    }
    const allowed = new Set(data.allowed_keys ?? []);
    const flags = new Map(data.flags.map((flag) => [flag.key, flag.enabled]));
    const local = this.overrides();
    return data.catalog
      .filter((item) => allowed.has(item.key))
      .map((item) => ({
        ...item,
        enabled: local[item.key] ?? flags.get(item.key) ?? false,
      }));
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected onToggle(key: string, enabled: boolean): void {
    this.overrides.update((current) => ({ ...current, [key]: enabled }));
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(this.api.get<TenantFeaturesView>('api/admin/features'));
      this.view.set(data);
      this.overrides.set({});
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async onSave(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    this.saving.set(true);
    try {
      const data = await firstValueFrom(
        this.api.put<TenantFeaturesView>('api/admin/features', {
          flags: this.rows().map((row) => ({ key: row.key, enabled: row.enabled })),
        }),
      );
      this.view.set(data);
      this.overrides.set({});
      this.toasts.success(this.t('admin.features.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
