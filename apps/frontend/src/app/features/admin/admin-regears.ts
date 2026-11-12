import { COMPACT_FEATURE_STYLES } from '../compact-feature.styles';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { RegearSettingsView, UpdateRegearSettingsRequest } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Checkbox } from '../../shared/components/checkbox/checkbox';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { Select, type SelectOption } from '../../shared/components/select/select';
import { Stat, SummaryBand } from '../../shared/components/summary-band/summary-band';

const PRICING_LOCATIONS = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
] as const;

/** AlbionBB Equipment JSON keys that map to a BuildSlot. */
const SLOT_BITS: ReadonlyArray<{ key: string; bit: number; labelKey: TranslationKey }> = [
  { key: 'weapon', bit: 1 << 0, labelKey: 'admin.regears.slot.weapon' },
  { key: 'off_hand', bit: 1 << 1, labelKey: 'admin.regears.slot.off_hand' },
  { key: 'head', bit: 1 << 2, labelKey: 'admin.regears.slot.head' },
  { key: 'armor', bit: 1 << 3, labelKey: 'admin.regears.slot.armor' },
  { key: 'shoes', bit: 1 << 4, labelKey: 'admin.regears.slot.shoes' },
  { key: 'cape', bit: 1 << 5, labelKey: 'admin.regears.slot.cape' },
  { key: 'bag', bit: 1 << 6, labelKey: 'admin.regears.slot.bag' },
  { key: 'potion', bit: 1 << 7, labelKey: 'admin.regears.slot.potion' },
  { key: 'food', bit: 1 << 8, labelKey: 'admin.regears.slot.food' },
  { key: 'mount', bit: 1 << 9, labelKey: 'admin.regears.slot.mount' },
];

/**
 * Guild-wide regear caps, pricing city, and reimbursable equipment slots.
 *
 * Moved out of the member-facing regears page so officers adjudicate deaths
 * there and admins tune the knobs here (`regear.settings.manage`).
 */
@Component({
  selector: 'app-admin-regears',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Checkbox, ErrorState, Loading, PageHeader, PageStack, Select, Stat, SummaryBand],
  styles: [COMPACT_FEATURE_STYLES, `
    .regear-section {
      display: grid;
      gap: 0.75rem;
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .regear-section + .regear-section {
      padding-top: 1.25rem;
      border-top: 1px solid var(--color-border);
    }
    .regear-section__title {
      font-size: var(--ui-text-lg);
      font-weight: 600;
      padding: 0;
    }
    .regear-field {
      display: grid;
      gap: 0.25rem;
      min-width: 0;
    }
    .regear-slots {
      display: grid;
      gap: 0.5rem;
      grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    }
  `],
  template: `
    <app-page-header
      [title]="t('admin.regears.title')"
      [subtitle]="t('admin.regears.hint')"
      [actions]="false"
    />

    <app-page-stack>
      @if (loading()) {
        <app-loading variant="detail" [label]="t('common.loading')" />
      } @else if (settings(); as s) {
        <app-summary-band [ariaLabel]="t('admin.regears.summaryLabel')">
          <app-stat
            [label]="t('admin.regears.weeklyTopup')"
            [value]="s.weekly_request_topup_amount"
            [hint]="t('admin.regears.perWeek')"
          />
          <app-stat
            [label]="t('admin.regears.weeklyCap')"
            [value]="s.weekly_request_cap"
            [hint]="t('admin.regears.capHint')"
          />
          <app-stat
            [label]="t('admin.regears.bonusCap')"
            [value]="s.bonus_request_cap"
            [hint]="t('admin.regears.bonusHint')"
          />
          <app-stat
            [label]="t('admin.regears.pricingLocation')"
            [value]="s.pricing_location"
            [hint]="t('admin.regears.pricingHint')"
          />
          <app-stat
            [label]="t('admin.regears.slots')"
            [value]="enabledSlotsLabel(s.enabled_slots_mask)"
            [hint]="t('admin.regears.slotsHint')"
          />
        </app-summary-band>

        <form class="card p-5 grid gap-6" (submit)="onSubmit($event)">
          <fieldset class="regear-section">
            <legend class="regear-section__title">{{ t('admin.regears.sectionPools') }}</legend>
            <div class="grid gap-4 md:grid-cols-3">
              <div class="regear-field">
                <label class="label" for="regear-topup">{{ t('admin.regears.weeklyTopup') }}</label>
                <input
                  id="regear-topup"
                  class="input"
                  type="number"
                  min="0"
                  aria-describedby="regear-topup-hint"
                  [value]="s.weekly_request_topup_amount"
                  (input)="updateNumber('weekly_request_topup_amount', $event)"
                />
                <span class="hint" id="regear-topup-hint">{{ t('admin.regears.topupHelp') }}</span>
              </div>
              <div class="regear-field">
                <label class="label" for="regear-cap">{{ t('admin.regears.weeklyCap') }}</label>
                <input
                  id="regear-cap"
                  class="input"
                  type="number"
                  min="0"
                  aria-describedby="regear-cap-hint"
                  [value]="s.weekly_request_cap"
                  (input)="updateNumber('weekly_request_cap', $event)"
                />
                <span class="hint" id="regear-cap-hint">{{ t('admin.regears.capHelp') }}</span>
              </div>
              <div class="regear-field">
                <label class="label" for="regear-bonus">{{ t('admin.regears.bonusCap') }}</label>
                <input
                  id="regear-bonus"
                  class="input"
                  type="number"
                  min="0"
                  aria-describedby="regear-bonus-hint"
                  [value]="s.bonus_request_cap"
                  (input)="updateNumber('bonus_request_cap', $event)"
                />
                <span class="hint" id="regear-bonus-hint">{{ t('admin.regears.bonusHelp') }}</span>
              </div>
            </div>
          </fieldset>

          <fieldset class="regear-section">
            <legend class="regear-section__title">{{ t('admin.regears.sectionPricing') }}</legend>
            <div class="grid gap-4 md:grid-cols-2">
              <div class="regear-field">
                <span class="label" id="regear-location-label">{{ t('admin.regears.pricingLocation') }}</span>
                <app-select
                  ariaLabelledBy="regear-location-label"
                  ariaDescribedBy="regear-location-hint"
                  [options]="locationOptions"
                  [value]="s.pricing_location"
                  (valueChange)="setField('pricing_location', $event)"
                />
                <span class="hint" id="regear-location-hint">{{ t('admin.regears.pricingLocationHelp') }}</span>
              </div>
              <div class="regear-field">
                <span class="label" id="regear-fallback-label">{{ t('admin.regears.pricingFallback') }}</span>
                <app-select
                  ariaLabelledBy="regear-fallback-label"
                  ariaDescribedBy="regear-fallback-hint"
                  [options]="fallbackOptions()"
                  [value]="s.pricing_fallback_strategy"
                  (valueChange)="setField('pricing_fallback_strategy', $event)"
                />
                <span class="hint" id="regear-fallback-hint">{{ t('admin.regears.pricingFallbackHelp') }}</span>
              </div>
            </div>
          </fieldset>

          <fieldset class="regear-section">
            <legend class="regear-section__title">{{ t('admin.regears.sectionSlots') }}</legend>
            <p class="hint">{{ t('admin.regears.slotsHelp') }}</p>
            <div class="regear-slots">
              @for (slot of slotBits; track slot.key) {
                <app-checkbox
                  [inputId]="'regear-slot-' + slot.key"
                  [label]="t(slot.labelKey)"
                  [checked]="isSlotEnabled(s.enabled_slots_mask, slot.bit)"
                  (checkedChange)="toggleSlot(slot.bit, $event)"
                />
              }
            </div>
          </fieldset>

          <div class="flex justify-end">
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ t('common.save') }}
            </button>
          </div>
        </form>
      } @else {
        <app-error-state
          [message]="t('common.error')"
          [retryLabel]="t('common.retry')"
          (retry)="load()"
        />
      }
    </app-page-stack>
  `,
})
export class AdminRegears {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly locationOptions: readonly SelectOption[] = PRICING_LOCATIONS.map((loc) => ({
    value: loc,
    label: loc,
  }));
  protected readonly fallbackOptions = computed<readonly SelectOption[]>(() => [
    { value: 'cheapest_any', label: this.t('admin.regears.cheapestAny') },
    { value: 'strict', label: this.t('admin.regears.strict') },
  ]);
  protected readonly slotBits = SLOT_BITS;

  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly settings = signal<RegearSettingsView | null>(null);
  private readonly draft = signal<UpdateRegearSettingsRequest>({});

