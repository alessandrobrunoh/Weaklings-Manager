import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
  type OnInit,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  BuildRole,
  BuildSummary,
  CompDetail,
  CompSummary,
  CreateCompRequest,
  PaginatedData,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { OwnershipScopeToggle } from '../../shared/components/ownership-scope-toggle/ownership-scope-toggle';
import {
  BUILD_ROLES,
  RoleTag,
  roleGlyph,
  roleLabelKey,
} from '../../shared/components/role-tag/role-tag';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../shared/components/searchable-select/searchable-select';
import { WeaponIcon } from '../../shared/components/weapon-icon/weapon-icon';
import { ownershipListParams, type OwnershipScope } from '../../shared/data/ownership-scope';
import { COMP_PARTY_SIZE } from './comp-parties';
import {
  addToComposition,
  compositionTotals,
  MAX_COMP_NAME_LENGTH,
  overlapWithParent,
  roleMixText,
  setQuantity,
  validateCompDraft,
  versionClashes,
  type AddedBuild,
  type CompDraftError,
} from './comp-create-model';
import { LIST_FETCH_LIMIT, versionKey } from './comps-list-model';
import type { FilterCategory } from './list-filter-bar';

type StartMode = 'blank' | 'variant';

/**
 * "New composition" (and "New variant of X").
 *
 * A wide dialog with the build catalog on the left (search, role, weapon icon, version) and the
 * composition being built on the right: quantity steppers and live totals (players, parties of
 * {@link COMP_PARTY_SIZE}, players by role). "Start from" is an explicit choice between a blank
 * composition and a variant of an existing one; for a variant the parent's builds appear as
 * read-only rows and count in the totals, and the builds the officer adds go on top of them.
 *
 * A build added twice raises its quantity instead of making a second row, and a build present in
 * more than one version (or already in the parent) is flagged before submit. Nothing is validated
 * until the officer tries to create; then a summary at the bottom lists what to fix.
 */
