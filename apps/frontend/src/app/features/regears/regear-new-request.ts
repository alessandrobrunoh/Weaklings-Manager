import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  BuildDetail,
  BuildItemSlot,
  BuildSlot,
  CreateSelfServiceRegearRequest,
  OpenAlbionItem,
  RegearBudgetSummary,
  RegearDeathView,
  RegearItemOverride,
  SelfServiceEventOption,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import {
  albionItemSupportsEnchantment,
  albionItemSupportsQuality,
  filterAlbionEquipmentCatalog,
} from '../../shared/data/albion-equipment-catalog';
import {
  DEFAULT_ALBION_ITEM_ENCHANTMENT,
  normalizeAlbionItemEnchantment,
} from '../../shared/data/albion-item-enchantment';
import {
  DEFAULT_ALBION_ITEM_QUALITY,
  normalizeAlbionItemQuality,
} from '../../shared/data/albion-item-quality';
import { AlbionCatalogService } from '../../shared/services/albion-catalog.service';
import { Dialog } from '../../shared/components/dialog/dialog';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { EquipmentGrid } from '../../shared/components/equipment-grid/equipment-grid';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { type SummaryItem, SummaryBand } from '../../shared/components/summary-band/summary-band';

const ITEM_TIERS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

/**
 * A local-only override, kept richer than the wire `RegearItemOverride` shape so the grid can
 * render the replacement item's name/icon before submit — the API only needs id/quality/
 * enchantment, since it resolves display data itself from `openalbion_item_id`.
 */
interface DraftOverride extends RegearItemOverride {
  openalbion_item_name: string;
  openalbion_item_type: string;
  openalbion_item_icon: string | null;
}

const SLOT_ORDER: readonly BuildSlot[] = [
  'weapon',
  'off_hand',
  'head',
  'armor',
  'shoes',
  'cape',
  'bag',
  'potion',
  'food',
  'mount',
];

/**
 * Self-service regear request, as four numbered steps on one page:
 *
 * 1. the event the member took part in (radio group, the first event preselected),
 * 2. the build (radio group, the sign-up build preselected; a single build is shown as text),
 * 3. item overrides for the slots that differ from the build (optional),
 * 4. review: what will be requested and what is left in the request budget, then submit.
 *
 * Submitting lands directly in the officer queue like an extracted death, consuming one request
 * credit (bonus pool first). Confirmation happens in a dialog because the action cannot be undone.
 */
