import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { PlatformTenant } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Single tenant on the control plane: rename, suspend/resume, open flags.
 */
@Component({
  selector: 'app-platform-tenant-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, RouterLink],
  template: `
    <app-page-header
      [title]="tenant()?.name ?? t('platform.tenants.title')"
      [subtitle]="t('platform.tenant.subtitle')"
      [badge]="tenant()?.id"
    >
      <a routerLink="/platform/tenants" class="btn btn--outline btn--sm no-underline">
        {{ t('nav.platform.tenants') }}
      </a>
    </app-page-header>

    <app-page-stack>
      @if (loadFailed()) {
        <p class="text-sm" style="color: var(--color-danger)">{{ t('common.error') }}</p>
        <button type="button" class="btn btn--outline btn--sm" (click)="load()">
          {{ t('common.retry') }}
        </button>
      } @else if (tenant(); as row) {
        <section class="card p-4 grid gap-3 sm:grid-cols-2">
          <p>
            <span class="label">{{ t('platform.tenants.status') }}</span>
            <span class="chip mt-1 inline-flex">{{ statusLabel(row.status) }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.schema') }}</span>
            <span class="font-mono text-sm">{{ row.schema_name }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.slug') }}</span>
            <span class="font-mono text-sm">{{ row.slug }}</span>
          </p>
          <p>
            <span class="label">{{ t('platform.tenants.created') }}</span>
            <span class="text-sm">{{ row.created_at ?? '—' }}</span>
          </p>
        </section>

        <form class="card p-4 grid gap-3 max-w-lg" (submit)="onRename($event)">
          <label class="block" for="rename-tenant">
            <span class="label">{{ t('platform.tenant.rename') }}</span>
            <input
              id="rename-tenant"
              class="input"
              name="name"
              type="text"
              required
              [value]="nameDraft()"
              (input)="onNameInput($event)"
            />
          </label>
          <div class="flex flex-wrap gap-2">
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="busy()">
              {{ t('common.save') }}
            </button>
            @if (row.status === 'active') {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="busy()"
                (click)="setStatus('suspended')"
              >
                {{ t('platform.tenants.suspend') }}
              </button>
            } @else if (row.status === 'suspended') {
              <button
                type="button"
                class="btn btn--primary btn--sm"
                [disabled]="busy()"
                (click)="setStatus('active')"
              >
                {{ t('platform.tenants.resume') }}
              </button>
            }
            <a
              class="btn btn--tonal btn--sm no-underline inline-flex items-center gap-1.5"
              [routerLink]="['/platform/tenants', row.id, 'features']"
            >
              <app-icon name="sparkles" size="0.875rem" />
              {{ t('platform.tenant.features') }}
            </a>
          </div>
        </form>
      } @else if (!loading()) {
        <p class="text-sm" style="color: var(--color-text-secondary)">
          {{ t('platform.tenants.empty') }}
        </p>
      }
    </app-page-stack>
  `,
})
export class PlatformTenantDetail {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);

  protected readonly tenantId = this.route.snapshot.paramMap.get('tenantId') ?? '';
  protected readonly tenant = signal<PlatformTenant | null>(null);
  protected readonly nameDraft = signal('');
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onNameInput(event: Event): void {
    this.nameDraft.set((event.target as HTMLInputElement).value);
  }

  constructor() {
    void this.load();
  }

  protected statusLabel(status: string): string {
    if (status === 'active') {
      return this.t('platform.tenants.status.active');
    }
    if (status === 'suspended') {
      return this.t('platform.tenants.status.suspended');
    }
    if (status === 'provisioning') {
      return this.t('platform.tenants.status.provisioning');
    }
    return status;
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const rows = await firstValueFrom(this.api.get<PlatformTenant[]>('api/platform/tenants'));
      const match = rows.find((row) => row.id === this.tenantId) ?? null;
      this.tenant.set(match);
      this.nameDraft.set(match?.name ?? '');
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async onRename(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = this.nameDraft().trim();
    if (!name || !this.tenantId) {
      return;
    }
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${this.tenantId}`, { name }),
      );
      this.tenant.set(updated);
      this.nameDraft.set(updated.name);
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async setStatus(status: 'active' | 'suspended'): Promise<void> {
    this.busy.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.patch<PlatformTenant>(`api/platform/tenants/${this.tenantId}`, { status }),
      );
      this.tenant.set(updated);
      this.toasts.success(this.t('platform.tenants.updatedToast'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busy.set(false);
    }
  }
}
