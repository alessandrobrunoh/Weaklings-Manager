import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { FilterBar } from '../../shared/components/filter-bar/filter-bar';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import type { MenuItem } from '../../shared/components/menu/menu';
import { StatusChip } from '../../shared/components/status-chip/status-chip';
import { SummaryBand, type SummaryItem } from '../../shared/components/summary-band/summary-band';
import { Tabs, type TabOption } from '../../shared/components/tabs/tabs';

type StateFilter = 'all' | 'on' | 'off';

/** One catalog feature as the page shows it: the saved value, the pending value and where each comes from. */
interface FlagRow {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  /** Value stored for this tenant on the server. */
  readonly saved: boolean;
  /** Value the officer is editing (equals `saved` until they change it). */
  readonly enabled: boolean;
  /** The tenant has an explicit stored value for this flag (otherwise the default applies). */
  readonly overridden: boolean;
  /** `null` when the tenant has no rank, so the rank has no say. */
  readonly allowedByRank: boolean | null;
  readonly changed: boolean;
}

const MENU_DISCARD = 'discard';
const FORM_ID = 'platform-feature-flags-form';

/**
 * Global feature flags for one tenant on the control plane.
 *
 * The catalog is global; each row shows what the tenant's rank allows, whether the tenant has
 * an explicit override, and the toggle. Turning a feature off asks for confirmation on save.
 */
@Component({
  selector: 'app-platform-feature-flags',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Checkbox,
    Dialog,
    EmptyState,
    ErrorState,
    FilterBar,
    Loading,
    PageHeader,
    PageStack,
    StatusChip,
    SummaryBand,
    Tabs,
  ],
  template: `
    <app-page-header
      [title]="t('platform.features.title')"
      [subtitle]="t('platform.features.subtitle')"
      [badge]="tenantId"
      [backLink]="['/platform/tenants', tenantId]"
      [backLabel]="t('platform.features.backToTenant')"
      [menuItems]="menuItems()"
      [menuLabel]="t('ui.menu.moreActions')"
      (menuSelect)="onMenu($event)"
    >
      <button
        type="submit"
        class="btn btn--primary btn--sm"
        [attr.form]="formId"
        [disabled]="!canSave()"
      >
        {{ saving() ? t('common.loading') : t('common.save') }}
      </button>
    </app-page-header>

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="table" [label]="t('common.loading')" [rows]="6" [cells]="4" />
      } @else if (loadFailed()) {
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="load()" />
      } @else if (rows().length === 0) {
        <app-empty-state icon="sparkles" [message]="t('platform.features.empty')" />
      } @else {
        <app-summary-band [items]="summary()" [ariaLabel]="t('platform.features.summaryLabel')" />

        <app-filter-bar
          [searchLabel]="t('platform.features.search')"
          [searchPlaceholder]="t('platform.features.searchPlaceholder')"
          [query]="query()"
          [activeCount]="activeCount()"
          (queryChange)="query.set($event)"
          (clear)="resetFilters()"
        >
          <div filterPrimary>
            <app-tabs
              variant="segmented"
              [ariaLabel]="t('platform.features.stateFilter')"
              [options]="stateOptions()"
              [active]="stateFilter()"
              (activeChange)="onStateFilter($event)"
            />
          </div>
          <label class="filter-check">
            <input
              type="checkbox"
              name="changedOnly"
              [checked]="changedOnly()"
              (change)="onChangedOnly($event)"
            />
            <span>{{ t('platform.features.changedOnly') }}</span>
          </label>
        </app-filter-bar>

        <form [id]="formId" class="grid gap-3" (submit)="onSave($event)">
          <fieldset class="grid gap-3 min-w-0" [disabled]="saving()">
            <div class="table-scroll">
              <table class="table" [attr.aria-label]="t('platform.features.title')">
                <thead>
                  <tr>
                    <th scope="col">{{ t('platform.features.colFeature') }}</th>
                    <th scope="col">{{ t('platform.features.colRank') }}</th>
                    <th scope="col">{{ t('platform.features.colSource') }}</th>
                    <th scope="col">{{ t('platform.features.colEnabled') }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of visibleRows(); track row.key) {
                    <tr>
                      <td>
                        <span class="font-medium">{{ row.name }}</span>
                        <span class="block font-mono text-xs" style="color: var(--color-text-secondary)">{{ row.key }}</span>
                        @if (row.description) {
                          <span class="block text-xs" style="color: var(--color-text-secondary)">{{ row.description }}</span>
                        }
                      </td>
                      <td>
                        @if (row.allowedByRank === null) {
                          <app-status-chip value="no-rank" [label]="t('platform.features.noRank')" [toneOverride]="'neutral'" />
                        } @else if (row.allowedByRank) {
                          <app-status-chip value="rank-allows" [label]="t('platform.features.rankAllows')" [toneOverride]="'success'" />
                        } @else {
                          <app-status-chip value="rank-denies" [label]="t('platform.features.rankDenies')" [toneOverride]="'neutral'" />
                        }
                      </td>
                      <td>
                        <span class="flex flex-wrap gap-1">
                          <app-status-chip
                            [value]="row.overridden ? 'override' : 'default'"
                            [label]="row.overridden ? t('platform.features.sourceOverride') : t('platform.features.sourceDefault')"
                            [toneOverride]="'neutral'"
                          />
                          @if (row.changed) {
                            <app-status-chip value="unsaved" [label]="t('platform.features.unsaved')" [toneOverride]="'warning'" />
                          }
                        </span>
                      </td>
                      <td>
                        <app-checkbox
                          [inputId]="'flag-' + row.key"
                          [name]="row.key"
                          [label]="row.enabled ? t('platform.features.on') : t('platform.features.off')"
                          [checked]="row.enabled"
                          [disabled]="saving()"
                          (checkedChange)="onToggle(row.key, $event)"
                        />
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4">
                        <app-empty-state compact icon="search" [message]="t('ui.table.noMatches')" />
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </fieldset>
        </form>
      }
    </app-page-stack>

    @if (confirmOpen()) {
      <app-dialog [title]="t('platform.features.confirmTitle')" icon="alert" size="sm" (closed)="confirmOpen.set(false)">
        <div class="grid gap-3">
          <p class="text-sm">{{ t('platform.features.confirmBody') }}</p>
          <ul class="grid gap-1 text-sm list-disc pl-5">
            @for (row of turningOff(); track row.key) {
              <li>{{ row.name }} <span class="font-mono text-xs">{{ row.key }}</span></li>
            }
          </ul>
        </div>
        <div dialogFooter>
          <button type="button" class="btn btn--outline" (click)="confirmOpen.set(false)">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="btn btn--danger" [disabled]="saving()" (click)="confirmSave()">
            {{ t('platform.features.confirmAction') }}
          </button>
        </div>
      </app-dialog>
    }
  `,
})
export class PlatformFeatureFlags {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly route = inject(ActivatedRoute);