@Component({
  selector: 'app-regear-new-request',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, EquipmentGrid, ErrorState, Loading, PageHeader, PageStack, SummaryBand],
  styles: `
    .workbench-page {
      min-width: 0;
    }
    .request-flow {
      display: grid;
      gap: 1.5rem;
      min-width: 0;
    }
    .step {
      display: grid;
      gap: 0.625rem;
      min-width: 0;
    }
    .step__head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .step__num {
      display: inline-grid;
      flex-shrink: 0;
      place-items: center;
      width: 1.5rem;
      height: 1.5rem;
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-full);
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .option-group {
      display: grid;
      gap: 0.5rem;
      grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .option-card {
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      min-width: 0;
      padding: 0.75rem 0.875rem;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-cards);
      background: var(--color-surface);
      cursor: pointer;
      transition:
        border-color var(--motion-fast),
        background-color var(--motion-fast);
    }
    .option-card:hover {
      border-color: var(--color-border-strong);
    }
    .option-card:has(.option-card__radio:checked) {
      border-color: var(--color-primary);
      background: var(--color-primary-subtle);
    }
    .option-card:has(.option-card__radio:focus-visible) {
      outline: var(--focus-ring);
      outline-offset: 2px;
    }
    .option-card__radio {
      flex-shrink: 0;
      width: 1.125rem;
      height: 1.125rem;
      margin: 0.125rem 0 0;
      accent-color: var(--color-primary);
      cursor: pointer;
    }
    .option-card__text {
      display: grid;
      gap: 0.125rem;
      min-width: 0;
    }
    .option-card__title {
      overflow-wrap: anywhere;
      font-size: var(--ui-text-md);
      font-weight: 600;
      color: var(--color-text);
    }
    .option-card__meta {
      font-size: var(--ui-text-xs);
      color: var(--color-text-secondary);
    }
    .review-list {
      display: grid;
      grid-template-columns: minmax(7rem, max-content) minmax(0, 1fr);
      gap: 0.375rem 1rem;
      margin: 0;
      font-size: var(--ui-text-sm);
    }
    .review-list dt {
      color: var(--color-text-secondary);
    }
    .review-list dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      font-weight: 500;
      color: var(--color-text);
    }
    .field-error {
      margin: 0;
      font-size: var(--ui-text-sm);
      color: var(--color-error);
    }
    .step__actions {
      display: flex;
      justify-content: flex-end;
    }
    .step__actions .btn {
      width: 100%;
    }
    @media (min-width: 40rem) {
      .step__actions .btn {
        width: auto;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .option-card {
        transition: none;
      }
    }
  `,
  template: `
    <app-page-header
      [title]="t('regears.newRequest')"
      [subtitle]="t('regears.newRequest.subtitle')"
      [backLink]="['/regears']"
    />

    <app-page-stack class="workbench-page">
      @if (loading()) {
        <app-loading variant="detail" [label]="t('common.loading')" />
      } @else if (loadFailed()) {
        <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="retryLoad()" />
      } @else if (events().length === 0) {
        <app-empty-state icon="shield" [message]="t('regears.newRequest.noEvents')" />
      } @else {
        <p class="hint">{{ t('validation.requiredLegend') }}</p>

        <div class="request-flow">
          <!-- Step 1: event -->
          <section class="step" aria-labelledby="regear-step-event">
            <div class="step__head">
              <span class="step__num" aria-hidden="true">1</span>
              <h2 id="regear-step-event" class="section-title section-title--sm">{{ t('regears.newRequest.step.event') }}</h2>
            </div>
            <p class="hint">{{ t('regears.newRequest.step.eventHint') }}</p>
            <fieldset class="option-group">
              <legend class="sr-only">{{ t('regears.newRequest.step.event') }}</legend>
              @for (event of events(); track event.event_id) {
                <label class="option-card">
                  <input
                    type="radio"
                    name="regear-event"
                    class="option-card__radio"
                    [checked]="event.event_id === selectedEventId()"
                    (change)="selectEvent(event.event_id)"
                  />
                  <span class="option-card__text">
                    <span class="option-card__title">{{ event.event_title }}</span>
                    @if (event.primary_build_name) {
                      <span class="option-card__meta">{{ event.primary_build_name }}</span>
                    }
                  </span>
                </label>
              }
            </fieldset>
          </section>

          @if (selectedEvent(); as event) {
            <!-- Step 2: build -->
            <section class="step" aria-labelledby="regear-step-build">
              <div class="step__head">
                <span class="step__num" aria-hidden="true">2</span>
                <h2 id="regear-step-build" class="section-title section-title--sm">{{ t('regears.newRequest.step.build') }}</h2>
              </div>
              @if (event.comp_builds.length > 1) {
                <p class="hint">{{ t('regears.newRequest.step.buildHint') }}</p>
                <fieldset class="option-group">
                  <legend class="sr-only">{{ t('regears.newRequest.step.build') }}</legend>
                  @for (option of event.comp_builds; track option.build_id) {
                    <label class="option-card">
                      <input
                        type="radio"
                        name="regear-build"
                        class="option-card__radio"
                        [checked]="option.build_id === selectedBuildId()"
                        (change)="selectBuild(option.build_id)"
                      />
                      <span class="option-card__text">
                        <span class="option-card__title">{{ option.build_name }}</span>
                        @if (option.quantity > 1) {
                          <span class="option-card__meta">×{{ option.quantity }}</span>
                        }
                      </span>
                    </label>
                  }
                </fieldset>
              } @else if (selectedBuildName(); as name) {
                <p class="hint">{{ t('regears.newRequest.step.buildSingle', { name: name }) }}</p>
              } @else {
                <p class="field-error" role="alert">{{ t('regears.newRequest.error.noBuild') }}</p>
              }

              @if (buildLoading()) {
                <app-loading variant="detail" [label]="t('common.loading')" />
              } @else if (buildError()) {
                <app-error-state [message]="t('common.error')" [retryLabel]="t('common.retry')" (retry)="retryBuild()" />
              }
            </section>

            @if (buildDetail(); as build) {
              <!-- Step 3: item overrides -->
              <section class="step" aria-labelledby="regear-step-overrides">
                <div class="step__head">
                  <span class="step__num" aria-hidden="true">3</span>
                  <h2 id="regear-step-overrides" class="section-title section-title--sm">{{ t('regears.newRequest.step.overrides') }}</h2>
                </div>
                <p class="hint">{{ t('regears.newRequest.step.overridesHint') }}</p>
                <p class="hint" aria-live="polite">
                  @if (overrideCount() > 0) {
                    {{ t('regears.newRequest.overrides.count', { count: overrideCount() }) }}
                  } @else {
                    {{ t('regears.newRequest.review.noOverrides') }}
                  }
                </p>
                <div class="table-scroll">
                  <app-equipment-grid
                    [items]="gridItems()"
                    [canManage]="true"
                    [editingSlot]="editingSlot()"
                    [draftTier]="draftTier()"
                    [draftQuality]="draftQuality()"
                    [draftEnchantment]="draftEnchantment()"
                    [draftSearch]="draftSearch()"
                    [draftItemId]="draftItemId()"
                    [searchResults]="searchResults()"
                    [searchLoading]="searchLoading()"
                    [tiers]="ITEM_TIERS"
                    (slotToggle)="onSlotToggle($event)"
                    (tierChange)="onDraftTierChange($event)"
                    (qualityChange)="onDraftQualityChange($event)"
                    (enchantmentChange)="onDraftEnchantmentChange($event)"
                    (searchChange)="onDraftSearchChange($event)"
                    (itemSelect)="onDraftItemChange($event)"
                    (saveSlot)="saveSlot($event)"
                    (cancelEdit)="cancelSlotEdit()"
                    (removeItem)="removeOverride($event)"
                  />
                </div>
              </section>

              <!-- Step 4: review and submit -->
              <section class="step" aria-labelledby="regear-step-review">
                <div class="step__head">
                  <span class="step__num" aria-hidden="true">4</span>
                  <h2 id="regear-step-review" class="section-title section-title--sm">{{ t('regears.newRequest.step.review') }}</h2>
                </div>
                <p class="hint">{{ t('regears.newRequest.step.reviewHint') }}</p>
                <dl class="review-list">
                  <dt>{{ t('regears.newRequest.review.event') }}</dt>
                  <dd>{{ event.event_title }}</dd>
                  <dt>{{ t('regears.newRequest.review.build') }}</dt>
                  <dd>{{ selectedBuildName() ?? build.name }}</dd>
                  <dt>{{ t('regears.newRequest.review.overrides') }}</dt>
                  <dd>
                    {{ overrideCount() > 0 ? t('regears.newRequest.overrides.count', { count: overrideCount() }) : t('regears.newRequest.review.noOverrides') }}
                  </dd>
                </dl>
                <app-summary-band [ariaLabel]="t('regears.newRequest.review.summary')" [items]="reviewItems()" />
                @if (noRequestsLeft()) {
                  <p class="field-error" role="alert">{{ t('regears.newRequest.review.noneLeft') }}</p>
                }
                <div class="step__actions">
                  <button type="button" class="btn btn--primary" [disabled]="!canSubmit() || submitting()" (click)="openConfirm()">
                    {{ t('regears.newRequest.submit') }}
                  </button>
                </div>
              </section>
            }
          }
        </div>
      }
    </app-page-stack>

    <app-dialog
      [open]="confirmOpen()"
      [title]="t('regears.newRequest.confirmTitle')"
      icon="alert"
      (closed)="confirmOpen.set(false)"
    >
      <p class="text-sm text-(--color-text)">{{ t('regears.newRequest.confirmSubmit') }}</p>
      @if (summary(); as summary) {
        <p class="text-xs text-[var(--color-text-secondary)] mt-2">
          {{ t('regears.budget.weekly') }}: {{ summary.weekly_balance }} / {{ summary.weekly_cap }}
          &middot;
          {{ t('regears.budget.bonus') }}: {{ summary.bonus_balance }} / {{ summary.bonus_cap }}
        </p>
      }
      <div dialogFooter class="flex justify-end gap-2">
        <button type="button" class="btn btn--outline btn--sm" (click)="confirmOpen.set(false)">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="btn btn--primary btn--sm"
          [disabled]="submitting()"
          (click)="submit()"
        >
          {{ t('regears.newRequest.confirmSubmit') }}
        </button>
      </div>
    </app-dialog>
  `,
})
export class RegearNewRequest {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly albionCatalog = inject(AlbionCatalogService);

