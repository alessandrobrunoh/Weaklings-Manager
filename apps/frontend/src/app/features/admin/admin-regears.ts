import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { RegearSettingsView, UpdateRegearSettingsRequest } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { ErrorState } from '../../shared/components/error-state/error-state';
import { Icon } from '../../shared/components/icon/icon';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';

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
  imports: [ErrorState, Icon, Loading, PageHeader, PageStack],
  styles: `
    .kpi-card {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-cards);
      border: 1px solid var(--color-border);
      background: var(--color-surface);
      padding: 1.125rem 1.25rem;
      transition: border-color var(--motion-fast), transform var(--motion-fast);
    }
    .kpi-card:hover {
      border-color: var(--color-border-hover);
    }
    .icon-capsule {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 0.5rem;
      flex-shrink: 0;
    }
  `,
  template: `
    <app-page-header
      [title]="t('admin.regears.title')"
      [subtitle]="t('admin.regears.hint')"
      [actions]="false"
    />

    <app-page-stack>
      @if (loading()) {
        <app-loading [label]="t('common.loading')" />
      } @else if (settings(); as s) {
        <!-- KPI Cards summary of active policy -->
        <section class="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4" aria-label="Regear policy summary">
          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('admin.regears.maxPerEvent') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                  {{ s.max_regears_per_event }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Claims allowed per event
                </p>
              </div>
              <div class="icon-capsule bg-sky-500/10 text-sky-400 border border-sky-500/20">
                <app-icon name="shield" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('admin.regears.maxPerMonth') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-white mt-1">
                  {{ s.max_regears_per_month }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Monthly quota per member
                </p>
              </div>
              <div class="icon-capsule bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <app-icon name="calendar" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('admin.regears.pricingLocation') }}
                </p>
                <p class="font-mono text-xl font-bold tracking-tight text-amber-400 mt-1 truncate max-w-[170px]">
                  {{ s.pricing_location }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Market price source
                </p>
              </div>
              <div class="icon-capsule bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <app-icon name="bank" size="1.25rem" />
              </div>
            </div>
          </article>

          <article class="kpi-card">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[0.6875rem] font-medium tracking-wider text-[var(--color-text-secondary)] uppercase">
                  {{ t('admin.regears.slots') }}
                </p>
                <p class="font-mono text-2xl font-bold tracking-tight text-emerald-400 mt-1">
                  {{ enabledSlotsCount(s.enabled_slots_mask) }} / {{ slotBits.length }}
                </p>
                <p class="text-xs text-[var(--color-text-secondary)] mt-1 truncate">
                  Reimbursed equipment slots
                </p>
              </div>
              <div class="icon-capsule bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <app-icon name="check" size="1.25rem" />
              </div>
            </div>
          </article>
        </section>

        <section class="card p-5">
          <form class="grid gap-4" (submit)="onSubmit($event)">
            <div class="grid gap-3 md:grid-cols-2">
              <label>
                <span class="label">{{ t('admin.regears.maxPerEvent') }}</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="s.max_regears_per_event"
                  (input)="updateField('max_regears_per_event', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('admin.regears.maxPerMonth') }}</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="s.max_regears_per_month"
                  (input)="updateField('max_regears_per_month', $event)"
                />
              </label>
              <label>
                <span class="label">{{ t('admin.regears.pricingLocation') }}</span>
                <select
                  class="select"
                  [value]="s.pricing_location"
                  (change)="updateField('pricing_location', $event)"
                >
                  @for (loc of pricingLocations; track loc) {
                    <option [value]="loc">{{ loc }}</option>
                  }
                </select>
              </label>
              <label>
                <span class="label">{{ t('admin.regears.pricingFallback') }}</span>
                <select
                  class="select"
                  [value]="s.pricing_fallback_strategy"
                  (change)="updateField('pricing_fallback_strategy', $event)"
                >
                  <option value="cheapest_any">{{ t('admin.regears.cheapestAny') }}</option>
                  <option value="strict">{{ t('admin.regears.strict') }}</option>
                </select>
              </label>
            </div>

            <fieldset class="rounded-lg border p-3" style="border-color: var(--color-border)">
              <legend class="px-1 text-sm font-semibold">{{ t('admin.regears.slots') }}</legend>
              <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
                @for (slot of slotBits; track slot.key) {
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      class="checkbox"
                      type="checkbox"
                      [checked]="isSlotEnabled(s.enabled_slots_mask, slot.bit)"
                      (change)="toggleSlot(slot.bit, $event)"
                    />
                    {{ t(slot.labelKey) }}
                  </label>
                }
              </div>
            </fieldset>

            <div class="flex justify-end">
              <button type="submit" class="btn btn--primary" [disabled]="saving()">
                {{ t('common.save') }}
              </button>
            </div>
          </form>
        </section>
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

  protected readonly pricingLocations = PRICING_LOCATIONS;
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

  protected enabledSlotsCount(mask: number): number {
    let count = 0;
    for (const slot of this.slotBits) {
      if ((mask & slot.bit) !== 0) {
        count++;
      }
    }
    return count;
  }

  protected toggleSlot(bit: number, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.settings();
    if (!current) {
      return;
    }
    const newMask = checked ? current.enabled_slots_mask | bit : current.enabled_slots_mask & ~bit;
    this.settings.set({ ...current, enabled_slots_mask: newMask });
    this.draft.update((draft) => ({ ...draft, enabled_slots_mask: newMask }));
  }

  protected updateField(field: keyof UpdateRegearSettingsRequest, event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const current = this.settings();
    if (!current) {
      return;
    }
    const raw = target.value;
    const next =
      field === 'pricing_location' || field === 'pricing_fallback_strategy' ? raw : Number(raw);
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
