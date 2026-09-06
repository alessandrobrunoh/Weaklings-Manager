import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Per-tenant feature catalog toggles on the control plane.
 */
@Component({
  selector: 'app-platform-feature-flags',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header
      [title]="t('platform.features.title')"
      [subtitle]="t('platform.features.subtitle')"
      [badge]="tenantId"
    >
      <a
        class="btn btn--outline btn--sm no-underline"
        [routerLink]="['/platform/tenants', tenantId]"
      >
        {{ t('platform.tenants.title') }}
      </a>
    </app-page-header>

    <app-page-stack>
      @if (loadFailed()) {
        <p class="text-sm" style="color: var(--color-danger)">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else if (rows().length === 0 && !loading()) {
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('platform.features.empty') }}
        </p>
      } @else {
        <form class="card p-4 grid gap-3" (submit)="onSave($event)">
          <fieldset class="grid gap-3">
            <legend class="sr-only">{{ t('platform.features.title') }}</legend>
            @for (item of rows(); track item.key) {
              <label class="flex items-start gap-3" [attr.for]="'flag-' + item.key">
                <input
                  class="checkbox mt-1"
                  type="checkbox"
                  [id]="'flag-' + item.key"
                  [name]="item.key"
                  [checked]="item.enabled"
                  (change)="onToggle(item.key, $event)"
                />
                <span>
                  <span class="block font-medium text-sm">{{ item.display_name }}</span>
                  <span class="block font-mono text-xs text-[var(--color-text-tertiary)]">{{ item.key }}</span>
                  @if (item.description) {
                    <span class="block text-xs mt-0.5" style="color: var(--color-text-secondary)">
                      {{ item.description }}
                    </span>
                  }
                </span>
              </label>
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
export class PlatformFeatureFlags {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);

  protected readonly tenantId = this.route.snapshot.paramMap.get('tenantId') ?? '';
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
    const flags = new Map(data.flags.map((flag) => [flag.key, flag.enabled]));
    const local = this.overrides();
    return data.catalog.map((item) => ({
      ...item,
      enabled: local[item.key] ?? flags.get(item.key) ?? false,
    }));
  });

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected onToggle(key: string, event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    this.overrides.update((current) => ({ ...current, [key]: enabled }));
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.api.get<TenantFeaturesView>(`api/platform/tenants/${this.tenantId}/features`),
      );
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
        this.api.put<TenantFeaturesView>(`api/platform/tenants/${this.tenantId}/features`, {
          flags: this.rows().map((row) => ({ key: row.key, enabled: row.enabled })),
        }),
      );
      this.view.set(data);
      this.overrides.set({});
      this.toasts.success(this.t('platform.features.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }
}
