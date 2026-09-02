import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import {
  summarizeErrors,
  validateBuildDraft,
  validateBuildName,
} from '../../shared/validation/build-validation';

import type {
  BuildCategoryView,
  BuildDetail,
  BuildItemSlot,
  BuildRole,
  BuildSlot,
  BuildSummary,
  CompCategoryView,
  CompDetail,
  CompPerformanceView,
  CompSummary,
  CreateBuildCategoryRequest,
  CreateBuildRequest,
  CreateCompCategoryRequest,
  CreateCompRequest,
  OpenAlbionItem,
  PaginatedData,
  UpdateBuildCategoryRequest,
  UpdateCompCategoryRequest,
} from '../../core/models/api.models';
import {
  albionEquipmentIconUrl,
  filterAlbionEquipmentCatalog,
} from '../../shared/data/albion-equipment-catalog';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  DataTable,
  type DataTableColumn,
  type DataTablePageChange,
} from '../../shared/components/data-table/data-table';
import { DataTableCell } from '../../shared/components/data-table/data-table-cell';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { StatCard } from '../../shared/components/stat-card/stat-card';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';
import { ViewToggle, type ViewToggleOption } from '../../shared/components/view-toggle/view-toggle';
import {
  buildCompForest,
  filterCompForest,
  flattenCompForest,
  type CompTreeNode,
} from './comp-tree';

const PAGE_SIZE = 10;
const OPTIONS_LIMIT = 500;

export type CompFilterType = 'all' | 'parents' | 'variants';

type TabId = 'comps' | 'builds' | 'categories';
type CategoryKind = 'build' | 'comp';
type ManagedCategory = BuildCategoryView | CompCategoryView;

type PendingDelete =
  | { kind: 'comp' | 'build'; id: number; name: string }
  | { kind: 'category'; id: number; name: string; categoryKind: CategoryKind };

/**
 * Compositions and builds workspace.
 *
 * Three tabs share one route: server-paginated builds, client-side categories table,
 * and a hierarchical tree-view for compositions with parent/variant grouping.
 * Create and delete always go through `app-dialog`.
 */