  protected readonly ITEM_TIERS = ITEM_TIERS;
  protected t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly events = signal<SelfServiceEventOption[]>([]);
  protected readonly summary = signal<RegearBudgetSummary | null>(null);
  protected readonly selectedEventId = signal<number | null>(null);
  protected readonly selectedBuildId = signal<number | null>(null);
  protected readonly buildLoading = signal(false);
  protected readonly buildError = signal(false);
  protected readonly buildDetail = signal<BuildDetail | null>(null);
  protected readonly overrides = signal<Map<BuildSlot, DraftOverride>>(new Map());
  protected readonly confirmOpen = signal(false);
  protected readonly submitting = signal(false);

  protected readonly selectedEvent = computed(
    () => this.events().find((event) => event.event_id === this.selectedEventId()) ?? null,
  );

  /** Name of the chosen build, from the event's comp builds (or its primary build). */
  protected readonly selectedBuildName = computed<string | null>(() => {
    const event = this.selectedEvent();
    const buildId = this.selectedBuildId();
    if (!event || buildId === null) {
      return null;
    }
    const match = event.comp_builds.find((option) => option.build_id === buildId);
    return match?.build_name ?? event.primary_build_name ?? null;
  });

  protected readonly overrideCount = computed(() => this.overrides().size);

