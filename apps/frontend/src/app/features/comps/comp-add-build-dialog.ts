import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BuildRole, BuildSummary, PaginatedData } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
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
import { WeaponIcon } from '../../shared/components/weapon-icon/weapon-icon';
import { ownershipListParams, type OwnershipScope } from '../../shared/data/ownership-scope';

/** What the dialog hands back when the officer confirms: one build version and how many seats. */
export interface CompBuildAddition {
  readonly build: BuildSummary;
  readonly quantity: number;
}

/**
 * The single "Add build" surface of the composition page.
 *
 * One searchable list of build versions (weapon icon, name, version, role, category and author),
 * and one footer where the chosen build and its quantity are confirmed together. The dialog stays
 * open after an addition so several builds can be added in a row; builds already in the
 * composition drop out of the list as the parent reports them through `assignedIds`.
 *
 * @example
 * ```html
 * <app-comp-add-build-dialog
 *   [assignedIds]="assignedBuildIds()"
 *   [saving]="saving()"
 *   (add)="addBuild($event)"
 *   (closed)="addOpen.set(false)"
 * />
 * ```
 */
@Component({
  selector: 'app-comp-add-build-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, ErrorState, Icon, Loading, OwnershipScopeToggle, RoleTag, WeaponIcon],
  styles: `
    .cab__filters {
      display: grid;
      gap: 0.625rem;
      margin-block-end: 0.75rem;
    }
    .cab__row2 {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
    .cab__list {
      max-height: min(46vh, 26rem);
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .cab__list li + li {
      border-top: 1px solid var(--color-border);
    }
    .cab__option {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas: 'icon name role';
      align-items: center;
      gap: 0.25rem 0.75rem;
      width: 100%;
      min-height: 3.25rem;
      padding: 0.5rem 0.75rem;
      border: 0;
      border-inline-start: 3px solid transparent;
      background: transparent;
      color: var(--color-text);
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .cab__option:hover {
      background: var(--color-surface-hover);
    }
    .cab__option:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .cab__option[aria-pressed='true'] {
      border-inline-start-color: var(--color-primary);
      background: var(--color-primary-container);
    }
    .cab__icon {
      grid-area: icon;
    }
    .cab__name {
      grid-area: name;
      min-width: 0;
    }
    .cab__title {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .cab__version {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--color-text-secondary);
    }
    .cab__meta {
      display: block;
      font-size: 0.75rem;
      line-height: 1rem;
      color: var(--color-text-secondary);
    }
    .cab__role {
      grid-area: role;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    @media (max-width: 30rem) {
      .cab__option {
        grid-template-columns: auto minmax(0, 1fr);
        grid-template-areas:
          'icon name'
          '. role';
      }
    }
    .cab__footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      width: 100%;
    }
    .cab__selected {
      flex: 1 1 12rem;
      min-width: 0;
      font-size: 0.8125rem;
      color: var(--color-text-secondary);
    }
    .cab__selected strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .cab__controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .cab__stepper {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .cab__step {
      width: 2.25rem;
      height: 2.25rem;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-text);
      font-size: 1.125rem;
      cursor: pointer;
    }
    .cab__step:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .cab__step:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: -2px;
    }
    .cab__step:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .cab__qty {
      min-width: 2rem;
      text-align: center;
      font-family: var(--font-mono);
      font-weight: 600;
    }
  `,
  template: `
    <app-dialog [title]="t('comps.addBuild')" [subtitle]="t('compDetail.add.subtitle')" size="lg" (closed)="closed.emit()">
      <div class="cab__filters" role="search">
        <label>
          <span class="sr-only">{{ t('comps.searchBuilds') }}</span>
          <input
            type="search"
            class="input"
            [placeholder]="t('comps.searchBuilds')"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </label>
        <div class="cab__row2">
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

      <div [attr.aria-busy]="loading()">
        @if (loading() && options().length === 0) {
          <div class="py-8"><app-loading [label]="t('common.loading')" /></div>
        } @else if (failed()) {
          <app-error-state
            [message]="t('compDetail.add.loadFailed')"
            [retryLabel]="t('common.retry')"
            (retry)="reload()"
          />
        } @else if (options().length === 0) {
          <app-empty-state icon="package" [message]="t('comps.noBuildsAvailable')" [hint]="t('compDetail.add.emptyHint')" />
        } @else {
          <ul class="cab__list" [attr.aria-label]="t('compDetail.add.listLabel')">
            @for (build of options(); track build.id) {
              <li>
                <button
                  type="button"
                  class="cab__option"
                  [attr.aria-pressed]="selected()?.id === build.id"
                  (click)="select(build)"
                >
                  <app-weapon-icon class="cab__icon" [weaponKey]="build.weapon_key" [fallback]="glyph(build.role)" />
                  <span class="cab__name">
                    <span class="cab__title">
                      <span>{{ build.name }}</span>
                      <span class="cab__version">v{{ build.version }}</span>
                    </span>
                    <span class="cab__meta">
                      {{ build.weapon_name || t('comps.noWeapon') }} · {{ build.category_name || t('comps.noCategory') }} ·
                      {{ build.created_by_username }}
                    </span>
                  </span>
                  <span class="cab__role">
                    <app-role-tag [role]="build.role" />
                    @if (selected()?.id === build.id) {
                      <app-icon name="check" size="1rem" />
                    }
                  </span>
                </button>
              </li>
            }
          </ul>
        }
      </div>

      <div dialogFooter class="cab__footer">
        <p class="cab__selected" role="status">
          @if (selected(); as build) {
            {{ t('compDetail.add.selected') }} <strong>{{ build.name }} v{{ build.version }}</strong>
          } @else {
            {{ t('compDetail.add.pick') }}
          }
        </p>
        <div class="cab__controls">
          <div class="cab__stepper" role="group" [attr.aria-label]="t('comps.addBuildQuantity')">
            <button
              type="button"
              class="cab__step"
              [disabled]="quantity() <= 1"
              [attr.aria-label]="t('compDetail.quantity.decrease')"
              (click)="quantity.set(quantity() - 1)"
            >
              −
            </button>
            <output class="cab__qty" aria-live="polite">{{ quantity() }}</output>
            <button
              type="button"
              class="cab__step"
              [attr.aria-label]="t('compDetail.quantity.increase')"
              (click)="quantity.set(quantity() + 1)"
            >
              +
            </button>
          </div>
          <button type="button" class="btn btn--ghost btn--sm" (click)="closed.emit()">
            {{ t('common.close') }}
          </button>
          <button
            type="button"
            class="btn btn--primary btn--sm"
            [disabled]="!selected() || saving()"
            (click)="confirm()"
          >
            <app-icon name="plus" size="0.875rem" />
            {{ t('common.add') }}
          </button>
        </div>
      </div>
    </app-dialog>
  `,
})
export class CompAddBuildDialog {
  private readonly api = inject(ApiService);
  private readonly translate = inject(TranslateService);

