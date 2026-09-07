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
import { filterAlbionEquipmentCatalog } from '../../shared/data/albion-equipment-catalog';
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
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

const ITEM_TIERS = ['T4', 'T5', 'T6', 'T7', 'T8'];

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
 * Self-service regear request wizard.
 *
 * A member picks an event they participated in, sees the build they were assigned (often stale —
 * what actually got worn differs from what was signed up with), optionally swaps to a different
 * build from the same comp and/or overrides individual slots, then submits. This lands directly
 * in the officer queue like an extracted death, consuming one request credit (bonus pool first).
 */
@Component({
  selector: 'app-regear-new-request',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, EmptyState, EquipmentGrid, Icon, Loading, PageHeader, PageStack],
  styles: `
    .event-card {
      display: block;
      width: 100%;
      text-align: left;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1rem 1.125rem;
      cursor: pointer;
      transition: border-color var(--motion-fast);
    }
    .event-card:hover {
      border-color: var(--color-border-hover);
    }
    .event-card--active {
      border-color: var(--color-primary);
      background: var(--color-surface-2);
    }
    .build-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.375rem 0.75rem;
      border-radius: 9999px;
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
    }
    .build-chip--active {
      border-color: var(--color-primary);
      background: var(--color-surface-2);
      color: var(--color-primary);
    }
  `,
  template: `
    <app-page-header [title]="t('regears.newRequest')" [subtitle]="t('regears.newRequest.subtitle')" />

    <app-page-stack>
      @if (loading()) {
        <app-loading />
      } @else if (events().length === 0) {
        <app-empty-state icon="shield" [message]="t('regears.newRequest.noEvents')" />
      } @else {
        <section class="grid gap-3 lg:grid-cols-12">
          <!-- Step 1: event picker -->
          <div class="lg:col-span-4 space-y-2.5">
            <h2 class="text-sm font-bold text-(--color-text)">
              {{ t('regears.newRequest.selectEvent') }}
            </h2>
            @for (event of events(); track event.event_id) {
              <button
                type="button"
                class="event-card"
                [class.event-card--active]="event.event_id === selectedEventId()"
                (click)="selectEvent(event.event_id)"
              >
                <span class="block text-sm font-bold text-(--color-text)">{{ event.event_title }}</span>
                @if (event.primary_build_name) {
                  <span class="block text-xs text-[var(--color-text-secondary)] mt-0.5">
                    {{ event.primary_build_name }}
                  </span>
                }
              </button>
            }
          </div>

          <!-- Step 2 & 3: build swap + slot overrides -->
          <div class="lg:col-span-8 space-y-4">
            @if (selectedEvent(); as event) {
              @if (event.comp_builds.length > 1) {
                <div class="space-y-2">
                  <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    {{ t('regears.newRequest.selectBuild') }}
                  </h3>
                  <div class="flex flex-wrap gap-2">
                    @for (option of event.comp_builds; track option.build_id) {
                      <button
                        type="button"
                        class="build-chip"
                        [class.build-chip--active]="option.build_id === selectedBuildId()"
                        (click)="selectBuild(option.build_id)"
                      >
                        {{ option.build_name }}
                        @if (option.quantity > 1) {
                          <span class="opacity-60">×{{ option.quantity }}</span>
                        }
                      </button>
                    }
                  </div>
                </div>
              }

              @if (buildLoading()) {
                <app-loading />
              } @else if (buildDetail(); as build) {
                <div class="space-y-2">
                  <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">
                    {{ t('regears.newRequest.editSlot') }}
                  </h3>
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

                <div class="flex items-center justify-end gap-2 pt-2 border-t border-[var(--color-border)]">
                  <button
                    type="button"
                    class="btn btn--primary"
                    [disabled]="submitting()"
                    (click)="confirmOpen.set(true)"
                  >
                    {{ t('regears.newRequest.submit') }}
                  </button>
                </div>
              }
            } @else {
              <app-empty-state icon="shield" [message]="t('regears.newRequest.pickAnEvent')" />
            }
          </div>
        </section>
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
  protected t = (key: TranslationKey) => this.translate.t(key);

  protected readonly loading = signal(true);
  protected readonly events = signal<SelfServiceEventOption[]>([]);
  protected readonly summary = signal<RegearBudgetSummary | null>(null);
  protected readonly selectedEventId = signal<number | null>(null);
  protected readonly selectedBuildId = signal<number | null>(null);
  protected readonly buildLoading = signal(false);
  protected readonly buildDetail = signal<BuildDetail | null>(null);
  protected readonly overrides = signal<Map<BuildSlot, DraftOverride>>(new Map());
  protected readonly confirmOpen = signal(false);
  protected readonly submitting = signal(false);

  protected readonly selectedEvent = computed(
    () => this.events().find((event) => event.event_id === this.selectedEventId()) ?? null,
  );

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

  private async load(): Promise<void> {
    this.loading.set(true);
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
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
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
    if (buildId) {
      void this.loadBuild(buildId);
    } else {
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
    try {
      const build = await firstValueFrom(this.api.get<BuildDetail>(`api/comps/builds/${buildId}`));
      this.buildDetail.set(build);
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      this.buildDetail.set(null);
    } finally {
      this.buildLoading.set(false);
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
    this.draftQuality.set(normalizeAlbionItemQuality(current?.openalbion_item_quality));
    this.draftEnchantment.set(normalizeAlbionItemEnchantment(current?.openalbion_item_enchantment));
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
    if (!eventId || !buildId || this.submitting()) {
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
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return this.t('common.error');
  }
}