  /** Submit needs an event, a build that loaded, and no load in flight. */
  protected readonly canSubmit = computed(
    () =>
      this.selectedEvent() !== null &&
      this.selectedBuildId() !== null &&
      this.buildDetail() !== null &&
      !this.buildLoading() &&
      !this.buildError(),
  );

  /** Remaining budget after this request: bonus pool is spent first, then the weekly balance. */
  protected readonly reviewItems = computed<SummaryItem[]>(() => {
    const summary = this.summary();
    const bonusAfter = summary ? Math.max(0, summary.bonus_balance - 1) : null;
    const weeklyAfter = summary
      ? summary.bonus_balance > 0
        ? summary.weekly_balance
        : Math.max(0, summary.weekly_balance - 1)
      : null;
    return [
      { label: this.t('regears.newRequest.review.requests'), value: 1 },
      {
        label: this.t('regears.newRequest.review.bonusAfter'),
        value: bonusAfter,
        hint: summary ? this.t('regears.newRequest.review.ofCap', { cap: summary.bonus_cap }) : undefined,
      },
      {
        label: this.t('regears.newRequest.review.weeklyAfter'),
        value: weeklyAfter,
        hint: summary ? this.t('regears.newRequest.review.ofCap', { cap: summary.weekly_cap }) : undefined,
      },
    ];
  });

  protected readonly noRequestsLeft = computed(() => {
    const summary = this.summary();
    return summary !== null && summary.weekly_balance + summary.bonus_balance <= 0;
  });

