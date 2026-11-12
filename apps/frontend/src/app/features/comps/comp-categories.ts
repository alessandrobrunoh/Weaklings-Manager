import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BuildCategoryView,
  CompCategoryView,
  CreateBuildCategoryRequest,
  CreateCompCategoryRequest,
  UpdateBuildCategoryRequest,
  UpdateCompCategoryRequest,
} from '../../core/models/api.models';
import { ApiError, ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { LIST_TABLE_STYLES } from './list-table-styles';

/** Which catalogue the tab manages: the categories builds are filed under, or compositions are. */
export type CategoryKind = 'build' | 'comp';

type ManagedCategory = BuildCategoryView | CompCategoryView;

const SKELETON_ROWS = [0, 1, 2, 3];

/**
 * The Categories tab of the builds and compositions pages.
 *
 * A plain table of categories with Edit and Delete as permissions allow. Deleting a category that
 * still has builds or compositions in it is refused by the API (409); the confirmation dialog then
 * explains what is in the way next to the button instead of failing with a toast.
 *
 * The page owns the list (it also feeds the category filter and the create flows); this component
 * reports `changed` after every write so the page reloads it.
 */
@Component({
  selector: 'app-comp-categories',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, ErrorState, Icon],
  styles: [
    LIST_TABLE_STYLES,
    `
      .cc-name {
        font-size: 0.875rem;
        font-weight: 500;
      }
      .cc-actions {
        display: inline-flex;
        gap: 0.25rem;
      }
      .cc-error {
        margin-block-start: 0.75rem;
        padding: 0.625rem 0.75rem;
        border: 1px solid var(--color-error);
        border-radius: var(--radius-md);
        background: var(--color-surface-2);
        font-size: 0.8125rem;
        line-height: 1.25rem;
      }
      .cc-error strong {
        display: block;
        font-weight: 600;
      }
      .cc-field-error {
        margin-block-start: 0.25rem;
        font-size: 0.75rem;
        color: var(--color-error);
      }
    `,
  ],
  template: `
    @if (failed()) {
      <app-error-state
        [message]="t('compsList.cat.error.load')"
        [retryLabel]="t('common.retry')"
        (retry)="retry.emit()"
      />
    } @else if (!loading() && categories().length === 0) {
      <app-empty-state
        icon="package"
        [message]="t('compsList.cat.empty')"
        [hint]="kind() === 'build' ? t('compsList.cat.emptyBuilds') : t('compsList.cat.emptyComps')"
      >
        @if (canCreate()) {
          <button type="button" class="btn btn--primary btn--sm" (click)="openCreate()">
            <app-icon name="plus" size="0.875rem" />
            {{ t('comps.createCategory') }}
          </button>
        }
      </app-empty-state>
    } @else {
      <div class="lt" [attr.aria-busy]="loading()">
        <table
          class="lt-table"
          role="table"
          [attr.aria-label]="kind() === 'build' ? t('comps.buildCategories') : t('comps.compCategories')"
        >
          <thead role="rowgroup">
            <tr role="row">
              <th role="columnheader">{{ t('common.name') }}</th>
              <th role="columnheader">{{ t('common.description') }}</th>
              <th role="columnheader" class="lt-actions"><span class="sr-only">{{ t('common.actions') }}</span></th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            @if (loading()) {
              @for (n of skeleton; track n) {
                <tr class="lt-row" role="row" aria-hidden="true">
                  <td class="lt-c-name" role="cell"><span class="lt-skel" style="width: 8rem"></span></td>
                  <td role="cell"><span class="lt-skel" style="width: 14rem"></span></td>
                  <td class="lt-actions" role="cell"></td>
                </tr>
              }
            } @else {
              @for (category of categories(); track category.id) {
                <tr class="lt-row" role="row">
                  <td class="lt-c-name" role="cell">
                    <span class="cc-name">{{ category.name }}</span>
                  </td>
                  <td class="lt-muted lt-c-roles" role="cell">{{ category.description || '' }}</td>
                  <td class="lt-actions" role="cell">
                    <span class="cc-actions">
                      @if (canEdit()) {
                        <button type="button" class="btn btn--outline btn--sm" (click)="openEdit(category)">
                          {{ t('common.edit') }}
                          <span class="sr-only">{{ category.name }}</span>
                        </button>
                      }
                      @if (canDelete()) {
                        <button type="button" class="btn btn--ghost btn--sm" (click)="askDelete(category)">
                          {{ t('common.delete') }}
                          <span class="sr-only">{{ category.name }}</span>
                        </button>
                      }
                    </span>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }

    @if (dialogOpen()) {
      <app-dialog
        [title]="mode() === 'edit' ? t('comps.editCategory') : t('comps.createCategory')"
        size="sm"
        (closed)="closeDialog()"
      >
        <form id="comp-category-form" class="grid gap-4" novalidate (submit)="onSubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              autocomplete="off"
              required
              [value]="draftName()"
              [attr.aria-invalid]="nameInvalid()"
              [attr.aria-describedby]="nameInvalid() ? 'comp-category-name-error' : null"
              (input)="draftName.set($any($event.target).value); submitted.set(false)"
            />
            @if (nameInvalid()) {
              <p id="comp-category-name-error" class="cc-field-error" role="alert">
                {{ t('validation.required') }}
              </p>
            }
          </label>
          <label>
            <span class="label">{{ t('common.description') }}</span>
            <input
              class="input"
              type="text"
              autocomplete="off"
              [value]="draftDescription()"
              (input)="draftDescription.set($any($event.target).value)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            form="comp-category-form"
            [disabled]="saving()"
          >
            {{ mode() === 'edit' ? t('common.save') : t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingDelete(); as pending) {
      <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeDelete()">
        <p class="text-sm">{{ t('comps.delete.confirm') }}</p>
        <p class="mt-2 text-sm font-medium">{{ pending.name }}</p>
        @if (deleteBlocked()) {
          <div class="cc-error" role="alert">
            <strong>{{ t('compsList.cat.inUseTitle', { name: pending.name }) }}</strong>
            {{ kind() === 'build' ? t('compsList.cat.inUseBuilds') : t('compsList.cat.inUseComps') }}
          </div>
        }
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeDelete()">
            {{ deleteBlocked() ? t('common.close') : t('common.cancel') }}
          </button>
          @if (!deleteBlocked()) {
            <button type="button" class="btn btn--danger" [disabled]="saving()" (click)="confirmDelete()">
              {{ t('common.delete') }}
            </button>
          }
        </div>
      </app-dialog>
    }
  `,
})
export class CompCategories {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly kind = input.required<CategoryKind>();
  readonly categories = input.required<readonly ManagedCategory[]>();
  readonly loading = input(false);
  readonly failed = input(false);

