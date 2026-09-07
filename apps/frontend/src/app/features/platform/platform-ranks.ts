import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { FeatureCatalogItem, TenantRankView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

/**
 * Platform-created tenant ranks and the modules each rank unlocks.
 */
@Component({
  selector: 'app-platform-ranks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DataTable, DataTableCell, PageHeader, PageStack],
  template: `
    <app-page-header [title]="t('platform.ranks.title')" [subtitle]="t('platform.ranks.subtitle')" />

    <app-page-stack>
      <form class="card p-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" (submit)="onCreate($event)">
        <label class="block" for="rank-name">
          <span class="label">{{ t('platform.ranks.name') }}</span>
          <input
            id="rank-name"
            class="input"
            name="name"
            type="text"
            required
            autocomplete="off"
            [value]="newName()"
            (input)="onText(newName, $event)"
          />
        </label>
        <label class="block" for="rank-description">
          <span class="label">{{ t('platform.ranks.description') }}</span>
          <input
            id="rank-description"
            class="input"
            name="description"
            type="text"
            autocomplete="off"
            [value]="newDescription()"
            (input)="onText(newDescription, $event)"
          />
        </label>
        <button type="submit" class="btn btn--primary" [disabled]="creating()">
          {{ creating() ? t('common.loading') : t('platform.ranks.create') }}
        </button>
      </form>

      <app-data-table
        [columns]="columns()"
        [rows]="ranks()"
        [loading]="loading()"
        [error]="loadFailed()"
        (retry)="load()"
        [trackBy]="trackById"
        [emptyLabel]="'platform.ranks.empty'"
        emptyIcon="sparkles"
        [pageSize]="25"
      >
        <ng-template dataTableCell="features" let-row>
          <span class="text-sm">{{ featureSummary(row) }}</span>
        </ng-template>
        <ng-template dataTableCell="default" let-row>
          @if (row.is_default) {
            <span class="chip chip--success">{{ t('platform.ranks.default') }}</span>
          } @else {
            <span class="text-sm text-(--color-text-tertiary)">—</span>
          }
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end gap-2">
            @if (!row.is_default) {
              <button
                type="button"
                class="btn btn--outline btn--sm"
                [disabled]="busyId() === row.id"
                (click)="makeDefault(row)"
              >
                {{ t('platform.ranks.setDefault') }}
              </button>
            }
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="busyId() === row.id"
              (click)="select(row)"
            >
              {{ t('platform.ranks.edit') }}
            </button>
          </div>
        </ng-template>
      </app-data-table>

      @if (selected(); as rank) {
        <form class="card p-4 grid gap-3" (submit)="onSaveFeatures($event)">
          <h2 class="font-semibold text-sm">{{ rank.name }}</h2>
          <fieldset class="grid gap-2">
            <legend class="label">{{ t('platform.ranks.features') }}</legend>
            @for (item of catalog(); track item.key) {
              <label class="flex items-start gap-3" [attr.for]="'rank-feat-' + item.key">
                <input
                  class="checkbox mt-1"
                  type="checkbox"
                  [id]="'rank-feat-' + item.key"
                  [name]="item.key"
                  [checked]="draftKeys().includes(item.key)"
                  (change)="onToggle(item.key, $event)"
                />
                <span>
                  <span class="block font-medium text-sm">{{ item.display_name }}</span>
                  <span class="block font-mono text-xs text-[var(--color-text-tertiary)]">{{ item.key }}</span>
                </span>
              </label>
            }
          </fieldset>
          <div class="flex flex-wrap gap-2">
            <button type="submit" class="btn btn--primary btn--sm" [disabled]="saving()">
              {{ saving() ? t('common.loading') : t('common.save') }}
            </button>
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="busyId() === rank.id"
              (click)="remove(rank)"
            >
              {{ t('common.delete') }}
            </button>
          </div>
        </form>
      }
    </app-page-stack>
  `,
})
export class PlatformRanks {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly ranks = signal<TenantRankView[]>([]);
  protected readonly catalog = signal<FeatureCatalogItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly creating = signal(false);
  protected readonly saving = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly newName = signal('');
  protected readonly newDescription = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly draftKeys = signal<string[]>([]);

  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return this.ranks().find((row) => row.id === id) ?? null;
  });

  protected readonly columns = computed<readonly DataTableColumn<TenantRankView>[]>(() => [
    { key: 'name', label: 'platform.ranks.name', searchable: true, accessor: (row) => row.name },
    {
      key: 'features',
      label: 'platform.ranks.features',
      accessor: (row) => row.feature_keys.join(', '),
    },
    { key: 'default', label: 'platform.ranks.default' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly trackById = (row: TenantRankView) => row.id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  constructor() {
    void this.load();
  }

  protected select(row: TenantRankView): void {
    this.selectedId.set(row.id);
    this.draftKeys.set([...row.feature_keys]);
  }

  protected featureSummary(row: TenantRankView): string {
    if (row.feature_keys.length === 0) {
      return this.t('platform.ranks.noFeatures');
    }
    return row.feature_keys.join(', ');
  }

  protected onToggle(key: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draftKeys.update((keys) => {
      if (checked) {
        return keys.includes(key) ? keys : [...keys, key];
      }
      return keys.filter((item) => item !== key);
    });
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [ranks, catalog] = await Promise.all([
        firstValueFrom(this.api.get<TenantRankView[]>('api/platform/ranks')),
        firstValueFrom(this.api.get<FeatureCatalogItem[]>('api/platform/features')),
      ]);
      this.ranks.set(ranks);
      this.catalog.set(catalog);
      const selected = this.selectedId();
      const match = ranks.find((row) => row.id === selected);
      this.draftKeys.set(match?.feature_keys ?? []);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async onCreate(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = this.newName().trim();
    if (!name) {
      return;
    }
    this.creating.set(true);
    try {
      const created = await firstValueFrom(
        this.api.post<TenantRankView>('api/platform/ranks', {
          name,
          description: this.newDescription().trim() || undefined,
        }),
      );
      this.ranks.update((list) => [...list, created]);
      this.newName.set('');
      this.newDescription.set('');
      this.selectedId.set(created.id);
      this.draftKeys.set([]);
      this.toasts.success(this.t('platform.ranks.created'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.creating.set(false);
    }
  }

  protected async onSaveFeatures(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const id = this.selectedId();
    if (!id) {
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<TenantRankView>(`api/platform/ranks/${id}/features`, {
          keys: this.draftKeys(),
        }),
      );
      this.ranks.update((list) => list.map((row) => (row.id === updated.id ? updated : row)));
      this.draftKeys.set(updated.feature_keys);
      this.toasts.success(this.t('platform.ranks.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  /** Hand this rank to every tenant that registers from now on. */
  protected async makeDefault(row: TenantRankView): Promise<void> {
    this.busyId.set(row.id);
    try {
      const updated = await firstValueFrom(
        this.api.patch<TenantRankView>(`api/platform/ranks/${row.id}`, { is_default: true }),
      );
      this.ranks.update((list) =>
        list.map((item) => (item.id === updated.id ? updated : { ...item, is_default: false })),
      );
      this.toasts.success(this.t('platform.ranks.defaultSaved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async remove(row: TenantRankView): Promise<void> {
    this.busyId.set(row.id);
    try {
      await firstValueFrom(this.api.delete(`api/platform/ranks/${row.id}`));
      this.ranks.update((list) => list.filter((item) => item.id !== row.id));
      if (this.selectedId() === row.id) {
        this.selectedId.set(null);
        this.draftKeys.set([]);
      }
      this.toasts.success(this.t('platform.ranks.deleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }
}