  protected readonly tenantId = this.route.snapshot.paramMap.get('tenantId') ?? '';
  protected readonly formId = FORM_ID;
  protected readonly view = signal<TenantFeaturesView | null>(null);
  /** Local edits keyed by flag key; cleared on load and after a successful save. */
  protected readonly overrides = signal<Record<string, boolean>>({});
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly confirmOpen = signal(false);

  protected readonly query = signal('');
  protected readonly stateFilter = signal<StateFilter>('all');
  protected readonly changedOnly = signal(false);

  protected readonly rows = computed<readonly FlagRow[]>(() => {
    const data = this.view();
    if (!data) {
      return [];
    }
    const stored = new Map(data.flags.map((flag) => [flag.key, flag.enabled]));
    const local = this.overrides();
    const hasRank = !!data.rank_id;
    const allowed = new Set(data.allowed_keys ?? []);
    return data.catalog.map((item) => {
      const saved = stored.get(item.key) ?? false;
      const enabled = local[item.key] ?? saved;
      return {
        key: item.key,
        name: item.display_name,
        description: item.description,
        saved,
        enabled,
        overridden: stored.has(item.key),
        allowedByRank: hasRank ? allowed.has(item.key) : null,
        changed: enabled !== saved,
      };
    });
  });

  protected readonly dirtyCount = computed(() => this.rows().filter((row) => row.changed).length);
  protected readonly turningOff = computed(() =>
    this.rows().filter((row) => row.changed && !row.enabled),
  );
  protected readonly canSave = computed(
    () => !this.loading() && !this.loadFailed() && !this.saving() && this.dirtyCount() > 0,
  );

  protected readonly visibleRows = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const state = this.stateFilter();
    const changedOnly = this.changedOnly();
    return this.rows().filter((row) => {
      if (state === 'on' && !row.enabled) return false;
      if (state === 'off' && row.enabled) return false;
      if (changedOnly && !row.changed) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.key.toLowerCase().includes(needle) ||
        (row.description ?? '').toLowerCase().includes(needle)
      );
    });
  });

  protected readonly activeCount = computed(
    () =>
      (this.query().trim() ? 1 : 0) +
      (this.stateFilter() !== 'all' ? 1 : 0) +
      (this.changedOnly() ? 1 : 0),
  );

  protected readonly summary = computed<SummaryItem[]>(() => {
    const dirty = this.dirtyCount();
    return [
      { label: this.t('platform.features.total'), value: this.rows().length },
      {
        label: this.t('platform.features.filterOn'),
        value: this.rows().filter((row) => row.enabled).length,
      },
      {
        label: this.t('platform.features.unsavedCount'),
        value: dirty,
        hint: dirty > 0 ? this.t('platform.features.unsavedHint') : this.t('platform.features.allSaved'),
        tone: dirty > 0 ? 'warning' : 'default',
      },
    ];
  });

  protected readonly stateOptions = computed<TabOption[]>(() => [
    { id: 'all', label: this.t('common.all') },
    { id: 'on', label: this.t('platform.features.filterOn') },
    { id: 'off', label: this.t('platform.features.filterOff') },
  ]);

  protected readonly menuItems = computed<MenuItem[]>(() => [
    { id: MENU_DISCARD, label: this.t('platform.features.discard'), disabled: this.dirtyCount() === 0 },
  ]);

  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  constructor() {
    void this.load();
  }

  protected onToggle(key: string, enabled: boolean): void {
    this.overrides.update((current) => ({ ...current, [key]: enabled }));
  }

  protected onChangedOnly(event: Event): void {
    this.changedOnly.set((event.target as HTMLInputElement).checked);
  }

  protected onStateFilter(id: string): void {
    this.stateFilter.set(id === 'on' || id === 'off' ? id : 'all');
  }

  protected resetFilters(): void {
    this.query.set('');
    this.stateFilter.set('all');
    this.changedOnly.set(false);
  }

  protected onMenu(id: string): void {
    if (id === MENU_DISCARD) {
      this.overrides.set({});
    }
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

  protected onSave(event: SubmitEvent): void {
    event.preventDefault();
    if (!this.canSave()) {
      return;
    }
    if (this.turningOff().length > 0) {
      this.confirmOpen.set(true);
      return;
    }
    void this.persist();
  }

  protected confirmSave(): void {
    this.confirmOpen.set(false);
    void this.persist();
  }

  private async persist(): Promise<void> {
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
    } catch {
      this.toasts.error(this.t('platform.features.saveFailed'));
    } finally {
      this.saving.set(false);
    }
  }
}