  /** A category was created, edited or deleted; the page should reload its categories. */
  readonly changed = output<void>();
  /** The officer asked to try loading the categories again. */
  readonly retry = output<void>();

  protected readonly skeleton = SKELETON_ROWS;
  protected readonly saving = signal(false);
  protected readonly dialogOpen = signal(false);
  protected readonly mode = signal<'create' | 'edit'>('create');
  protected readonly editingId = signal<number | null>(null);
  protected readonly draftName = signal('');
  protected readonly draftDescription = signal('');
  protected readonly submitted = signal(false);
  protected readonly pendingDelete = signal<{ id: number; name: string } | null>(null);
  /** The API refused the delete because something still uses the category. */
  protected readonly deleteBlocked = signal(false);

  protected readonly nameInvalid = computed(() => this.submitted() && !this.draftName().trim());

  protected readonly canCreate = computed(() =>
    this.auth.hasPermission(
      this.kind() === 'build' ? 'comps.build_categories.create' : 'comps.comp_categories.create',
    ),
  );
  protected readonly canEdit = computed(() =>
    this.auth.hasPermission(
      this.kind() === 'build' ? 'comps.build_categories.edit' : 'comps.comp_categories.edit',
    ),
  );
  protected readonly canDelete = computed(() =>
    this.auth.hasPermission(
      this.kind() === 'build' ? 'comps.build_categories.delete' : 'comps.comp_categories.delete',
    ),
  );

  /** Opens the "new category" dialog (the page's primary action on this tab). */
  openCreate(): void {
    this.mode.set('create');
    this.editingId.set(null);
    this.draftName.set('');
    this.draftDescription.set('');
    this.submitted.set(false);
    this.dialogOpen.set(true);
  }

  protected openEdit(category: ManagedCategory): void {
    this.mode.set('edit');
    this.editingId.set(category.id);
    this.draftName.set(category.name);
    this.draftDescription.set(category.description ?? '');
    this.submitted.set(false);
    this.dialogOpen.set(true);
  }

  protected closeDialog(): void {
    this.dialogOpen.set(false);
    this.editingId.set(null);
  }

  protected askDelete(category: ManagedCategory): void {
    this.deleteBlocked.set(false);
    this.pendingDelete.set({ id: category.id, name: category.name });
  }

  protected closeDelete(): void {
    this.pendingDelete.set(null);
    this.deleteBlocked.set(false);
  }

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    this.submitted.set(true);
    if (!this.draftName().trim()) {
      return;
    }
    void this.save();
  }

  protected async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) {
      return;
    }
    this.saving.set(true);
    try {
      await firstValueFrom(this.api.delete<void>(`${this.basePath()}/${pending.id}`));
      this.closeDelete();
      this.changed.emit();
      this.toasts.success(this.t('compsList.cat.deleted'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.deleteBlocked.set(true);
      } else {
        this.toasts.error(this.t('compDetail.error.action'));
      }
    } finally {
      this.saving.set(false);
    }
  }

  private basePath(): string {
    return this.kind() === 'build' ? 'api/comps/build-categories' : 'api/comps/comp-categories';
  }

  private async save(): Promise<void> {
    const name = this.draftName().trim();
    const description = this.draftDescription().trim();
    const editing = this.mode() === 'edit' ? this.editingId() : null;
    const body: CreateBuildCategoryRequest | CreateCompCategoryRequest | UpdateBuildCategoryRequest | UpdateCompCategoryRequest =
      description ? { name, description } : { name };
    this.saving.set(true);
    try {
      if (editing !== null) {
        await firstValueFrom(this.api.patch<ManagedCategory[]>(`${this.basePath()}/${editing}`, body));
      } else {
        await firstValueFrom(this.api.post<ManagedCategory[]>(this.basePath(), body));
      }
      this.closeDialog();
      this.changed.emit();
      this.toasts.success(this.t(editing !== null ? 'compsList.cat.saved' : 'compsList.cat.created'));
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