@Component({
  selector: 'app-comps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PageHeader,
    PageStack,
    ViewToggle,
    DataTable,
    DataTableCell,
    Dialog,
    EmptyState,
    ErrorState,
    EquipmentGrid,
    Icon,
    Loading,
    StatCard,
    TooltipDirective,
  ],
  template: `
    <app-page-header [title]="t('comps.title')" [subtitle]="t('comps.subtitle')">
      <button
        type="button"
        class="btn btn--outline btn--sm"
        [disabled]="loading() || categoriesLoading()"
        (click)="refreshNow()"
        [appTooltip]="t('common.refreshNow')"
        tooltipPosition="bottom"
      >
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>

      @if (canCreateCurrent()) {
        <button
          type="button"
          class="btn btn--primary btn--sm"
          (click)="openCreate()"
          [appTooltip]="createButtonLabel()"
          tooltipPosition="bottom"
        >
          <app-icon name="plus" size="0.875rem" />
          {{ createButtonLabel() }}
        </button>
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="switchTab($event)"
      />
    </app-page-header>

    <app-page-stack>
      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Comps summary">
        @if (tab() === 'comps') {
          <app-stat-card
            [label]="t('comps.stat.comps')"
            [value]="comps().length"
            icon="swords"
            tone="primary"
          />
          <app-stat-card
            [label]="t('comps.stat.parentComps')"
            [value]="parentCompsCount()"
            icon="shield"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('comps.stat.variantComps')"
            [value]="variantCompsCount()"
            icon="sparkles"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('comps.stat.compCategories')"
            [value]="compCategories().length"
            icon="list"
            tone="warning"
          />
        } @else {
          <app-stat-card
            [label]="t('comps.stat.comps')"
            [value]="compsTotal()"
            icon="swords"
            tone="primary"
          />
          <app-stat-card
            [label]="t('comps.stat.builds')"
            [value]="buildsTotal()"
            icon="shield"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('comps.stat.buildCategories')"
            [value]="buildCategories().length"
            icon="list"
            tone="neutral"
          />
          <app-stat-card
            [label]="t('comps.stat.compCategories')"
            [value]="compCategories().length"
            icon="list"
            tone="warning"
          />
        }
      </section>
      @if (tab() === 'comps') {
        <section class="grid gap-4" aria-label="Compositions list">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]">
              <div class="relative flex-1 min-w-[200px] max-w-sm">
                <span
                  class="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-[var(--color-text-secondary)]"
                >
                  <app-icon name="search" size="0.875rem" />
                </span>
                <input
                  type="text"
                  class="input pl-9 text-sm w-full"
                  [placeholder]="t('comps.searchPlaceholder')"
                  [value]="compSearchQuery()"
                  (input)="onCompSearchChange($event)"
                />
                @if (compSearchQuery()) {
                  <button
                    type="button"
                    class="absolute inset-y-0 right-0 flex items-center pr-2.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
                    (click)="clearCompSearch()"
                  >
                    <app-icon name="close" size="0.75rem" />
                  </button>
                }
              </div>

              <select
                class="select text-sm w-auto min-w-[150px]"
                [value]="compSelectedCategory()"
                (change)="onCompCategoryChange($event)"
              >
                <option value="">{{ t('comps.allCategories') }}</option>
                @for (category of compCategories(); track category.id) {
                  <option [value]="category.id">{{ category.name }}</option>
                }
              </select>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <app-view-toggle
                [options]="compTypeFilterOptions()"
                [active]="compFilterType()"
                (activeChange)="setCompFilterType($event)"
              />

              @if (compFilterType() === 'all' && hasExpandableParents()) {
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  (click)="toggleExpandAll()"
                  [appTooltip]="areAllExpanded() ? t('comps.collapseAll') : t('comps.expandAll')"
                  tooltipPosition="bottom"
                >
                  <app-icon [name]="areAllExpanded() ? 'chevron-up' : 'chevron-down'" size="0.75rem" />
                  {{ areAllExpanded() ? t('comps.collapseAll') : t('comps.expandAll') }}
                </button>
              }
            </div>
          </div>

          @if (loading()) {
            <app-loading [label]="t('common.loading')" />
          } @else if (loadFailed()) {
            <app-error-state
              [message]="t('common.error')"
              [retryLabel]="t('common.retry')"
              (retry)="loadComps()"
            />
          } @else if (visibleCompRows().length === 0) {
            <app-empty-state
              icon="package"
              [message]="comps().length === 0 ? t('common.empty') : t('comps.noCompsMatch')"
            />
          } @else {
            <div class="grid gap-3">
              @for (item of visibleCompRows(); track item.comp.id) {
                <div
                  class="card flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 hover:bg-[var(--color-surface-hover)] cursor-pointer transition-all"
                  [style.margin-left.rem]="item.depth * 1.5"
                  (click)="openComp(item.comp)"
                >
                  <!-- Comp Info & Ancestry -->
                  <div class="flex items-center gap-3 min-w-0 flex-1">
                    @if (compFilterType() === 'all' && !hasActiveCompCriteria() && item.children.length > 0) {
                      <button
                        type="button"
                        class="flex shrink-0 items-center justify-center w-7 h-7 rounded-lg bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-transform"
                        (click)="$event.stopPropagation(); toggleParentExpand(item.comp.id)"
                        [appTooltip]="isExpanded(item.comp.id) ? t('comps.collapseAll') : t('comps.expandAll')"
                        [attr.aria-label]="(isExpanded(item.comp.id) ? t('comps.collapseAll') : t('comps.expandAll')) + ': ' + item.comp.name"
                        [attr.aria-expanded]="isExpanded(item.comp.id)"
                        tooltipPosition="top"
                      >
                        <app-icon
                          [name]="isExpanded(item.comp.id) ? 'chevron-down' : 'chevron-right'"
                          size="0.875rem"
                        />
                      </button>
                    } @else if (item.depth > 0) {
                      <span class="font-mono text-sm text-[var(--color-text-tertiary)] select-none pl-2" aria-hidden="true">
                        {{ item.isLastSibling ? '└──' : '├──' }}
                      </span>
                    }

                    <div class="flex flex-col gap-1 min-w-0">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="font-bold text-base text-[var(--color-text)]">{{ item.comp.name }}</span>
                        <span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-[var(--color-surface-2)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                          v{{ item.comp.version }}
                        </span>
                        <span
                          class="px-2 py-0.5 rounded-full text-xs font-bold"
                          [class.bg-[var(--color-primary-subtle)]]="item.depth === 0"
                          [class.text-[var(--color-primary)]]="item.depth === 0"
                          [class.bg-[var(--color-surface-2)]]="item.depth > 0"
                          [class.text-[var(--color-text-secondary)]]="item.depth > 0"
                        >
                          {{ item.depth > 0 ? t('comps.badge.variant') : t('comps.badge.parent') }}
                        </span>
                        @if (item.comp.category_name) {
                          <span class="chip text-xs">{{ item.comp.category_name }}</span>
                        }
                      </div>

                      @if (compFilterType() === 'variants') {
                        <div class="text-xs text-[var(--color-text-secondary)] flex items-center gap-1">
                          <span>↳ {{ t('comps.derivedFrom') }}:</span>
                          <a
                            [routerLink]="['/comps', item.comp.parent_id]"
                            class="underline hover:text-[var(--color-text)] font-semibold"
                            (click)="$event.stopPropagation()"
                          >
                            {{ getParentCompName(item.comp.parent_id) }}
                          </a>
                        </div>
                      } @else if (item.comp.description) {
                        <span class="text-xs text-[var(--color-text-secondary)] line-clamp-1">
                          {{ item.comp.description }}
                        </span>
                      }
                    </div>
                  </div>

                  <!-- Comp Metrics & Actions -->
                  <div class="flex flex-wrap items-center justify-between md:justify-end gap-3 shrink-0">
                    <!-- Capacity & Win Rate -->
                    <div class="flex items-center gap-4 text-xs">
                      <div class="text-right">
                        <div class="text-[var(--color-text-secondary)]">Roster Capacity</div>
                        <div class="font-bold text-[var(--color-text)]">
                          @if (item.capacityIncrement === null) {
                            {{ item.comp.build_count }} builds · {{ item.comp.total_quantity }} slots
                          } @else {
                            {{ formatCapacityIncrement(item.capacityIncrement) }} = {{ item.comp.total_quantity }}
                          }
                        </div>
                      </div>

                      <div class="text-right pl-3 border-l border-[var(--color-border)]">
                        <div class="text-[var(--color-text-secondary)]">Win Rate</div>
                        @if (compPerformance(item.comp.id); as performance) {
                          <div class="font-bold text-sm text-[var(--color-text)]">
                            {{ formatPercent(performance.stats.win_rate) }}
                          </div>
                        } @else {
                          <div class="text-[var(--color-text-tertiary)] font-bold">—</div>
                        }
                      </div>
                    </div>

                    <!-- Action Buttons -->
                    <div class="flex items-center gap-1.5" (click)="$event.stopPropagation()">
                      @if (canManageComps()) {
                        <button
                          type="button"
                          class="btn btn--outline btn--sm"
                          (click)="openCreateVariant(item.comp)"
                          [appTooltip]="t('comps.createVariantTooltip')"
                          tooltipPosition="bottom"
                        >
                          <app-icon name="plus" size="0.75rem" />
                          {{ t('comps.addVariant') }}
                        </button>
                      }
                      <a class="btn btn--tonal btn--sm" [routerLink]="['/comps', item.comp.id]">
                        {{ t('common.open') }}
                      </a>
                      @if (canManageComps()) {
                        <button
                          type="button"
                          class="btn btn--danger btn--sm"
                          [disabled]="saving()"
                          (click)="askDeleteComp(item.comp)"
                        >
                          {{ t('common.delete') }}
                        </button>
                      }
                    </div>
                  </div>
                </div>
              }
            </div>
          }
        </section>
      } @else if (tab() === 'builds') {
        <app-data-table
          [columns]="buildColumns()"
          [rows]="builds()"
          [loading]="loading()"
          [error]="loadFailed()"
          [serverMode]="true"
          [totalItems]="buildsTotal()"
          [pageSize]="PAGE_SIZE"
          [trackBy]="trackBuild"
          [rowClickable]="true"
          emptyIcon="package"
          (retry)="loadBuilds()"
          (pageChange)="onBuildsPageChange($event)"
          (rowClick)="openBuild($event)"
        >
          <ng-template dataTableCell="name" let-row>
            <span class="font-bold text-sm">{{ row.name }}</span>
          </ng-template>
          <ng-template dataTableCell="role" let-row>
            <span class="chip font-semibold">{{ roleLabel(row.role) }}</span>
          </ng-template>
          <ng-template dataTableCell="category" let-row>
            <span class="chip text-xs">{{ row.category_name || t('comps.noCategory') }}</span>
          </ng-template>
          <ng-template dataTableCell="items" let-row>
            <span class="font-mono text-xs font-semibold">{{ row.item_count }}/10 slots</span>
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            <div class="flex flex-wrap justify-end gap-2" (click)="$event.stopPropagation()">
              <a class="btn btn--tonal btn--sm" [routerLink]="['/comps', 'builds', row.id]">{{
                t('common.open')
              }}</a>
              @if (canManageBuilds()) {
                <button
                  type="button"
                  class="btn btn--danger btn--sm"
                  [disabled]="saving()"
                  (click)="askDeleteBuild(row)"
                >
                  {{ t('common.delete') }}
                </button>
              }
            </div>
          </ng-template>
        </app-data-table>
      } @else {
        <app-view-toggle
          [options]="categoryKindOptions()"
          [active]="categoryKind()"
          (activeChange)="switchCategoryKind($event)"
        />
        <app-data-table
          [columns]="categoryColumns()"
          [rows]="managedCategories()"
          [loading]="categoriesLoading()"
          [error]="loadFailed()"
          [trackBy]="trackCategory"
          [pageSize]="PAGE_SIZE"
          emptyIcon="package"
          (retry)="loadCategories()"
        >
          <ng-template dataTableCell="name" let-row>
            <span style="font-weight: 500">{{ row.name }}</span>
          </ng-template>
          <ng-template dataTableCell="description" let-row>
            <span style="color: var(--color-text-secondary)">{{ row.description || '' }}</span>
          </ng-template>
          <ng-template dataTableCell="actions" let-row>
            @if (canManageCurrentCategory()) {
              <div class="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  class="btn btn--outline btn--sm"
                  (click)="openCategoryEdit(row)"
                >
                  {{ t('common.edit') }}
                </button>
                <button
                  type="button"
                  class="btn btn--danger btn--sm"
                  [disabled]="saving()"
                  (click)="askDeleteCategory(row)"
                >
                  {{ t('common.delete') }}
                </button>
              </div>
            }
          </ng-template>
        </app-data-table>
      }
    </app-page-stack>

    @if (createOpen()) {
      <app-dialog
        [title]="createDialogTitle()"
        [size]="tab() === 'builds' ? 'lg' : 'md'"
        (closed)="closeCreate()"
      >
        <form id="comps-create-form" class="grid gap-4" (submit)="onCreateSubmit($event)">
          <div class="grid gap-4 md:grid-cols-2">
            <label>
              <span class="label">{{ t('common.name') }}</span>
              <input
                class="input"
                type="text"
                [value]="draftName()"
                (input)="onNameChange($event)"
              />
            </label>
            <label>
              <span class="label">{{ t('common.category') }}</span>
              <select
                class="select"
                [value]="draftCategoryId()"
                (change)="onCategoryIdChange($event)"
              >
                <option value="">{{ t('comps.selectCategory') }}</option>
                @for (category of currentCategories(); track category.id) {
                  <option [value]="category.id">{{ category.name }}</option>
                }
              </select>
            </label>
          </div>

          <label>
            <span class="label">{{ t('common.description') }}</span>
            <textarea
              class="textarea"
              rows="3"
              [value]="draftDescription()"
              (input)="onDescriptionChange($event)"
            ></textarea>
          </label>

          @if (tab() === 'builds') {
            <label>
              <span class="label">{{ t('common.role') }}</span>
              <select class="select" [value]="draftRole()" (change)="onRoleChange($event)">
                @for (role of roles; track role) {
                  <option [value]="role">{{ roleLabel(role) }}</option>
                }
              </select>
            </label>

            <section class="surface grid gap-4 p-4" [attr.aria-label]="t('comps.equipment')">
              <header class="flex items-center justify-between gap-3">
                <div>
                  <h3 class="text-sm font-semibold" style="color: var(--color-text)">
                    {{ t('comps.equipment') }}
                  </h3>
                </div>
                <span class="chip">{{ draftItems().length }}/{{ slots.length }}</span>
              </header>
              <app-equipment-grid
                [items]="draftItems()"
                [canManage]="true"
                [editingSlot]="draftItemSlot()"
                [draftTier]="draftItemTier()"
                [draftSearch]="draftItemSearch()"
                [draftItemId]="draftSelectedItemId()"
                [searchResults]="itemSearchResults()"
                [searchLoading]="itemSearchLoading()"
                [tiers]="itemTiers"
                (slotToggle)="onSlotToggle($event)"
                (tierChange)="onPopoverTierChange($event)"
                (searchChange)="onPopoverSearchChange($event)"
                (itemSelect)="onPopoverItemSelect($event)"
                (saveSlot)="onPopoverSave()"
                (cancelEdit)="onPopoverCancel()"
                (removeItem)="removeDraftItem($event)"
              />
            </section>
          } @else {
            <label>
              <span class="label">{{ t('comps.parent') }}</span>
              <select
                class="select"
                [value]="draftParentCompId()"
                (change)="onParentCompChange($event)"
              >
                <option value="">{{ t('comps.noParent') }}</option>
                @for (comp of parentOptions(); track comp.id) {
                  <option [value]="comp.id">{{ comp.name }}</option>
                }
              </select>
            </label>

            @if (draftParentCompId()) {
              <p class="text-sm" style="color: var(--color-text-secondary)">
                {{ t('comps.expansionHint') }}
              </p>
            }
            <section class="surface grid gap-3 p-4" [attr.aria-label]="t('comps.builds')">
              <header>
                <h3 class="text-sm font-semibold" style="color: var(--color-text)">
                  {{ draftParentCompId() ? t('comps.expansionAdditions') : t('comps.builds') }}
                </h3>
              </header>
              <div class="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
                <select
                  class="select"
                  [value]="selectedBuildId()"
                  (change)="onSelectedBuildChange($event)"
                >
                  <option value="">{{ t('comps.selectBuild') }}</option>
                  @for (build of buildOptions(); track build.id) {
                    <option [value]="build.id">
                      {{ build.name }} — {{ roleLabel(build.role) }} —
                      {{ build.category_name || t('comps.noCategory') }}
                    </option>
                  }
                </select>
                <input
                  class="input"
                  type="number"
                  min="1"
                  [value]="selectedBuildQuantity()"
                  (input)="onSelectedBuildQuantityChange($event)"
                />
                <button type="button" class="btn btn--tonal" (click)="addBuildToDraft()">
                  {{ t('common.add') }}
                </button>
              </div>
              @if (draftBuildEntries().length > 0) {
                <div class="grid gap-2">
                  @for (entry of draftBuildEntries(); track entry.build_id) {
                    <div
                      class="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                      style="background-color: var(--color-surface-1)"
                    >
                      <span>{{ buildName(entry.build_id) }}</span>
                      <span class="chip">x{{ entry.quantity }}</span>
                      <button
                        type="button"
                        class="btn btn--ghost"
                        (click)="removeBuildFromDraft(entry.build_id)"
                      >
                        {{ t('common.delete') }}
                      </button>
                    </div>
                  }
                </div>
              }
            </section>
          }
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCreate()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            [attr.form]="'comps-create-form'"
            [disabled]="saving()"
          >
            {{ createButtonLabel() }}
          </button>
        </div>
      </app-dialog>
    }

    @if (categoryDialogOpen()) {
      <app-dialog
        [title]="
          categoryDialogMode() === 'edit' ? t('comps.editCategory') : t('comps.createCategory')
        "
        size="sm"
        (closed)="closeCategoryDialog()"
      >
        <form id="comps-category-form" class="grid gap-4" (submit)="onCategorySubmit($event)">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              [value]="categoryDraftName()"
              (input)="onCategoryDraftNameChange($event)"
            />
          </label>
          <label>
            <span class="label">{{ t('common.description') }}</span>
            <input
              class="input"
              type="text"
              [value]="categoryDraftDescription()"
              (input)="onCategoryDraftDescriptionChange($event)"
            />
          </label>
        </form>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeCategoryDialog()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            [attr.form]="'comps-category-form'"
            [disabled]="saving()"
          >
            {{ categoryDialogMode() === 'edit' ? t('common.save') : t('common.create') }}
          </button>
        </div>
      </app-dialog>
    }

    @if (pendingDelete(); as pending) {
      <app-dialog [title]="t('common.confirm')" size="sm" (closed)="closeConfirm()">
        <p>{{ t('comps.delete.confirm') }}</p>
        <p class="mt-2 text-sm" style="color: var(--color-text-secondary)">{{ pending.name }}</p>
        <div dialogFooter>
          <button type="button" class="btn btn--ghost" (click)="closeConfirm()">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn--danger"
            [disabled]="saving()"
            (click)="confirmDelete()"
          >
            {{ t('common.delete') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class Comps {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);

  protected readonly PAGE_SIZE = PAGE_SIZE;
  protected readonly tab = signal<TabId>('comps');
  protected readonly tabOptions = computed<ViewToggleOption[]>(() => [
    { id: 'comps', label: this.t('comps.comps') },
    { id: 'builds', label: this.t('comps.builds') },
    { id: 'categories', label: this.t('comps.categories') },
  ]);
  protected readonly loading = signal(false);
  protected readonly categoriesLoading = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);

  protected readonly comps = signal<CompSummary[]>([]);
  protected readonly compsTotal = signal(0);
  protected readonly builds = signal<BuildSummary[]>([]);
  protected readonly buildsTotal = signal(0);
  protected readonly buildCategories = signal<BuildCategoryView[]>([]);
  protected readonly compCategories = signal<CompCategoryView[]>([]);
  protected readonly buildOptions = signal<BuildSummary[]>([]);
  protected readonly parentOptions = signal<CompSummary[]>([]);
  protected readonly compPerformanceById = signal<Record<number, CompPerformanceView>>({});

  protected readonly compFilterType = signal<CompFilterType>('all');
  protected readonly compSearchQuery = signal('');
  protected readonly compSelectedCategory = signal('');
  protected readonly expandedParentIds = signal<Set<number>>(new Set());
  protected readonly createVariantTarget = signal<CompSummary | null>(null);

  protected readonly compTypeFilterOptions = computed<ViewToggleOption[]>(() => [
    { id: 'all', label: this.t('comps.filter.all') },
    { id: 'parents', label: this.t('comps.filter.parents') },
    { id: 'variants', label: this.t('comps.filter.variants') },
  ]);

  protected readonly compsMap = computed(() => {
    const map = new Map<number, CompSummary>();
    for (const comp of this.comps()) {
      map.set(comp.id, comp);
    }
    return map;
  });

  protected readonly parentCompsCount = computed(
    () => this.comps().filter((c) => !c.parent_id).length,
  );

  protected readonly variantCompsCount = computed(
    () => this.comps().filter((c) => !!c.parent_id).length,
  );

  protected readonly hasActiveCompCriteria = computed(
    () => !!this.compSearchQuery().trim() || !!this.compSelectedCategory(),
  );

  protected readonly compTree = computed<CompTreeNode[]>(() => buildCompForest(this.comps()));

  protected readonly filteredCompTree = computed<CompTreeNode[]>(() =>
    filterCompForest(this.compTree(), (comp) => this.matchesCompFilter(comp)),
  );

  protected readonly visibleCompRows = computed<CompTreeNode[]>(() => {
    const filterType = this.compFilterType();

    if (filterType === 'parents') {
      return this.compTree().filter((node) => this.matchesCompFilter(node.comp));
    }

    if (filterType === 'variants') {
      return flattenCompForest(this.compTree(), new Set(), true).filter(
        (node) => node.comp.parent_id !== null && this.matchesCompFilter(node.comp),
      );
    }

    return flattenCompForest(
      this.filteredCompTree(),
      this.expandedParentIds(),
      this.hasActiveCompCriteria(),
    );
  });

  protected readonly expandableCompIds = computed(
    () => new Set(this.collectExpandableCompIds(this.filteredCompTree())),
  );

  protected readonly hasExpandableParents = computed(() => this.expandableCompIds().size > 0);

  protected readonly areAllExpanded = computed(() => {
    const expandable = this.expandableCompIds();
    if (expandable.size === 0) {
      return false;
    }
    const expanded = this.expandedParentIds();
    return [...expandable].every((id) => expanded.has(id));
  });

  protected readonly createOpen = signal(false);
  protected readonly categoryDialogOpen = signal(false);
  protected readonly categoryDialogMode = signal<'create' | 'edit'>('create');
  protected readonly categoryKind = signal<CategoryKind>('build');
  protected readonly categoryKindOptions = computed<ViewToggleOption[]>(() => [
    { id: 'build', label: this.t('comps.buildCategories') },
    { id: 'comp', label: this.t('comps.compCategories') },
  ]);
  protected readonly categoryDraftName = signal('');
  protected readonly categoryDraftDescription = signal('');
  protected readonly editingCategoryId = signal<number | null>(null);
  protected readonly pendingDelete = signal<PendingDelete | null>(null);

  protected readonly draftName = signal('');
  protected readonly draftDescription = signal('');
  protected readonly draftCategoryId = signal('');
  protected readonly draftRole = signal<BuildRole>('dps');
  protected readonly draftParentCompId = signal('');
  protected readonly selectedBuildId = signal('');
  protected readonly selectedBuildQuantity = signal(1);
  protected readonly draftBuildEntries = signal<Array<{ build_id: number; quantity: number }>>([]);
  protected readonly draftItemSlot = signal<BuildSlot | null>(null);
  protected readonly draftItemType = signal('');
  protected readonly draftItemId = signal('');
  protected readonly draftItemName = signal('');
  protected readonly draftItemIcon = signal('');
  protected readonly draftItemTier = signal('T8');
  protected readonly draftItemSearch = signal('');
  protected readonly draftSelectedItemId = signal('');
  protected readonly itemSearchResults = signal<OpenAlbionItem[]>([]);
  protected readonly itemSearchLoading = signal(false);
  protected readonly draftItems = signal<BuildItemSlot[]>([]);

  protected readonly roles: readonly BuildRole[] = [
    'healer',
    'support',
    'dps',
    'tank',
    'battle_mount',
    'brawler',
  ];
  protected readonly slots: readonly BuildSlot[] = [
    'head',
    'armor',
    'shoes',
    'potion',
    'food',
    'mount',
    'cape',
    'weapon',
    'off_hand',
  ];
  protected readonly itemTiers: readonly string[] = ['T4', 'T5', 'T6', 'T7', 'T8'];

  protected readonly trackComp = (row: CompSummary): unknown => row.id;
  protected readonly trackBuild = (row: BuildSummary): unknown => row.id;
  protected readonly trackCategory = (row: ManagedCategory): unknown => row.id;

  private compsPage: DataTablePageChange | null = null;
  private buildsPage: DataTablePageChange | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly canManageComps = computed(() => this.auth.hasPermission('comps.comps.manage'));
  protected readonly canManageBuilds = computed(() =>
    this.auth.hasPermission('comps.builds.manage'),
  );
  protected readonly canManageCurrentCategory = computed(() =>
    this.categoryKind() === 'build'
      ? this.auth.hasPermission('comps.build_categories.manage')
      : this.auth.hasPermission('comps.comp_categories.manage'),
  );

  protected readonly currentCategories = computed(() =>
    this.tab() === 'builds' ? this.buildCategories() : this.compCategories(),
  );
  protected readonly managedCategories = computed(() =>
    this.categoryKind() === 'build' ? this.buildCategories() : this.compCategories(),
  );

  protected readonly compColumns = computed<readonly DataTableColumn<CompSummary>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
    },
    {
      key: 'category',
      label: 'common.category',
      sortable: true,
      accessor: (row) => row.category_name ?? '',
      filterOptions: this.compCategories().map((category) => ({
        value: String(category.id),
        label: category.name,
      })),
    },
    {
      key: 'slots',
      label: 'comps.slots',
      accessor: (row) => `${row.build_count} / ${row.total_quantity}`,
    },
    {
      key: 'winrate',
      label: 'comps.winrate',
      align: 'right',
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly buildColumns = computed<readonly DataTableColumn<BuildSummary>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
    },
    {
      key: 'role',
      label: 'common.role',
      sortable: true,
      accessor: (row) => row.role,
      filterOptions: this.roles.map((role) => ({ value: role, label: this.roleLabel(role) })),
    },
    {
      key: 'category',
      label: 'common.category',
      accessor: (row) => row.category_name ?? '',
      filterOptions: this.buildCategories().map((category) => ({
        value: String(category.id),
        label: category.name,
      })),
    },
    {
      key: 'items',
      label: 'comps.items',
      accessor: (row) => row.item_count,
      align: 'right',
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected readonly categoryColumns = computed<readonly DataTableColumn<ManagedCategory>[]>(() => [
    {
      key: 'name',
      label: 'common.name',
      sortable: true,
      searchable: true,
      accessor: (row) => row.name,
      comparator: (a, b) => a.name.localeCompare(b.name),
    },
    {
      key: 'description',
      label: 'common.description',
      searchable: true,
      accessor: (row) => row.description ?? '',
    },
    { key: 'actions', label: 'common.actions', align: 'right' },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.init();
  }

  private async init(): Promise<void> {
    await this.loadCategories();
    await this.loadComps();
  }

  protected async refreshNow(): Promise<void> {
    await this.loadCategories();
    if (this.tab() === 'comps') {
      await this.loadComps();
    } else if (this.tab() === 'builds') {
      await this.loadBuilds();
    }
  }

  protected canCreateCurrent(): boolean {
    if (this.tab() === 'comps') {
      return this.canManageComps();
    }
    if (this.tab() === 'builds') {
      return this.canManageBuilds();
    }
    return this.canManageCurrentCategory();
  }

  protected createButtonLabel(): string {
    if (this.tab() === 'builds') {
      return this.t('comps.createBuild');
    }
    if (this.tab() === 'categories') {
      return this.t('comps.createCategory');
    }
    return this.t('comps.createComp');
  }

  protected switchTab(next: string): void {
    if (next !== 'comps' && next !== 'builds' && next !== 'categories') {
      return;
    }
    if (this.tab() === next) {
      return;
    }
    this.tab.set(next);
    this.closeCreate();
    this.closeCategoryDialog();
    this.closeConfirm();
    this.loadFailed.set(false);
    if (next === 'comps') {
      this.compsPage = null;
      void this.loadComps();
    } else if (next === 'builds') {
      this.buildsPage = null;
      void this.loadBuilds();
    } else {
      void this.loadCategories();
    }
  }

  protected switchCategoryKind(next: string): void {
    if (next !== 'build' && next !== 'comp') {
      return;
    }
    this.categoryKind.set(next);
    this.closeCategoryDialog();
  }

  protected openCreate(): void {
    if (this.tab() === 'categories') {
      this.openCategoryCreate();
      return;
    }
    this.createOpen.set(true);
    void this.loadCreateOptions();
  }

  protected closeCreate(): void {
    this.createOpen.set(false);
    this.createVariantTarget.set(null);
    this.resetCreateForm();
  }

  protected isExpanded(parentId: number): boolean {
    return this.expandedParentIds().has(parentId);
  }

  protected toggleParentExpand(parentId: number): void {
    this.expandedParentIds.update((set) => {
      const next = new Set(set);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  }

  protected toggleExpandAll(): void {
    const expandable = this.expandableCompIds();
    this.expandedParentIds.update((expanded) => {
      const next = new Set(expanded);
      if (this.areAllExpanded()) {
        for (const id of expandable) {
          next.delete(id);
        }
      } else {
        for (const id of expandable) {
          next.add(id);
        }
      }
      return next;
    });
  }

  protected formatCapacityIncrement(increment: number): string {
    return increment > 0 ? `+${increment}` : String(increment);
  }

  private matchesCompFilter(comp: CompSummary): boolean {
    const categoryId = this.compSelectedCategory() ? Number(this.compSelectedCategory()) : null;
    if (categoryId !== null && comp.category_id !== categoryId) {
      return false;
    }

    const search = this.compSearchQuery().trim().toLowerCase();
    return (
      !search ||
      comp.name.toLowerCase().includes(search) ||
      (comp.description?.toLowerCase().includes(search) ?? false) ||
      (comp.category_name?.toLowerCase().includes(search) ?? false)
    );
  }

  private collectExpandableCompIds(nodes: readonly CompTreeNode[]): number[] {
    const ids: number[] = [];
    for (const node of nodes) {
      if (node.children.length > 0) {
        ids.push(node.comp.id, ...this.collectExpandableCompIds(node.children));
      }
    }
    return ids;
  }

  protected getParentCompName(parentId: number | null | undefined): string {
    if (!parentId) {
      return '';
    }
    return this.compsMap().get(parentId)?.name ?? `#${parentId}`;
  }

  protected onCompSearchChange(event: Event): void {
    this.compSearchQuery.set((event.target as HTMLInputElement).value);
  }

  protected clearCompSearch(): void {
    this.compSearchQuery.set('');
  }

  protected onCompCategoryChange(event: Event): void {
    this.compSelectedCategory.set((event.target as HTMLSelectElement).value);
  }

  protected setCompFilterType(type: string): void {
    if (type === 'all' || type === 'parents' || type === 'variants') {
      this.compFilterType.set(type);
    }
  }

  protected openCreateVariant(parentComp: CompSummary): void {
    this.draftName.set('');
    this.draftDescription.set('');
    this.draftCategoryId.set(String(parentComp.category_id));
    this.draftParentCompId.set(String(parentComp.id));
    this.draftBuildEntries.set([]);
    this.selectedBuildId.set('');
    this.selectedBuildQuantity.set(1);
    this.createVariantTarget.set(parentComp);
    this.createOpen.set(true);
    void this.loadCreateOptions();
  }

  protected createDialogTitle(): string {
    const target = this.createVariantTarget();
    if (target) {
      return `${this.t('comps.createVariantFor')}: ${target.name}`;
    }
    return this.createButtonLabel();
  }

  protected openComp(row: CompSummary): void {
    void this.router.navigate(['/comps', row.id]);
  }

  protected openBuild(row: BuildSummary): void {
    void this.router.navigate(['/comps', 'builds', row.id]);
  }

  protected onCompsPageChange(event: DataTablePageChange): void {
    this.compsPage = event;
    void this.loadComps();
  }

  protected onBuildsPageChange(event: DataTablePageChange): void {
    this.buildsPage = event;
    void this.loadBuilds();
  }

  protected onNameChange(event: Event): void {
    this.draftName.set((event.target as HTMLInputElement).value);
  }

  protected onDescriptionChange(event: Event): void {
    this.draftDescription.set((event.target as HTMLTextAreaElement).value);
  }

  protected onCategoryIdChange(event: Event): void {
    this.draftCategoryId.set((event.target as HTMLSelectElement).value);
  }

  protected onRoleChange(event: Event): void {
    this.draftRole.set((event.target as HTMLSelectElement).value as BuildRole);
  }

  protected onParentCompChange(event: Event): void {
    this.draftParentCompId.set((event.target as HTMLSelectElement).value);
  }

  protected onSelectedBuildChange(event: Event): void {
    this.selectedBuildId.set((event.target as HTMLSelectElement).value);
  }

  protected onSelectedBuildQuantityChange(event: Event): void {
    this.selectedBuildQuantity.set(Math.max(1, Number((event.target as HTMLInputElement).value)));
  }

  protected onCategoryDraftNameChange(event: Event): void {
    this.categoryDraftName.set((event.target as HTMLInputElement).value);
  }

  protected onCategoryDraftDescriptionChange(event: Event): void {
    this.categoryDraftDescription.set((event.target as HTMLInputElement).value);
  }

  protected onSlotToggle(slot: BuildSlot): void {
    if (this.draftItemSlot() === slot) {
      this.onPopoverCancel();
      return;
    }
    this.draftItemSlot.set(slot);
    this.resetDraftItemFields();
    void this.searchItems();
  }

  protected onPopoverTierChange(tier: string): void {
    this.draftItemTier.set(tier);
    this.clearSelectedItem();
    void this.searchItems();
  }

  protected onPopoverSearchChange(query: string): void {
    this.draftItemSearch.set(query);
    this.clearSelectedItem();
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      void this.searchItems();
    }, 250);
  }

  protected onPopoverItemSelect(itemId: string): void {
    this.draftSelectedItemId.set(itemId);
    const item = this.itemSearchResults().find((candidate) => String(candidate.id) === itemId);
    if (!item) {
      this.clearSelectedItem();
      return;
    }
    this.draftItemId.set(String(item.id));
    this.draftItemName.set(item.name);
    this.draftItemType.set(item.type);
    this.draftItemTier.set(this.normalizeTier(item.tier));
    this.draftItemIcon.set(this.itemIconUrl(item));
  }

  protected onPopoverSave(): void {
    this.addItemToDraft();
    this.onPopoverCancel();
  }

  protected onPopoverCancel(): void {
    this.draftItemSlot.set(null);
    this.resetDraftItemFields();
  }

  protected addBuildToDraft(): void {
    const buildId = Number(this.selectedBuildId());
    if (buildId <= 0) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const quantity = this.selectedBuildQuantity();
    this.draftBuildEntries.update((entries) => {
      const existing = entries.find((entry) => entry.build_id === buildId);
      if (existing) {
        return entries.map((entry) =>
          entry.build_id === buildId ? { ...entry, quantity: entry.quantity + quantity } : entry,
        );
      }
      return [...entries, { build_id: buildId, quantity }];
    });
    this.selectedBuildId.set('');
    this.selectedBuildQuantity.set(1);
  }

  protected removeBuildFromDraft(buildId: number): void {
    this.draftBuildEntries.update((entries) =>
      entries.filter((entry) => entry.build_id !== buildId),
    );
  }

  protected addItemToDraft(): void {
    const itemId = Number(this.draftItemId());
    const itemType = this.draftItemType().trim();
    const itemName = this.draftItemName().trim();
    if (itemId <= 0 || !itemType || !itemName) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const slot = this.draftItemSlot();
    if (!slot) {
      return;
    }
    const item: BuildItemSlot = {
      // The create form only builds the main set; the swap is filled in on the build page.
      loadout: 'main',
      slot,
      openalbion_item_type: itemType,
      openalbion_item_id: itemId,
      openalbion_item_name: itemName,
    };
    const icon = this.draftItemIcon().trim();
    const tier = this.draftItemTier().trim();
    if (icon) {
      item.openalbion_item_icon = icon;
    }
    if (tier) {
      item.openalbion_item_tier = tier;
    }
    this.draftItems.update((items) => [
      ...items.filter((existing) => existing.slot !== item.slot),
      item,
    ]);
  }

  protected removeDraftItem(slot: BuildSlot): void {
    this.draftItems.update((items) => items.filter((item) => item.slot !== slot));
  }

  protected buildName(buildId: number): string {
    return this.buildOptions().find((build) => build.id === buildId)?.name ?? `Build #${buildId}`;
  }

  protected roleLabel(role: BuildRole): string {
    return role.replace(/_/g, ' ');
  }

  protected itemIconUrl(item: OpenAlbionItem): string {
    if (item.icon) {
      return item.icon;
    }
    if (!item.identifier) {
      return '';
    }
    return albionEquipmentIconUrl(item.identifier);
  }

  protected compPerformance(compId: number): CompPerformanceView | null {
    return this.compPerformanceById()[compId] ?? null;
  }

  protected formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  protected onCreateSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void this.createItem();
  }

  protected openCategoryCreate(): void {
    this.categoryDialogMode.set('create');
    this.editingCategoryId.set(null);
    this.categoryDraftName.set('');
    this.categoryDraftDescription.set('');
    this.categoryDialogOpen.set(true);
  }

  protected openCategoryEdit(category: ManagedCategory): void {
    this.categoryDialogMode.set('edit');
    this.editingCategoryId.set(category.id);
    this.categoryDraftName.set(category.name);
    this.categoryDraftDescription.set(category.description ?? '');
    this.categoryDialogOpen.set(true);
  }

  protected closeCategoryDialog(): void {
    this.categoryDialogOpen.set(false);
    this.editingCategoryId.set(null);
    this.categoryDraftName.set('');
    this.categoryDraftDescription.set('');
  }

  protected onCategorySubmit(event: SubmitEvent): void {
    event.preventDefault();
    if (this.categoryDialogMode() === 'edit') {
      void this.saveCategoryEdit();
      return;
    }
    void this.createCategory();
  }

  protected askDeleteComp(item: CompSummary): void {
    this.pendingDelete.set({ kind: 'comp', id: item.id, name: item.name });
  }

  protected askDeleteBuild(item: BuildSummary): void {
    this.pendingDelete.set({ kind: 'build', id: item.id, name: item.name });
  }

  protected askDeleteCategory(category: ManagedCategory): void {
    this.pendingDelete.set({
      kind: 'category',
      id: category.id,
      name: category.name,
      categoryKind: this.categoryKind(),
    });
  }

  protected closeConfirm(): void {
    this.pendingDelete.set(null);
  }

  protected async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) {
      return;
    }
    this.saving.set(true);
    try {
      if (pending.kind === 'category') {
        const path =
          pending.categoryKind === 'build'
            ? `api/comps/build-categories/${pending.id}`
            : `api/comps/comp-categories/${pending.id}`;
        await firstValueFrom(this.api.delete<void>(path));
        await this.loadCategories();
      } else if (pending.kind === 'build') {
        await firstValueFrom(this.api.delete(`api/comps/builds/${pending.id}`));
        await this.loadBuilds();
      } else {
        await firstValueFrom(this.api.delete(`api/comps/${pending.id}`));
        await this.loadComps();
      }
      this.pendingDelete.set(null);
      this.toasts.success(this.t('common.delete'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async createCategory(): Promise<void> {
    const name = this.categoryDraftName().trim();
    if (!name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const description = this.categoryDraftDescription().trim();
    this.saving.set(true);
    try {
      if (this.categoryKind() === 'build') {
        const request: CreateBuildCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.post<BuildCategoryView[]>('api/comps/build-categories', request),
        );
      } else {
        const request: CreateCompCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.post<CompCategoryView[]>('api/comps/comp-categories', request),
        );
      }
      this.closeCategoryDialog();
      await this.loadCategories();
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async saveCategoryEdit(): Promise<void> {
    const categoryId = this.editingCategoryId();
    const name = this.categoryDraftName().trim();
    if (!categoryId || !name) {
      this.toasts.error(this.t('validation.required'));
      return;
    }
    const description = this.categoryDraftDescription().trim();
    this.saving.set(true);
    try {
      if (this.categoryKind() === 'build') {
        const request: UpdateBuildCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.patch<BuildCategoryView[]>(`api/comps/build-categories/${categoryId}`, request),
        );
      } else {
        const request: UpdateCompCategoryRequest = { name };
        if (description) {
          request.description = description;
        }
        await firstValueFrom(
          this.api.patch<CompCategoryView[]>(`api/comps/comp-categories/${categoryId}`, request),
        );
      }
      this.closeCategoryDialog();
      await this.loadCategories();
      this.toasts.success(this.t('common.save'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async createItem(): Promise<void> {
    const name = this.draftName().trim();
    const categoryId = Number(this.draftCategoryId());
    if (this.tab() === 'builds') {
      const errors = validateBuildDraft(
        {
          name: this.draftName(),
          categoryId: categoryId > 0 ? categoryId : null,
          role: this.draftRole(),
          filledSlots: this.draftItems().map((item) => item.slot),
        },
        { existingNames: this.builds().map((build) => build.name) },
      );
      if (errors.length > 0) {
        this.toasts.error(summarizeErrors(errors));
        return;
      }
    } else {
      const nameError = validateBuildName(this.draftName(), {
        existingNames: this.comps().map((comp) => comp.name),
      });
      if (nameError) {
        this.toasts.error(nameError.message);
        return;
      }
      if (categoryId <= 0) {
        this.toasts.error(this.t('validation.required'));
        return;
      }
      if (this.draftBuildEntries().length === 0) {
        this.toasts.error(this.t('validation.required'));
        return;
      }
    }

    this.saving.set(true);
    try {
      await this.postCurrentItem(name, categoryId);
      this.closeCreate();
      if (this.tab() === 'builds') {
        await this.loadBuilds();
      } else {
        await this.loadComps();
      }
      this.toasts.success(this.t('common.create'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  private async postCurrentItem(name: string, categoryId: number): Promise<void> {
    const description = this.draftDescription().trim();
    if (this.tab() === 'comps') {
      const request: CreateCompRequest = {
        name,
        category_id: categoryId,
        builds: this.draftBuildEntries(),
      };
      if (description) {
        request.description = description;
      }
      const parentId = Number(this.draftParentCompId());
      if (parentId > 0) {
        request.parent_id = parentId;
      }
      await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      return;
    }
    const request: CreateBuildRequest = {
      name,
      category_id: categoryId,
      role: this.draftRole(),
    };
    if (description) {
      request.description = description;
    }
    if (this.draftItems().length > 0) {
      request.items = this.draftItems();
    }
    await firstValueFrom(this.api.post<BuildDetail>('api/comps/builds', request));
  }

  private resetCreateForm(): void {
    this.draftName.set('');
    this.draftDescription.set('');
    this.draftCategoryId.set('');
    this.draftRole.set('dps');
    this.draftParentCompId.set('');
    this.selectedBuildId.set('');
    this.selectedBuildQuantity.set(1);
    this.draftBuildEntries.set([]);
    this.draftItems.set([]);
    this.onPopoverCancel();
  }

  private resetDraftItemFields(): void {
    this.draftItemSearch.set('');
    this.itemSearchResults.set([]);
    this.clearSelectedItem();
  }

  private clearSelectedItem(): void {
    this.draftSelectedItemId.set('');
    this.draftItemType.set('');
    this.draftItemId.set('');
    this.draftItemName.set('');
    this.draftItemIcon.set('');
  }

  private normalizeTier(tier: string): string {
    const normalized = tier.trim().toUpperCase();
    if (normalized.startsWith('T')) {
      return normalized.split('.')[0];
    }
    return `T${normalized.split('.')[0]}`;
  }

  private async searchItems(): Promise<void> {
    const slot = this.draftItemSlot();
    if (!slot) {
      this.itemSearchResults.set([]);
      return;
    }
    this.itemSearchLoading.set(true);
    try {
      const catalog = await this.albionCatalog.load();
      this.itemSearchResults.set(
        filterAlbionEquipmentCatalog(catalog, this.draftItemSearch(), slot, this.draftItemTier()),
      );
    } catch {
      this.itemSearchResults.set([]);
      this.toasts.error(this.t('common.error'));
    } finally {
      this.itemSearchLoading.set(false);
    }
  }

  private listParams(event: DataTablePageChange | null): Record<string, string | number> {
    const params: Record<string, string | number> = {
      page: event?.page ?? 1,
      limit: event?.pageSize ?? PAGE_SIZE,
    };
    const search = event?.search.trim();
    if (search) {
      params['q'] = search;
    }
    if (event?.sort) {
      params['sort'] = event.sort.columnKey;
      params['order'] = event.sort.direction;
    }
    const categoryId = event?.columnFilters['category'];
    if (categoryId) {
      params['category_id'] = Number(categoryId);
    }
    const role = event?.columnFilters['role'];
    if (role) {
      params['role'] = role;
    }
    return params;
  }

  private async loadCreateOptions(): Promise<void> {
    try {
      const [builds, comps] = await Promise.all([
        firstValueFrom(
          this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
            page: 1,
            limit: OPTIONS_LIMIT,
            sort: 'name',
            order: 'asc',
          }),
        ),
        firstValueFrom(
          this.api.get<PaginatedData<CompSummary>>('api/comps', {
            page: 1,
            limit: OPTIONS_LIMIT,
            sort: 'name',
            order: 'asc',
          }),
        ),
      ]);
      this.buildOptions.set(builds.items);
      this.parentOptions.set(comps.items);
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    }
  }

  protected async loadCategories(): Promise<void> {
    this.categoriesLoading.set(true);
    this.loadFailed.set(false);
    try {
      const [buildCategories, compCategories] = await Promise.all([
        firstValueFrom(this.api.get<BuildCategoryView[]>('api/comps/build-categories')),
        firstValueFrom(this.api.get<CompCategoryView[]>('api/comps/comp-categories')),
      ]);
      this.buildCategories.set(buildCategories);
      this.compCategories.set(compCategories);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.categoriesLoading.set(false);
    }
  }

  protected async loadComps(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: OPTIONS_LIMIT,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.comps.set(data.items);
      this.compsTotal.set(data.total_items);
      this.expandedParentIds.set(
        new Set(this.collectExpandableCompIds(buildCompForest(data.items))),
      );
      await this.loadCompPerformance(data.items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async loadBuilds(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const data = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>(
          'api/comps/builds',
          this.listParams(this.buildsPage),
        ),
      );
      this.compPerformanceById.set({});
      this.builds.set(data.items);
      this.buildsTotal.set(data.total_items);
    } catch (error) {
      this.loadFailed.set(true);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }

  private async loadCompPerformance(comps: readonly CompSummary[]): Promise<void> {
    if (comps.length === 0) {
      this.compPerformanceById.set({});
      return;
    }
    const performanceEntries = await Promise.all(
      comps.map(async (comp) => {
        try {
          const performance = await firstValueFrom(
            this.api.get<CompPerformanceView>(`api/comps/${comp.id}/performance`),
          );
          return [comp.id, performance] as const;
        } catch {
          return null;
        }
      }),
    );
    this.compPerformanceById.set(
      Object.fromEntries(
        performanceEntries.filter(
          (entry): entry is readonly [number, CompPerformanceView] => entry !== null,
        ),
      ),
    );
  }
}