  /** The build's items with local overrides applied, in canonical slot order, for the grid. */
  protected readonly gridItems = computed<BuildItemSlot[]>(() => {
    const build = this.buildDetail();
    if (!build) {
      return [];
    }
    const overrides = this.overrides();
    const canonical = build.items.filter((item) => (item.loadout ?? 'main') === 'main');
    return [...canonical]
      .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot))
      .map((item) => {
        const override = overrides.get(item.slot);
        if (!override) {
          return item;
        }
        return {
          ...item,
          openalbion_item_id: override.openalbion_item_id,
          openalbion_item_quality: override.openalbion_item_quality,
          openalbion_item_enchantment: override.openalbion_item_enchantment,
          openalbion_item_name: override.openalbion_item_name,
          openalbion_item_type: override.openalbion_item_type,
          openalbion_item_icon: override.openalbion_item_icon,
        };
      });
  });

  // Slot-editing draft state — local only, never persisted until final submit.
  protected readonly editingSlot = signal<BuildSlot | null>(null);
  protected readonly draftTier = signal('T8');
  protected readonly draftQuality = signal(DEFAULT_ALBION_ITEM_QUALITY);
  protected readonly draftEnchantment = signal<number>(DEFAULT_ALBION_ITEM_ENCHANTMENT);
  protected readonly draftSearch = signal('');
  protected readonly draftItemId = signal('');
  private draftItemName = '';
  private draftItemType = '';
  private draftItemIcon: string | null = null;
  protected readonly searchResults = signal<OpenAlbionItem[]>([]);
  protected readonly searchLoading = signal(false);
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.load();
  }

  protected retryLoad(): void {
    void this.load();
  }

  protected retryBuild(): void {
    const buildId = this.selectedBuildId();
    if (buildId !== null) {
      void this.loadBuild(buildId);
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const [events, summary] = await Promise.all([
        firstValueFrom(this.api.get<SelfServiceEventOption[]>('api/regear/self-service/events')),
        firstValueFrom(this.api.get<RegearBudgetSummary>('api/regear/me/summary')),
      ]);
      this.events.set(events);
      this.summary.set(summary);
      if (events.length > 0) {
        this.selectEvent(events[0].event_id);
      }
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected selectEvent(eventId: number): void {
    this.selectedEventId.set(eventId);
    const event = this.events().find((candidate) => candidate.event_id === eventId);
    const buildId = event?.primary_build_id ?? event?.comp_builds[0]?.build_id ?? null;
    this.selectedBuildId.set(buildId);
    this.overrides.set(new Map());
    this.cancelSlotEdit();
    this.buildError.set(false);
    if (buildId) {
      void this.loadBuild(buildId);
    } else {
      // Drop any build request still in flight so its spinner cannot outlive the selection.
      this.buildLoading.set(false);
      this.buildDetail.set(null);
    }
  }

  protected selectBuild(buildId: number): void {
    if (buildId === this.selectedBuildId()) {
      return;
    }
    this.selectedBuildId.set(buildId);
    this.overrides.set(new Map());
    this.cancelSlotEdit();
    void this.loadBuild(buildId);
  }

  private async loadBuild(buildId: number): Promise<void> {
    this.buildLoading.set(true);
    this.buildError.set(false);
    try {
      const build = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`));
      // A newer selection may have replaced this request while it was in flight.
      if (this.selectedBuildId() !== buildId) {
        return;
      }
      this.buildDetail.set(build);
    } catch {
      if (this.selectedBuildId() !== buildId) {
        return;
      }
      this.buildDetail.set(null);
      this.buildError.set(true);
    } finally {
      if (this.selectedBuildId() === buildId) {
        this.buildLoading.set(false);
      }
    }
  }

  protected openConfirm(): void {
    if (this.canSubmit()) {
      this.confirmOpen.set(true);
    }
  }

  protected onSlotToggle(slot: BuildSlot): void {
    if (this.editingSlot() === slot) {
      this.cancelSlotEdit();
      return;
    }
    const current = this.gridItems().find((item) => item.slot === slot) ?? null;
    this.editingSlot.set(slot);
    this.draftTier.set(current?.openalbion_item_tier ?? 'T8');
    this.draftQuality.set(
      slot === 'potion' || slot === 'food' || slot === 'mount'
        ? DEFAULT_ALBION_ITEM_QUALITY
        : normalizeAlbionItemQuality(current?.openalbion_item_quality),
    );
    this.draftEnchantment.set(
      slot === 'mount'
        ? DEFAULT_ALBION_ITEM_ENCHANTMENT
        : normalizeAlbionItemEnchantment(current?.openalbion_item_enchantment),
    );
    this.draftSearch.set(current?.openalbion_item_name ?? '');
    this.draftItemId.set(current ? String(current.openalbion_item_id) : '');
    this.draftItemName = current?.openalbion_item_name ?? '';
    this.draftItemType = current?.openalbion_item_type ?? '';
    this.draftItemIcon = current?.openalbion_item_icon ?? null;
    this.searchResults.set([]);
    if (current) {
      void this.runItemSearch();
    }
  }

  protected cancelSlotEdit(): void {
    this.editingSlot.set(null);
    this.draftSearch.set('');
    this.draftItemId.set('');
    this.searchResults.set([]);
  }

  protected onDraftTierChange(tier: string): void {
    this.draftTier.set(tier);
    this.draftItemId.set('');
    this.draftItemName = '';
    this.draftItemType = '';
    this.draftItemIcon = null;
    void this.runItemSearch();
  }

  protected onDraftQualityChange(quality: number): void {
    this.draftQuality.set(normalizeAlbionItemQuality(quality));
  }

  protected onDraftEnchantmentChange(enchantment: number): void {
    this.draftEnchantment.set(normalizeAlbionItemEnchantment(enchantment));
  }

  protected onDraftSearchChange(query: string): void {
    this.draftSearch.set(query);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => void this.runItemSearch(), 250);
  }

  protected onDraftItemChange(itemId: string): void {
    this.draftItemId.set(itemId);
    const item = this.searchResults().find((result) => String(result.id) === itemId);
    if (item) {
      this.draftTier.set(`T${item.tier.replace(/^T/i, '').split('.')[0]}`);
      if (!albionItemSupportsQuality(item.identifier)) {
        this.draftQuality.set(DEFAULT_ALBION_ITEM_QUALITY);
      }
      if (!albionItemSupportsEnchantment(item.identifier)) {
        this.draftEnchantment.set(DEFAULT_ALBION_ITEM_ENCHANTMENT);
      }
      this.draftItemName = item.name;
      this.draftItemType = item.type;
      this.draftItemIcon = item.icon ?? null;
    }
  }

  private async runItemSearch(): Promise<void> {
    const slot = this.editingSlot();
    if (!slot) {
      this.searchResults.set([]);
      return;
    }
    this.searchLoading.set(true);
    try {
      const catalog = await this.albionCatalog.load();
      this.searchResults.set(
        filterAlbionEquipmentCatalog(catalog, this.draftSearch(), slot, this.draftTier()),
      );
    } catch {
      this.searchResults.set([]);
    } finally {
      this.searchLoading.set(false);
    }
  }

  protected saveSlot(slot: BuildSlot): void {
    if (!this.draftItemId()) {
      return;
    }
    this.overrides.update((current) => {
      const next = new Map(current);
      next.set(slot, {
        slot,
        openalbion_item_id: Number(this.draftItemId()),
        openalbion_item_quality: this.draftQuality(),
        openalbion_item_enchantment: this.draftEnchantment(),
        openalbion_item_name: this.draftItemName,
        openalbion_item_type: this.draftItemType,
        openalbion_item_icon: this.draftItemIcon,
      });
      return next;
    });
    this.cancelSlotEdit();
  }

  protected removeOverride(slot: BuildSlot): void {
    this.overrides.update((current) => {
      if (!current.has(slot)) {
        return current;
      }
      const next = new Map(current);
      next.delete(slot);
      return next;
    });
  }

  protected async submit(): Promise<void> {
    const eventId = this.selectedEventId();
    const buildId = this.selectedBuildId();
    if (!eventId || !buildId || !this.canSubmit() || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    try {
      const req: CreateSelfServiceRegearRequest = {
        event_id: eventId,
        build_id: buildId,
        item_overrides: [...this.overrides().values()].map(
          ({ slot, openalbion_item_id, openalbion_item_quality, openalbion_item_enchantment }) => ({
            slot,
            openalbion_item_id,
            openalbion_item_quality,
            openalbion_item_enchantment,
          }),
        ),
      };
      const death = await firstValueFrom(
        this.api.post<RegearDeathView>('api/regear/self-service', req),
      );
      this.confirmOpen.set(false);
      this.toasts.success(this.t('regears.requested'));
      await this.router.navigate(['/regears', death.id]);
    } catch {
      this.toasts.error(this.t('regears.newRequest.error.submit'));
    } finally {
      this.submitting.set(false);
    }
  }
}