  protected t = (key: TranslationKey) => this.translate.t(key);

  constructor() {
    void this.load();
  }

  protected isSlotEnabled(mask: number, bit: number): boolean {
    return (mask & bit) !== 0;
  }

  /** "3 / 10" style figure for the summary band. */
  protected enabledSlotsLabel(mask: number): string {
    let count = 0;
    for (const slot of this.slotBits) {
      if ((mask & slot.bit) !== 0) {
        count++;
      }
    }
    return `${count} / ${this.slotBits.length}`;
  }

  protected toggleSlot(bit: number, checked: boolean): void {
    const current = this.settings();
    if (!current) {
      return;
    }
    const newMask = checked ? current.enabled_slots_mask | bit : current.enabled_slots_mask & ~bit;
    this.settings.set({ ...current, enabled_slots_mask: newMask });
    this.draft.update((draft) => ({ ...draft, enabled_slots_mask: newMask }));
  }

  protected updateNumber(
    field: 'weekly_request_topup_amount' | 'weekly_request_cap' | 'bonus_request_cap',
    event: Event,
  ): void {
    this.setField(field, Number((event.target as HTMLInputElement).value));
  }

  protected setField(
    field: keyof UpdateRegearSettingsRequest,
    next: number | string,
  ): void {
    const current = this.settings();
    if (!current) {
      return;
    }
    this.settings.set({ ...current, [field]: next });
    this.draft.update((draft) => ({ ...draft, [field]: next }));
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.draft();
    if (Object.keys(draft).length === 0) {
      this.toasts.info(this.t('admin.regears.noChanges'));
      return;
    }
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<RegearSettingsView>('api/regear/settings', draft),
      );
      this.settings.set(updated);
      this.draft.set({});
      this.toasts.success(this.t('admin.regears.saved'));
    } catch (error) {
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const settings = await firstValueFrom(
        this.api.get<RegearSettingsView>('api/regear/settings'),
      );
      this.settings.set(settings);
      this.draft.set({});
    } catch (error) {
      this.settings.set(null);
      this.toasts.error(error instanceof Error ? error.message : this.t('common.error'));
    } finally {
      this.loading.set(false);
    }
  }
}
