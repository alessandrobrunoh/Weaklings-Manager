import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { FeatureCatalogItem, TenantRankView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { DataTable, type DataTableColumn } from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { Icon } from '../../shared/components/icon/icon';
import { Menu, type MenuItem } from '../../shared/components/menu/menu';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatusChip } from '../../shared/components/status-chip/status-chip';

/**
 * Platform-created tenant ranks and the modules each rank unlocks.
 * The table lists ranks; creating, editing modules and deleting happen in dialogs.
 */
@Component({
  selector: 'app-platform-ranks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [COMPACT_FEATURE_STYLES],
  imports: [Checkbox, DataTable, DataTableCell, Dialog, Icon, Menu, PageHeader, PageStack, StatusChip],
  template: `
    <app-page-header [title]="t('platform.ranks.title')" [subtitle]="t('platform.ranks.subtitle')">
      <button
        type="button"
        class="btn btn--primary btn--sm inline-flex items-center gap-1.5"
        (click)="openCreate()"
      >
        <app-icon name="plus" size="0.875rem" />
        {{ t('platform.ranks.create') }}
      </button>
    </app-page-header>

    <app-page-stack>
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
        [ariaLabel]="t('platform.ranks.title')"
      >
        <ng-template dataTableCell="name" let-row>
          <span class="block font-medium">{{ row.name }}</span>
          @if (row.description) {
            <span class="hint block">{{ row.description }}</span>
          }
        </ng-template>
        <ng-template dataTableCell="features" let-row>
          @if (row.feature_keys.length === 0) {
            <span class="hint">{{ t('platform.ranks.noFeatures') }}</span>
          } @else {
            <span class="flex flex-wrap gap-1">
              @for (name of unlockNames(row); track name) {
                <span class="chip chip--neutral">{{ name }}</span>
              }
            </span>
          }
        </ng-template>
        <ng-template dataTableCell="default" let-row>
          @if (row.is_default) {
            <app-status-chip [value]="'default'" [label]="t('platform.ranks.default')" />
          } @else {
            <span class="hint">—</span>
          }
        </ng-template>
        <ng-template dataTableCell="actions" let-row>
          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              class="btn btn--outline btn--sm"
              [disabled]="busyId() === row.id"
              (click)="openEdit(row)"
            >
              {{ t('platform.ranks.edit') }}
            </button>
            <app-menu
              [items]="menuItems(row)"
              [label]="tp('platform.ranks.menuLabel', { name: row.name })"
              (itemSelect)="onMenu($event, row)"
            />
          </div>
        </ng-template>
      </app-data-table>
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog
        [title]="t('platform.ranks.createTitle')"
        [subtitle]="t('platform.ranks.createHint')"
        size="sm"
        (closed)="createOpen.set(false)"
      >
        <form id="create-rank-form" class="grid gap-4" (submit)="onCreate($event)">
          <p class="hint">{{ t('validation.requiredLegend') }}</p>
          <label class="block" for="rank-name">
            <span class="label">
              {{ t('platform.ranks.name') }}
              <span style="color: var(--color-error)" aria-hidden="true">*</span>
            </span>
            <input
              id="rank-name"
              class="input"
              name="name"
              type="text"
              required
              autofocus
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
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="createOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" form="create-rank-form" [disabled]="creating()">
            {{ creating() ? t('common.loading') : t('platform.ranks.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (selected(); as rank) {
      <app-dialog
        [title]="rank.name"
        [subtitle]="t('platform.ranks.editHint')"
        size="md"
        (closed)="selectedId.set(null)"
      >
        <form id="edit-rank-form" class="grid gap-3" (submit)="onSaveFeatures($event)">
          <fieldset class="grid gap-3" [disabled]="saving()">
            <legend class="label">{{ t('platform.ranks.features') }}</legend>
            @for (item of catalog(); track item.key) {
              <app-checkbox
                [inputId]="'rank-feat-' + item.key"
                [name]="item.key"
                [label]="item.display_name"
                [hint]="item.key"
                [checked]="draftKeys().includes(item.key)"
                (checkedChange)="onToggle(item.key, $event)"
              />
            }
          </fieldset>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="selectedId.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" form="edit-rank-form" [disabled]="saving()">
            {{ saving() ? t('common.loading') : t('common.save') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingDelete(); as rank) {
      <app-dialog
        [title]="t('platform.ranks.deleteTitle')"
        [subtitle]="tp('platform.ranks.deleteBody', { name: rank.name })"
        size="sm"
        (closed)="pendingDelete.set(null)"
      >
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="pendingDelete.set(null)">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="busyId() === rank.id"
            (click)="remove(rank)"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
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
  protected readonly createOpen = signal(false);
  protected readonly creating = signal(false);
  protected readonly saving = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly newName = signal('');
  protected readonly newDescription = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly pendingDelete = signal<TenantRankView | null>(null);
  protected readonly draftKeys = signal<string[]>([]);

  protected readonly selected = computed(() => {
    const id = this.selectedId();
    return this.ranks().find((row) => row.id === id) ?? null;
  });

  private readonly catalogNames = computed(
    () => new Map(this.catalog().map((item) => [item.key, item.display_name])),
  );

  protected readonly columns = computed<readonly DataTableColumn<TenantRankView>[]>(() => [
    { key: 'name', label: 'platform.ranks.name', searchable: true, accessor: (row) => row.name },
    {
      key: 'features',
      label: 'platform.ranks.unlocks',
      searchable: true,
      accessor: (row) => this.unlockNames(row).join(', '),
    },
    { key: 'default', label: 'platform.ranks.default' },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly trackById = (row: TenantRankView) => row.id;

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected tp = (key: TranslationKey, params: Record<string, string>) =>
    this.translate.t(key, params);

  protected onText(target: ReturnType<typeof signal<string>>, event: Event): void {
    target.set((event.target as HTMLInputElement).value);
  }

  constructor() {
    void this.load();
  }

  /** Display names of the modules a rank unlocks, in the rank's stored order. */
  protected unlockNames(row: TenantRankView): string[] {
    const names = this.catalogNames();
    return row.feature_keys.map((key) => names.get(key) ?? key);
  }

  protected openCreate(): void {
    this.newName.set('');
    this.newDescription.set('');
    this.createOpen.set(true);
  }

  protected openEdit(row: TenantRankView): void {
    this.selectedId.set(row.id);
    this.draftKeys.set([...row.feature_keys]);
  }

  protected menuItems(row: TenantRankView): MenuItem[] {
    const busy = this.busyId() === row.id;
    const items: MenuItem[] = [];
    if (!row.is_default) {
      items.push({ id: 'default', label: this.t('platform.ranks.setDefault'), disabled: busy });
    }
    items.push({
      id: 'delete',
      label: this.t('common.delete'),
      danger: true,
      disabled: busy,
      separatorBefore: items.length > 0,
    });
    return items;
  }

  protected onMenu(id: string, row: TenantRankView): void {
    if (id === 'default') {
      void this.makeDefault(row);
    } else if (id === 'delete') {
      this.pendingDelete.set(row);
    }
  }

  protected onToggle(key: string, checked: boolean): void {
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
      this.createOpen.set(false);
      this.toasts.success(this.t('platform.ranks.created'));
      // A new rank has no modules yet, so go straight to choosing them.
      this.openEdit(created);
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
      this.selectedId.set(null);
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
      this.pendingDelete.set(null);
      this.toasts.success(this.t('platform.ranks.deleted'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.busyId.set(null);
    }
  }
}
