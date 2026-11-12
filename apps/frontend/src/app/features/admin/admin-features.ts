import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { FeatureCatalogItem, TenantFeaturesView } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader, type PageCrumb } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

type FeatureArea = 'combat' | 'members' | 'economy' | 'platform' | 'other';

/** Display order of the feature areas; areas without features are hidden. */
const AREA_ORDER: readonly FeatureArea[] = ['combat', 'members', 'economy', 'platform', 'other'];

const AREA_LABEL_KEYS: Record<FeatureArea, TranslationKey> = {
  combat: 'admin.features.area.combat',
  members: 'admin.features.area.members',
  economy: 'admin.features.area.economy',
  platform: 'admin.features.area.platform',
  other: 'admin.features.area.other',
};

/** Area of each known catalog key. Unknown keys fall into the "other" area. */
const FEATURE_AREAS: Partial<Record<string, FeatureArea>> = {
  comps: 'combat',
  tests: 'combat',
  battles: 'combat',
  intel: 'combat',
  events: 'members',
  applications: 'members',
  warns: 'members',
  progression: 'members',
  bank: 'economy',
  splits: 'economy',
  'splits.paid': 'economy',
  regears: 'economy',
  siphoned: 'economy',
  giveaways: 'economy',
  regolamento: 'platform',
  sidebar: 'platform',
};

/** Keys the platform switches on and off; no Rank can change them. Mirrors the backend `FEATURE_SIDEBAR`. */
const PLATFORM_FEATURE_KEYS: ReadonlySet<string> = new Set(['sidebar']);

interface FeatureRow extends FeatureCatalogItem {
  /** Value stored on the server. */
  saved: boolean;
  /** Value shown, including unsaved local edits. */
  enabled: boolean;
  /** Set when the feature cannot be changed here; the reason is shown under the name. */
  lockReason: TranslationKey | null;
}

interface FeatureGroup {
  area: FeatureArea;
  rows: FeatureRow[];
}

/**
 * Tenant SuperAdmin toggles modules. Modules outside the Rank, and platform-managed modules, are
 * listed but locked with the reason.
 */
@Component({
  selector: 'app-admin-features',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Checkbox, EmptyState, ErrorState, Loading, PageHeader, PageStack],
  template: `
    <app-page-header
      [title]="t('admin.features.title')"
      [subtitle]="t('admin.features.subtitle')"
      [badge]="rankBadge()"
      [breadcrumbs]="breadcrumbs"
    />

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="lines" [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <app-error-state
          [message]="t('common.error')"
          [retryLabel]="t('common.retry')"
          (retry)="load()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state [message]="t('admin.features.empty')" />
      } @else {
        <form class="card grid gap-4" (submit)="onSave($event)">
          <fieldset class="grid gap-4" [disabled]="saving()">
            <legend class="sr-only">{{ t('admin.features.title') }}</legend>
            @for (group of groups(); track group.area) {
              <section class="grid gap-1" [attr.aria-labelledby]="'feature-area-' + group.area">
                <h2 class="section-title--sm" [id]="'feature-area-' + group.area">
                  {{ t(areaLabel(group.area)) }}
                </h2>
                @for (item of group.rows; track item.key) {
                  <app-checkbox
                    [inputId]="'tenant-flag-' + item.key"
                    [name]="item.key"
                    [label]="item.display_name"
                    [hint]="hintFor(item)"
                    [checked]="item.enabled"
                    [disabled]="item.lockReason !== null || saving()"
                    (checkedChange)="onToggle(item.key, $event)"
                  />
                }
              </section>
            }
          </fieldset>

          <div class="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p class="text-sm" role="status" aria-live="polite">
              {{ changedCount() > 0 ? t('admin.features.unsaved') : t('admin.features.noChanges') }}
            </p>
            <button
              type="submit"
              class="btn btn--primary btn--sm"
              [disabled]="saving() || loading() || changedCount() === 0"
            >
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

  protected readonly rows = computed<FeatureRow[]>(() => {
    const data = this.view();
    if (!data) {
      return [];
    }
    const allowed = new Set(data.allowed_keys ?? []);
    const saved = new Map(data.flags.map((flag) => [flag.key, flag.enabled]));
    const local = this.overrides();
    return data.catalog.map((item) => {
      const savedEnabled = saved.get(item.key) ?? false;
      return {
        ...item,
        saved: savedEnabled,
        enabled: local[item.key] ?? savedEnabled,
        lockReason: lockReasonFor(item.key, allowed.has(item.key), data.rank_id != null),
      };
    });
  });

  protected readonly groups = computed<FeatureGroup[]>(() => {
    const byArea = new Map<FeatureArea, FeatureRow[]>();
    for (const row of this.rows()) {
      const area = FEATURE_AREAS[row.key] ?? 'other';
      byArea.set(area, [...(byArea.get(area) ?? []), row]);
    }
    return AREA_ORDER.flatMap((area) => {
      const rows = byArea.get(area);
      if (!rows) {
        return [];
      }
      const sorted = [...rows].sort((a, b) => a.display_name.localeCompare(b.display_name));
      return [{ area, rows: sorted }];
    });
  });

  /** Editable rows whose value differs from the server. */
  protected readonly changedCount = computed(
    () => this.rows().filter((row) => row.lockReason === null && row.enabled !== row.saved).length,
  );

  protected readonly rankBadge = computed(
    () =>
      `${this.t('admin.features.rank')}: ${this.view()?.rank_name ?? this.t('platform.tenants.none')}`,
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly breadcrumbs: readonly PageCrumb[] = [
    { label: this.t('nav.admin'), link: '/admin' },
    { label: this.t('admin.features.title') },
  ];

  constructor() {
    void this.load();
  }

  protected areaLabel(area: FeatureArea): TranslationKey {
    return AREA_LABEL_KEYS[area];
  }

  protected hintFor(item: FeatureRow): string {
    const parts: string[] = [];
    if (item.description) {
      parts.push(item.description);
    }
    if (item.lockReason) {
      parts.push(this.t(item.lockReason));
    }
    return parts.join(' ');
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
    if (this.changedCount() === 0) {
      return;
    }
    this.saving.set(true);
    try {
      // Locked rows are not sent: the server rejects enabling a feature outside the Rank.
      const data = await firstValueFrom(
        this.api.put<TenantFeaturesView>('api/admin/features', {
          flags: this.rows()
            .filter((row) => row.lockReason === null)
            .map((row) => ({ key: row.key, enabled: row.enabled })),
        }),
      );
      this.view.set(data);
      this.overrides.set({});
      this.toasts.success(this.t('admin.features.saved'));
    } catch {
      this.toasts.error(this.t('admin.features.saveFailed'));
    } finally {
      this.saving.set(false);
    }
  }
}

function lockReasonFor(key: string, inRank: boolean, hasRank: boolean): TranslationKey | null {
  if (PLATFORM_FEATURE_KEYS.has(key)) {
    return 'admin.features.lock.platform';
  }
  if (inRank) {
    return null;
  }
  return hasRank ? 'admin.features.lock.rank' : 'admin.features.lock.noRank';
}