  /** Build ids already in the composition; they are not offered again. */
  readonly assignedIds = input<readonly number[]>([]);
  /** True while the parent is saving an addition; disables the Add button. */
  readonly saving = input(false);

  /** The officer confirmed one build version with a quantity. */
  readonly add = output<CompBuildAddition>();
  /** The dialog was dismissed (Esc, backdrop, close button). */
  readonly closed = output<void>();

  protected readonly roles = BUILD_ROLES;
  protected readonly roleKey = roleLabelKey;
  protected readonly glyph = roleGlyph;

  protected readonly search = signal('');
  protected readonly scope = signal<OwnershipScope>('mine');
  protected readonly roleFilter = signal<BuildRole | 'all'>('all');
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly quantity = signal(1);
  protected readonly selected = signal<BuildSummary | null>(null);
  private readonly results = signal<readonly BuildSummary[]>([]);

  /** Name order, newest version first within a name; builds already in the composition are left out. */
  protected readonly options = computed(() => {
    const assigned = new Set(this.assignedIds());
    return this.results()
      .filter((build) => !assigned.has(build.id))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name, this.translate.locale()) ||
          right.version - left.version,
      );
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.sequence += 1;
      if (this.timer !== null) {
        clearTimeout(this.timer);
      }
    });
    void this.load();
  }

  protected onSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.load();
    }, 250);
  }

  protected setScope(scope: OwnershipScope): void {
    if (scope === this.scope()) {
      return;
    }
    this.scope.set(scope);
    void this.load();
  }

  protected onRole(event: Event): void {
    this.roleFilter.set((event.target as HTMLSelectElement).value as BuildRole | 'all');
    void this.load();
  }

  protected select(build: BuildSummary): void {
    this.selected.set(this.selected()?.id === build.id ? null : build);
  }

  protected reload(): void {
    void this.load();
  }

  protected confirm(): void {
    const build = this.selected();
    if (!build) {
      return;
    }
    this.add.emit({ build, quantity: this.quantity() });
    this.selected.set(null);
    this.quantity.set(1);
  }

  private async load(): Promise<void> {
    const seq = ++this.sequence;
    this.loading.set(true);
    this.failed.set(false);
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
      if (seq !== this.sequence) return;
      this.results.set(response.items);
      // A search can drop the build the officer had picked; do not keep a hidden selection.
      const picked = this.selected();
      if (picked && !response.items.some((build) => build.id === picked.id)) {
        this.selected.set(null);
      }
    } catch {
      if (seq !== this.sequence) return;
      this.results.set([]);
      this.failed.set(true);
    } finally {
      if (seq === this.sequence) {
        this.loading.set(false);
      }
    }
  }
}