@Component({
  selector: 'app-comp-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Dialog,
    EmptyState,
    ErrorState,
    Icon,
    Loading,
    OwnershipScopeToggle,
    RoleTag,
    SearchableSelect,
    WeaponIcon,
  ],
  styles: `
    .cc {
      display: grid;
      gap: 1rem;
    }
    .cc-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.75rem 1rem;
    }
    .cc-full {
      grid-column: 1 / -1;
    }
    .cc-start {
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .cc-start legend {
      padding: 0;
      margin-block-end: 0.375rem;
      font-size: 0.8125rem;
      font-weight: 500;
    }
    .cc-start__options {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.5rem;
    }
    .cc-choice {
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      padding: 0.625rem 0.75rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .cc-choice:has(input:checked) {
      border-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .cc-choice:has(input:focus-visible) {
      outline: 2px solid var(--color-primary);
      outline-offset: 1px;
    }
    .cc-choice input {
      margin-block-start: 0.2rem;
      accent-color: var(--color-primary);
    }
    .cc-choice strong {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .cc-choice span {
      display: block;
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .cc-parent {
      display: grid;
      gap: 0.5rem;
      margin-block-start: 0.625rem;
    }
    .cc-note {
      margin: 0;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text-secondary);
    }
    .cc-panes {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1rem;
    }
    .cc-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .cc-pane__head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--color-border);
    }
    .cc-pane__title {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text-heading);
    }
    .cc-pane__filters {
      display: grid;
      gap: 0.5rem;
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid var(--color-border);
    }
    .cc-pane__row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .cc-list {
      height: 22rem;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }
    .cc-list > li + li {
      border-top: 1px solid var(--color-border);
    }
    .cc-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.25rem 0.625rem;
      padding: 0.5rem 0.75rem;
    }
    .cc-item--inherited {
      background: var(--color-surface-2);
    }
    .cc-item__name {
      min-width: 0;
      font-size: 0.875rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .cc-item__ver {
      margin-inline-start: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .cc-item__meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.125rem 0.5rem;
      font-size: 0.75rem;
      line-height: 1.125rem;
      color: var(--color-text-secondary);
    }
    .cc-item__tail {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }
    .cc-count {
      min-width: 1.5rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      text-align: center;
    }
    .cc-stepper {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .cc-step {
      width: 2rem;
      height: 2rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text);
      font-size: 1.125rem;
      line-height: 1;
      cursor: pointer;
    }
    .cc-step:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .cc-step:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cc-step:focus-visible,
    .cc-icon-btn:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .cc-qty {
      min-width: 1.75rem;
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 600;
      text-align: center;
    }
    .cc-icon-btn {
      display: inline-grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text-secondary);
      cursor: pointer;
    }
    .cc-icon-btn:hover {
      background: var(--color-surface-hover);
      color: var(--color-error);
    }
    .cc-group {
      margin: 0;
      padding: 0.375rem 0.75rem;
      background: var(--color-surface-2);
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--color-text-secondary);
    }
    .cc-totals {
      display: grid;
      grid-template-columns: repeat(2, auto) minmax(0, 1fr);
      gap: 0.25rem 1.5rem;
      margin: 0;
      padding: 0.625rem 0.75rem;
      border-top: 1px solid var(--color-border);
      background: var(--color-surface-2);
      border-radius: 0 0 var(--radius-md) var(--radius-md);
    }
    .cc-totals dt {
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .cc-totals dd {
      margin: 0;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .cc-totals dd small {
      font-weight: 400;
      font-size: 0.75rem;
      color: var(--color-text-secondary);
    }
    .cc-warn {
      margin: 0;
      padding: 0.5rem 0.75rem 0.5rem 1.75rem;
      border-top: 1px solid var(--color-border);
      font-size: 0.8125rem;
      line-height: 1.25rem;
      color: var(--color-text);
      list-style: disc;
    }
    .cc-summary {
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-error);
      border-radius: var(--radius-md);
      background: var(--color-surface-2);
      font-size: 0.8125rem;
    }
    .cc-summary strong {
      display: block;
      margin-block-end: 0.25rem;
      font-weight: 600;
    }
    .cc-summary ul {
      margin: 0;
      padding-inline-start: 1.125rem;
    }
    .cc-field-error {
      margin: 0.25rem 0 0;
      font-size: 0.75rem;
      color: var(--color-error);
    }
    .cc-panes-toggle {
      display: none;
    }
    .cc-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      width: 100%;
    }
    .cc-foot__totals {
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .cc-foot__totals strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .cc-foot__actions {
      display: flex;
      gap: 0.625rem;
      margin-inline-start: auto;
    }
    @media (max-width: 47.9375rem) {
      .cc-grid,
      .cc-start__options {
        grid-template-columns: 1fr;
      }
      .cc-panes {
        grid-template-columns: 1fr;
      }
      .cc-panes-toggle {
        display: flex;
        gap: 0.25rem;
        padding: 0.25rem;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .cc-panes-toggle button {
        flex: 1 1 0;
        min-height: 2.25rem;
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--color-text-secondary);
        font: inherit;
        font-size: 0.8125rem;
        cursor: pointer;
      }
      .cc-panes-toggle button[aria-pressed='true'] {
        background: var(--color-primary-container);
        color: var(--color-text);
        font-weight: 600;
      }
      .cc-panes-toggle button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: -2px;
      }
      .cc-pane--hidden {
        display: none;
      }
      .cc-list {
        height: 18rem;
      }
    }
  `,
  template: `
    <app-dialog [title]="title()" [subtitle]="t('compCreate.subtitle')" size="xl" (closed)="closed.emit()">
      <form id="comp-create-form" class="cc" novalidate (submit)="onSubmit($event)">
        <div class="cc-grid">
          <label>
            <span class="label">{{ t('common.name') }}</span>
            <input
              class="input"
              type="text"
              autocomplete="off"
              required
              [value]="name()"
              [attr.aria-invalid]="errorFor('name') ? 'true' : null"
              [attr.aria-describedby]="errorFor('name') ? 'cc-name-error' : null"
              (input)="name.set($any($event.target).value)"
            />
            @if (errorFor('name'); as error) {
              <p id="cc-name-error" class="cc-field-error">{{ message(error) }}</p>
            }
          </label>
          <label>
            <span class="label">{{ t('common.category') }}</span>
            <select
              class="select"
              required
              [value]="categoryId()"
              [attr.aria-invalid]="errorFor('category') ? 'true' : null"
              [attr.aria-describedby]="errorFor('category') ? 'cc-category-error' : null"
              (change)="categoryId.set($any($event.target).value)"
            >
              <option value="">{{ t('comps.selectCategory') }}</option>
              @for (category of categories(); track category.id) {
                <option [value]="category.id">{{ category.name }}</option>
              }
            </select>
            @if (errorFor('category'); as error) {
              <p id="cc-category-error" class="cc-field-error">{{ message(error) }}</p>
            }
          </label>
          <label class="cc-full">
            <span class="label">{{ t('common.description') }}</span>
            <textarea
              class="textarea"
              rows="2"
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
          </label>
        </div>

        <fieldset class="cc-start">
          <legend>{{ t('compCreate.startFrom.legend') }}</legend>
          <div class="cc-start__options">
            <label class="cc-choice">
              <input
                type="radio"
                name="cc-start"
                value="blank"
                [checked]="mode() === 'blank'"
                (change)="setMode('blank')"
              />
              <span>
                <strong>{{ t('compCreate.startFrom.blank') }}</strong>
                <span>{{ t('compCreate.startFrom.blankHint') }}</span>
              </span>
            </label>
            <label class="cc-choice">
              <input
                type="radio"
                name="cc-start"
                value="variant"
                [checked]="mode() === 'variant'"
                (change)="setMode('variant')"
              />
              <span>
                <strong>{{ t('compCreate.startFrom.variant') }}</strong>
                <span>{{ t('compCreate.startFrom.variantHint') }}</span>
              </span>
            </label>
          </div>
          @if (mode() === 'variant') {
            <div class="cc-parent">
              <span class="label">{{ t('compCreate.startFrom.parent') }}</span>
              <app-searchable-select
                [options]="parentOptions()"
                [value]="parentId()"
                [allowEmpty]="false"
                [loading]="optionsLoading()"
                [ariaLabel]="t('compCreate.startFrom.parent')"
                [searchPlaceholder]="t('common.search')"
                [emptyOptionsLabel]="t('compCreate.startFrom.noParents')"
                (valueChange)="setParent($event)"
              />
              @if (errorFor('parent'); as error) {
                <p class="cc-field-error">{{ message(error) }}</p>
              }
              @if (parentLoadFailed()) {
                <p class="cc-field-error">{{ t('compCreate.startFrom.loadFailed') }}</p>
              }
            </div>
          }
        </fieldset>

        <div class="cc-panes-toggle" role="group" [attr.aria-label]="t('compCreate.pane.label')">
          <button type="button" [attr.aria-pressed]="pane() === 'catalog'" (click)="pane.set('catalog')">
            {{ t('compCreate.pane.catalog') }}
          </button>
          <button type="button" [attr.aria-pressed]="pane() === 'composition'" (click)="pane.set('composition')">
            {{ t('compCreate.pane.composition', { count: totals().players }) }}
          </button>
        </div>

        <div class="cc-panes">
          <!-- Catalog -->
          <section class="cc-pane" [class.cc-pane--hidden]="pane() !== 'catalog'" [attr.aria-labelledby]="'cc-catalog-title'">
            <div class="cc-pane__head">
              <h3 id="cc-catalog-title" class="cc-pane__title">{{ t('compCreate.catalog.title') }}</h3>
            </div>
            <div class="cc-pane__filters" role="search">
              <label>
                <span class="sr-only">{{ t('comps.searchBuilds') }}</span>
                <input
                  type="search"
                  class="input"
                  autocomplete="off"
                  [placeholder]="t('comps.searchBuilds')"
                  [value]="search()"
                  (input)="onSearch($event)"
                />
              </label>
              <div class="cc-pane__row">
                <app-ownership-scope-toggle [scope]="scope()" (scopeChange)="setScope($event)" />
                <label class="flex items-center gap-2 text-sm">
                  <span class="text-secondary">{{ t('common.role') }}</span>
                  <select class="select select--sm" [value]="roleFilter()" (change)="onRole($event)">
                    <option value="all">{{ t('compDetail.add.allRoles') }}</option>
                    @for (role of roles; track role) {
                      <option [value]="role">{{ t(roleKey(role)) }}</option>
                    }
                  </select>
                </label>
              </div>
            </div>
            <div [attr.aria-busy]="catalogLoading()">
              @if (catalogLoading() && catalog().length === 0) {
                <div class="py-8"><app-loading [label]="t('common.loading')" /></div>
              } @else if (catalogFailed()) {
                <app-error-state
                  [message]="t('compDetail.add.loadFailed')"
                  [retryLabel]="t('common.retry')"
                  (retry)="loadCatalog()"
                />
              } @else if (catalog().length === 0) {
                <app-empty-state
                  icon="package"
                  [message]="t('comps.noBuildsAvailable')"
                  [hint]="t('compDetail.add.emptyHint')"
                />
              } @else {
                <ul class="cc-list" [attr.aria-label]="t('compDetail.add.listLabel')">
                  @for (entry of catalog(); track entry.build.id) {
                    @let b = entry.build;
                    <li class="cc-item">
                      <app-weapon-icon size="sm" [weaponKey]="b.weapon_key" [fallback]="glyph(b.role)" />
                      <div style="min-width: 0">
                        <span class="cc-item__name">{{ b.name }}</span>
                        <span class="cc-item__ver">
                          v{{ b.version }}@if (entry.latest) { · {{ t('compsList.versions.latest') }} }
                        </span>
                        <div class="cc-item__meta">
                          <app-role-tag [role]="b.role" />
                          <span>{{ b.category_name || t('comps.noCategory') }} · {{ b.created_by_username }}</span>
                        </div>
                      </div>
                      <span class="cc-item__tail">
                        @if (quantityOf(b.id); as qty) {
                          <span class="cc-count" [attr.title]="t('compCreate.catalog.inComposition', { count: qty })">
                            ×{{ qty }}
                          </span>
                        }
                        <button
                          type="button"
                          class="btn btn--outline btn--sm"
                          [attr.aria-label]="t('compCreate.catalog.addNamed', { name: b.name, version: b.version })"
                          (click)="add(b)"
                        >
                          <app-icon name="plus" size="0.875rem" />
                          {{ t('common.add') }}
                        </button>
                      </span>
                    </li>
                  }
                </ul>
              }
            </div>
          </section>

          <!-- Composition -->
          <section class="cc-pane" [class.cc-pane--hidden]="pane() !== 'composition'" [attr.aria-labelledby]="'cc-comp-title'">
            <div class="cc-pane__head">
              <h3 id="cc-comp-title" class="cc-pane__title">{{ t('compCreate.comp.title') }}</h3>
              @if (errorFor('builds'); as error) {
                <span class="cc-field-error" style="margin: 0">{{ message(error) }}</span>
              }
            </div>
            @if (inherited().length === 0 && added().length === 0) {
              <div class="cc-list">
                <app-empty-state
                  icon="users"
                  [message]="t('compCreate.comp.empty')"
                  [hint]="t('compDetail.empty.hint')"
                />
              </div>
            } @else {
              <ul class="cc-list" [attr.aria-label]="t('compCreate.comp.title')">
                @if (inherited().length > 0) {
                  <li><p class="cc-group">{{ t('compCreate.comp.inherited', { name: parentName() }) }}</p></li>
                  @for (entry of inherited(); track entry.build_id) {
                    @let b = entry.build;
                    <li class="cc-item cc-item--inherited">
                      <app-weapon-icon size="sm" [weaponKey]="b.weapon_key" [fallback]="glyph(b.role)" />
                      <div style="min-width: 0">
                        <span class="cc-item__name">{{ b.name }}</span>
                        <span class="cc-item__ver">v{{ b.version }}</span>
                        <div class="cc-item__meta"><app-role-tag [role]="b.role" /></div>
                      </div>
                      <span class="cc-count">×{{ entry.quantity }}</span>
                    </li>
                  }
                }
                @if (added().length > 0) {
                  @if (inherited().length > 0) {
                    <li><p class="cc-group">{{ t('compCreate.comp.additions') }}</p></li>
                  }
                  @for (entry of added(); track entry.build.id) {
                    @let b = entry.build;
                    <li class="cc-item">
                      <app-weapon-icon size="sm" [weaponKey]="b.weapon_key" [fallback]="glyph(b.role)" />
                      <div style="min-width: 0">
                        <span class="cc-item__name">{{ b.name }}</span>
                        <span class="cc-item__ver">v{{ b.version }}</span>
                        <div class="cc-item__meta"><app-role-tag [role]="b.role" /></div>
                      </div>
                      <span class="cc-item__tail">
                        <span class="cc-stepper" role="group" [attr.aria-label]="t('compDetail.quantity.of', { name: b.name })">
                          <button
                            type="button"
                            class="cc-step"
                            [disabled]="entry.quantity <= 1"
                            [attr.aria-label]="t('compDetail.quantity.decreaseNamed', { name: b.name })"
                            (click)="changeQuantity(b.id, entry.quantity - 1)"
                          >
                            −
                          </button>
                          <output class="cc-qty">{{ entry.quantity }}</output>
                          <button
                            type="button"
                            class="cc-step"
                            [attr.aria-label]="t('compDetail.quantity.increaseNamed', { name: b.name })"
                            (click)="changeQuantity(b.id, entry.quantity + 1)"
                          >
                            +
                          </button>
                        </span>
                        <button
                          type="button"
                          class="cc-icon-btn"
                          [attr.aria-label]="t('compDetail.remove', { name: b.name })"
                          (click)="changeQuantity(b.id, 0)"
                        >
                          <app-icon name="close" size="0.875rem" />
                        </button>
                      </span>
                    </li>
                  }
                }
              </ul>
            }
            @if (warnings().length > 0) {
              <ul class="cc-warn" [attr.aria-label]="t('compCreate.warn.label')">
                @for (warning of warnings(); track warning) {
                  <li>{{ warning }}</li>
                }
              </ul>
            }
            <dl class="cc-totals">
              <div>
                <dt>{{ t('compDetail.stat.players') }}</dt>
                <dd>
                  {{ totals().players }}
                  @if (totals().inheritedPlayers > 0) {
                    <small>({{ t('compCreate.totals.fromParent', { count: totals().inheritedPlayers }) }})</small>
                  }
                </dd>
              </div>
              <div>
                <dt>{{ t('compCreate.totals.parties', { size: partySize }) }}</dt>
                <dd>
                  {{ totals().parties }}
                  @if (totals().partialParty > 0) {
                    <small>({{ t('compCreate.totals.lastParty', { count: totals().partialParty, size: partySize }) }})</small>
                  }
                </dd>
              </div>
              <div>
                <dt>{{ t('compDetail.roleBreakdown') }}</dt>
                <dd>{{ mixText() }}</dd>
              </div>
            </dl>
          </section>
        </div>

        <p class="sr-only" role="status" aria-live="polite">{{ announcement() }}</p>

        @if (submitted() && errors().length > 0) {
          <div class="cc-summary" role="alert" tabindex="-1">
            <strong>{{ t('compCreate.summary.title') }}</strong>
            <ul>
              @for (error of errors(); track error.field) {
                <li>{{ message(error) }}</li>
              }
            </ul>
          </div>
        }
      </form>

      <div dialogFooter class="cc-foot">
        <span class="cc-foot__totals" aria-hidden="true">
          <strong>{{ totals().players }}</strong> {{ t('compDetail.stat.players').toLowerCase() }}
          · <strong>{{ totals().parties }}</strong> {{ t('compDetail.stat.parties').toLowerCase() }}
        </span>
        <span class="cc-foot__actions">
          <button type="button" class="btn btn--ghost" (click)="closed.emit()">
            {{ t('common.cancel') }}
          </button>
          <button type="submit" class="btn btn--primary" form="comp-create-form" [disabled]="saving()">
            {{ t('comps.createComp') }}
          </button>
        </span>
      </div>
    </app-dialog>
  `,
})
export class CompCreateDialog implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  /** Composition categories to file the new composition under. */
  readonly categories = input.required<readonly FilterCategory[]>();
  /** Opens the dialog as "a variant of this composition", with the parent already chosen. */
  readonly parent = input<CompSummary | null>(null);

  /** The composition was created. */
  readonly created = output<CompDetail>();
  readonly closed = output<void>();

  protected readonly roles = BUILD_ROLES;
  protected readonly roleKey = roleLabelKey;
  protected readonly glyph = roleGlyph;
  protected readonly partySize = COMP_PARTY_SIZE;

  protected readonly name = signal('');
  protected readonly categoryId = signal('');
  protected readonly description = signal('');
  protected readonly mode = signal<StartMode>('blank');
  protected readonly parentId = signal('');
  protected readonly parentDetail = signal<CompDetail | null>(null);
  protected readonly parentLoadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly submitted = signal(false);
  protected readonly pane = signal<'catalog' | 'composition'>('catalog');
  protected readonly announcement = signal('');

  // ---- catalog
  protected readonly search = signal('');
  protected readonly scope = signal<OwnershipScope>('mine');
  protected readonly roleFilter = signal<BuildRole | 'all'>('all');
  protected readonly catalogLoading = signal(false);
  protected readonly catalogFailed = signal(false);
  private readonly catalogRows = signal<readonly BuildSummary[]>([]);

  // ---- composition
  protected readonly added = signal<readonly AddedBuild[]>([]);
  private readonly allComps = signal<readonly CompSummary[]>([]);
  protected readonly optionsLoading = signal(false);

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogSeq = 0;
  private parentSeq = 0;

  protected readonly title = computed(() => {
    const parent = this.parent();
    return parent
      ? this.t('compCreate.titleVariant', { name: parent.name })
      : this.t('compCreate.title');
  });

  /** Catalog rows: name order, newest version first within a name, the newest flagged "latest". */
  protected readonly catalog = computed(() => {
    const locale = this.translate.locale();
    const sorted = [...this.catalogRows()].sort(
      (left, right) =>
        left.name.localeCompare(right.name, locale) ||
        left.category_id - right.category_id ||
        right.version - left.version,
    );
    const sizes = new Map<string, number>();
    for (const build of sorted) {
      sizes.set(versionKey(build), (sizes.get(versionKey(build)) ?? 0) + 1);
    }
    return sorted.map((build, index) => ({
      build,
      // Only a build with several versions needs its newest one pointed out.
      latest:
        (index === 0 || versionKey(sorted[index - 1]) !== versionKey(build)) &&
        (sizes.get(versionKey(build)) ?? 0) > 1,
    }));
  });

  protected readonly parentOptions = computed<SearchableSelectOption[]>(() =>
    [...this.allComps()]
      .sort((left, right) => left.name.localeCompare(right.name, this.translate.locale()) || right.version - left.version)
      .map((comp) => ({
        id: String(comp.id),
        label: `${comp.name} v${comp.version}`,
        hint: `${comp.category_name ?? this.t('comps.noCategory')} · ${comp.created_by_username}`,
      })),
  );

  protected readonly inherited = computed(() =>
    this.mode() === 'variant' ? (this.parentDetail()?.builds ?? []) : [],
  );
  protected readonly parentName = computed(() => this.parentDetail()?.name ?? '');
  protected readonly totals = computed(() => compositionTotals(this.inherited(), this.added()));

  protected readonly mixText = computed(() => {
    const mix = this.totals().mix;
    return mix.length === 0
      ? '—'
      : roleMixText(mix, (role) => this.t(roleLabelKey(role)));
  });

  protected readonly warnings = computed<string[]>(() => {
    const all = [...this.inherited(), ...this.added().map((entry) => ({ build: entry.build }))];
    const out = versionClashes(all).map((clash) =>
      this.t('compCreate.warn.versions', {
        name: clash.name,
        versions: clash.versions.map((version) => `v${version}`).join(', '),
      }),
    );
    for (const entry of overlapWithParent(this.added(), this.inherited())) {
      out.push(this.t('compCreate.warn.inParent', { name: entry.build.name, parent: this.parentName() }));
    }
    return out;
  });

  protected readonly errors = computed<CompDraftError[]>(() => {
    const categoryId = Number(this.categoryId());
    const parentId = Number(this.parentId());
    return validateCompDraft(
      {
        name: this.name(),
        categoryId: categoryId > 0 ? categoryId : null,
        variant: this.mode() === 'variant',
        parentId: parentId > 0 ? parentId : null,
        buildCount: this.added().length,
      },
      this.allComps().map((comp) => comp.name),
    );
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.catalogSeq += 1;
      this.parentSeq += 1;
      if (this.searchTimer !== null) {
        clearTimeout(this.searchTimer);
      }
    });
    void this.loadCatalog();
    void this.loadComps();
  }

  /** Applies the `parent` input once, when the dialog is created for "New variant". */
  ngOnInit(): void {
    const parent = this.parent();
    if (parent) {
      this.mode.set('variant');
      this.categoryId.set(String(parent.category_id));
      this.setParent(String(parent.id));
    }
  }

  protected errorFor(field: CompDraftError['field']): CompDraftError | null {
    return this.submitted() ? (this.errors().find((error) => error.field === field) ?? null) : null;
  }

  protected message(error: CompDraftError): string {
    switch (error.field) {
      case 'name':
        return error.code === 'tooLong'
          ? this.t('compDetail.validation.nameLong', { max: MAX_COMP_NAME_LENGTH })
          : error.code === 'taken'
            ? this.t('compDetail.validation.nameTaken')
            : this.t('compCreate.err.name');
      case 'category':
        return this.t('compCreate.err.category');
      case 'parent':
        return this.t('compCreate.err.parent');
      case 'builds':
        return this.t('compCreate.err.builds');
    }
  }

  protected quantityOf(buildId: number): number {
    return this.added().find((entry) => entry.build.id === buildId)?.quantity ?? 0;
  }

  protected add(build: BuildSummary): void {
    this.added.update((list) => addToComposition(list, build));
    this.announcement.set(
      this.t('compCreate.announce.added', { name: build.name, count: this.quantityOf(build.id) }),
    );
  }

  protected changeQuantity(buildId: number, quantity: number): void {
    const name = this.added().find((entry) => entry.build.id === buildId)?.build.name ?? '';
    this.added.update((list) => setQuantity(list, buildId, quantity));
    this.announcement.set(
      quantity <= 0
        ? this.t('compCreate.announce.removed', { name })
        : this.t('compCreate.announce.added', { name, count: quantity }),
    );
  }

  protected setMode(mode: StartMode): void {
    this.mode.set(mode);
    if (mode === 'blank') {
      this.parentId.set('');
      this.parentDetail.set(null);
      this.parentLoadFailed.set(false);
    }
  }

  protected setParent(id: string): void {
    this.parentId.set(id);
    this.parentDetail.set(null);
    this.parentLoadFailed.set(false);
    const comp = this.allComps().find((candidate) => String(candidate.id) === id);
    if (comp && !this.categoryId()) {
      this.categoryId.set(String(comp.category_id));
    }
    if (id) {
      void this.loadParent(Number(id));
    }
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.loadCatalog();
    }, 250);
  }

  protected setScope(scope: OwnershipScope): void {
    if (scope === this.scope()) {
      return;
    }
    this.scope.set(scope);
    void this.loadCatalog();
  }

  protected onRole(event: Event): void {
    this.roleFilter.set((event.target as HTMLSelectElement).value as BuildRole | 'all');
    void this.loadCatalog();
  }

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    this.submitted.set(true);
    if (this.errors().length > 0) {
      return;
    }
    void this.create();
  }

  protected async loadCatalog(): Promise<void> {
    const seq = ++this.catalogSeq;
    this.catalogLoading.set(true);
    this.catalogFailed.set(false);
    try {
      const query = this.search().trim();
      const role = this.roleFilter();
      const response = await firstValueFrom(
        this.api.get<PaginatedData<BuildSummary>>('api/comps/builds', {
          page: 1,
          limit: 200,
          sort: 'name',
          order: 'asc',
          q: query || undefined,
          role: role === 'all' ? undefined : role,
          ...ownershipListParams(this.scope()),
        }),
      );
      if (seq === this.catalogSeq) {
        this.catalogRows.set(response.items);
      }
    } catch {
      if (seq === this.catalogSeq) {
        this.catalogRows.set([]);
        this.catalogFailed.set(true);
      }
    } finally {
      if (seq === this.catalogSeq) {
        this.catalogLoading.set(false);
      }
    }
  }

  /** Every composition: the parent choices, and the names a new one must not collide with. */
  private async loadComps(): Promise<void> {
    this.optionsLoading.set(true);
    try {
      const response = await firstValueFrom(
        this.api.get<PaginatedData<CompSummary>>('api/comps', {
          page: 1,
          limit: LIST_FETCH_LIMIT,
          sort: 'name',
          order: 'asc',
        }),
      );
      this.allComps.set(response.items);
    } catch {
      this.allComps.set([]);
    } finally {
      this.optionsLoading.set(false);
    }
  }

  private async loadParent(id: number): Promise<void> {
    const seq = ++this.parentSeq;
    try {
      const detail = await firstValueFrom(this.api.get<CompDetail>(`api/comps/${id}`));
      if (seq === this.parentSeq) {
        this.parentDetail.set(detail);
      }
    } catch {
      if (seq === this.parentSeq) {
        this.parentLoadFailed.set(true);
      }
    }
  }

  private async create(): Promise<void> {
    const request: CreateCompRequest = {
      name: this.name().trim(),
      category_id: Number(this.categoryId()),
      builds: this.added().map((entry) => ({ build_id: entry.build.id, quantity: entry.quantity })),
    };
    const description = this.description().trim();
    if (description) {
      request.description = description;
    }
    if (this.mode() === 'variant') {
      request.parent_id = Number(this.parentId());
    }
    this.saving.set(true);
    try {
      const created = await firstValueFrom(this.api.post<CompDetail>('api/comps', request));
      this.toasts.success(this.t('compCreate.created'));
      this.created.emit(created);
    } catch {
      this.toasts.error(this.t('compDetail.error.save'));
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
