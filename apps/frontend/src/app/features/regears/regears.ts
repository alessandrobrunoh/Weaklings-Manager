import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  AcceptRegearRequest,
  PaginatedData,
  RegearBudgetSummary,
  RegearBreakdownRow,
  RegearDeathView,
  RegearDeathFilters,
  RegearSettingsView,
  RejectRegearRequest,
  UpdateRegearSettingsRequest,
} from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { EmptyState } from '../../shared/components/empty-state/empty-state';
import { Loading } from '../../shared/components/loading/loading';
import { PageHeader } from '../../shared/components/page-header/page-header';

/** Tab toggle inside the Regears page. */
type RegearTab = 'mine' | 'queue' | 'history' | 'settings';

/** Editing copy of a breakdown row used in the officer queue modal. */
interface EditableBreakdownRow extends RegearBreakdownRow {
  /** Editable unit_price as a string for the input binding. */
  unit_price_input: string;
}

const PAGE_SIZE = 25;
const PRICING_LOCATIONS = [
  'Caerleon',
  'Bridgewatch',
  'Fort Sterling',
  'Lymhurst',
  'Martlock',
  'Thetford',
  'Brecilien',
];
/** AlbionBB Equipment JSON keys that map to a BuildSlot. */
const SLOT_BITS: ReadonlyArray<{ key: string; bit: number; label: string }> = [
  { key: 'weapon', bit: 1 << 0, label: 'Weapon' },
  { key: 'off_hand', bit: 1 << 1, label: 'Off-hand' },
  { key: 'head', bit: 1 << 2, label: 'Head' },
  { key: 'armor', bit: 1 << 3, label: 'Armor' },
  { key: 'shoes', bit: 1 << 4, label: 'Boots' },
  { key: 'cape', bit: 1 << 5, label: 'Cape' },
  { key: 'bag', bit: 1 << 6, label: 'Bag' },
  { key: 'potion', bit: 1 << 7, label: 'Potion' },
  { key: 'food', bit: 1 << 8, label: 'Food' },
  { key: 'mount', bit: 1 << 9, label: 'Mount' },
];

/**
 * Regears page: list your own deaths from Call-To-Arms events and request gear reimbursement.
 *
 * Officers get an extra "Queue" tab to adjudicate pending requests, editing the per-slot
 * breakdown before accepting or rejecting (rejection is terminal — the death can never be
 * re-requested). Admins get a "Settings" tab to tune the guild-wide caps and slot mask.
 */
@Component({
  selector: 'app-regears',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState, Loading, PageHeader],
  template: `
    <app-page-header
      title="Regears"
      subtitle="Request gear reimbursement for Call-To-Arms deaths."
    />

    <div
      class="mb-4 inline-flex gap-1 p-1"
      style="background-color: var(--color-surface-1); border-radius: var(--radius-md)"
    >
      <button
        type="button"
        class="btn btn--ghost"
        [class.btn--tonal]="tab() === 'mine'"
        (click)="switchTab('mine')"
      >
        My Deaths
      </button>
      @if (canAdjudicate()) {
        <button
          type="button"
          class="btn btn--ghost"
          [class.btn--tonal]="tab() === 'queue'"
          (click)="switchTab('queue')"
        >
          Officer Queue
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          [class.btn--tonal]="tab() === 'history'"
          (click)="switchTab('history')"
        >
          History
        </button>
      }
      @if (canManageSettings()) {
        <button
          type="button"
          class="btn btn--ghost"
          [class.btn--tonal]="tab() === 'settings'"
          (click)="switchTab('settings')"
        >
          Settings
        </button>
      }
    </div>

    @if (tab() === 'mine') {
      <section class="card mb-4 flex flex-wrap items-center gap-6 p-4 text-sm">
        @if (summary()) {
          <div>
            <span style="color: var(--color-text-secondary)">Event budget:</span>
            <strong class="ml-1"
              >{{ summary()!.per_event_used }}/{{ summary()!.per_event_max }}</strong
            >
          </div>
          <div>
            <span style="color: var(--color-text-secondary)">Monthly budget:</span>
            <strong class="ml-1"
              >{{ summary()!.per_month_used }}/{{ summary()!.per_month_max }}</strong
            >
          </div>
        }
      </section>
    }

    @if (loading()) {
      <app-loading label="Loading…" />
    } @else if (tab() === 'settings') {
      <section class="card p-5">
        <h3 class="mb-4 text-lg font-semibold">Regear Settings</h3>
        @if (settingsLoading()) {
          <app-loading label="Loading settings…" />
        } @else if (settings(); as s) {
          <form class="grid gap-4" (submit)="onSettingsSubmit($event)">
            <div class="grid gap-3 md:grid-cols-2">
              <label>
                <span class="label">Max regears per event</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="s.max_regears_per_event"
                  (input)="updateSettingsField('max_regears_per_event', $event)"
                />
              </label>
              <label>
                <span class="label">Max regears per month</span>
                <input
                  class="input"
                  type="number"
                  min="0"
                  [value]="s.max_regears_per_month"
                  (input)="updateSettingsField('max_regears_per_month', $event)"
                />
              </label>
              <label>
                <span class="label">Pricing location</span>
                <select
                  class="input"
                  [value]="s.pricing_location"
                  (change)="updateSettingsField('pricing_location', $event)"
                >
                  @for (loc of pricingLocations; track loc) {
                    <option [value]="loc">{{ loc }}</option>
                  }
                </select>
              </label>
              <label>
                <span class="label">Pricing fallback strategy</span>
                <select
                  class="input"
                  [value]="s.pricing_fallback_strategy"
                  (change)="updateSettingsField('pricing_fallback_strategy', $event)"
                >
                  <option value="cheapest_any">Cheapest across cities</option>
                  <option value="strict">Strict (configured city only)</option>
                </select>
              </label>
            </div>

            <fieldset class="rounded-lg border p-3" style="border-color: var(--color-border)">
              <legend class="px-1 text-sm font-semibold">Reimbursable slots</legend>
              <div class="grid grid-cols-2 gap-2 md:grid-cols-5">
                @for (slot of slotBits; track slot.key) {
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      [checked]="isSlotEnabled(s.enabled_slots_mask, slot.bit)"
                      (change)="toggleSlot(slot.bit, $event)"
                    />
                    {{ slot.label }}
                  </label>
                }
              </div>
            </fieldset>

            <div class="flex justify-end">
              <button type="submit" class="btn btn--primary" [disabled]="settingsSaving()">
                Save
              </button>
            </div>
          </form>
        }
      </section>
    } @else {
      @if (visibleDeaths().length === 0) {
        <app-empty-state message="No regearable deaths found." icon="shield" />
      } @else {
        <div class="grid gap-3">
          @for (death of visibleDeaths(); track death.id) {
            <article class="card p-4">
              <header class="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 class="font-semibold">
                    {{ death.player_name }}
                    @if (death.primary_build_name; as buildName) {
                      <span class="text-sm" style="color: var(--color-text-secondary)">
                        (signed up: {{ buildName }})
                      </span>
                    }
                  </h3>
                  <p class="text-xs" style="color: var(--color-text-secondary)">
                    {{ death.event_title }} —
                    <a [routerLink]="['/battles', death.albionbb_battle_id]" class="link">
                      battle #{{ death.albionbb_battle_id }}
                    </a>
                    · {{ formatDate(death.killed_at) }}
                  </p>
                </div>
                <span class="chip" [class]="statusChipClass(death.status)">
                  {{ death.status }}
                </span>
              </header>

              <div class="mb-2 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                    Auto estimate
                  </p>
                  <p class="text-xl font-bold">{{ formatSilver(death.auto_estimate_total) }}</p>
                </div>
                @if (death.final_amount !== null) {
                  <div>
                    <p class="text-xs uppercase" style="color: var(--color-text-secondary)">
                      Final amount
                    </p>
                    <p class="text-xl font-bold" style="color: var(--color-accent-gold)">
                      {{ formatSilver(death.final_amount) }}
                    </p>
                  </div>
                }
                @if (death.officer_note; as note) {
                  <p class="text-sm italic" style="color: var(--color-text-secondary)">
                    Officer note: {{ note }}
                  </p>
                }
              </div>

              <!-- Breakdown -->
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr style="color: var(--color-text-secondary)">
                      <th class="px-2 py-1 text-left">Slot</th>
                      <th class="px-2 py-1 text-left">Item</th>
                      <th class="px-2 py-1 text-right">Unit price</th>
                      <th class="px-2 py-1 text-right">Qty</th>
                      <th class="px-2 py-1 text-center">Included</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of breakdownFor(death); track row.item_id + row.slot) {
                      <tr style="border-top: 1px solid var(--color-border)">
                        <td class="px-2 py-1">{{ row.slot }}</td>
                        <td class="px-2 py-1 font-mono text-xs">{{ row.item_id }}</td>
                        <td class="px-2 py-1 text-right">{{ formatSilver(row.unit_price) }}</td>
                        <td class="px-2 py-1 text-right">{{ row.quantity }}</td>
                        <td class="px-2 py-1 text-center">
                          @if (row.included) {
                            <span style="color: var(--color-success)">✓</span>
                          } @else {
                            <span style="color: var(--color-text-disabled)">—</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <!-- Actions -->
              <footer class="mt-3 flex flex-wrap justify-end gap-2">
                @if (
                  tab() === 'mine' &&
                  death.status === 'available' &&
                  death.user_id === currentUserId()
                ) {
                  <button
                    type="button"
                    class="btn btn--primary"
                    (click)="requestRegear(death.id)"
                    [disabled]="acting()"
                  >
                    Request Regear
                  </button>
                }
                @if (tab() === 'queue' && death.status === 'pending') {
                  <button
                    type="button"
                    class="btn btn--ghost"
                    (click)="openAcceptDialog(death)"
                    [disabled]="acting()"
                  >
                    Edit & Accept
                  </button>
                  <button
                    type="button"
                    class="btn btn--danger"
                    (click)="openRejectDialog(death)"
                    [disabled]="acting()"
                  >
                    Reject
                  </button>
                }
              </footer>
            </article>
          }
        </div>
      }
    }

    <!-- Accept dialog -->
    @if (acceptDialog(); as dialog) {
      <div class="dialog-backdrop" (click)="closeAcceptDialog()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3 class="mb-3 text-lg font-semibold">
            Accept regear for {{ dialog.death.player_name }}
          </h3>
          <p class="mb-3 text-sm" style="color: var(--color-text-secondary)">
            Edit prices and toggle included slots. The total is recomputed live.
          </p>
          <div class="mb-3 max-h-80 overflow-y-auto">
            <table class="w-full text-sm">
              <thead>
                <tr style="color: var(--color-text-secondary)">
                  <th class="px-2 py-1 text-left">Slot</th>
                  <th class="px-2 py-1 text-left">Item</th>
                  <th class="px-2 py-1 text-right">Unit price</th>
                  <th class="px-2 py-1 text-center">Included</th>
                </tr>
              </thead>
              <tbody>
                @for (row of dialog.rows; track row.item_id + row.slot) {
                  <tr style="border-top: 1px solid var(--color-border)">
                    <td class="px-2 py-1">{{ row.slot }}</td>
                    <td class="px-2 py-1 font-mono text-xs">{{ row.item_id }}</td>
                    <td class="px-2 py-1 text-right">
                      <input
                        class="input input--sm w-32 text-right"
                        type="number"
                        min="0"
                        [value]="row.unit_price_input"
                        (input)="updateEditablePrice(row, $event)"
                      />
                    </td>
                    <td class="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        [checked]="row.included"
                        (change)="toggleEditableIncluded(row, $event)"
                      />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="mb-3 flex items-center justify-between">
            <span style="color: var(--color-text-secondary)">Total</span>
            <strong class="text-lg">{{ formatSilver(computeEditableTotal(dialog.rows)) }}</strong>
          </div>
          <label class="mb-3 block">
            <span class="label">Note (optional)</span>
            <input
              class="input"
              type="text"
              [value]="dialog.note"
              (input)="updateAcceptNote($event)"
            />
          </label>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn--ghost" (click)="closeAcceptDialog()">
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--primary"
              (click)="confirmAccept(dialog)"
              [disabled]="acting()"
            >
              Accept & Credit
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Reject dialog -->
    @if (rejectDialog(); as dialog) {
      <div class="dialog-backdrop" (click)="closeRejectDialog()">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3 class="mb-3 text-lg font-semibold">
            Reject regear for {{ dialog.death.player_name }}
          </h3>
          <p class="mb-2 text-sm" style="color: var(--color-error)">
            Rejection is final. The member cannot re-request this death.
          </p>
          <label class="mb-3 block">
            <span class="label">Reason (required)</span>
            <textarea
              class="textarea"
              rows="3"
              [value]="dialog.note"
              (input)="updateRejectNote($event)"
            ></textarea>
          </label>
          <div class="flex justify-end gap-2">
            <button type="button" class="btn btn--ghost" (click)="closeRejectDialog()">
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--danger"
              (click)="confirmReject(dialog)"
              [disabled]="acting() || !dialog.note.trim()"
            >
              Reject permanently
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .dialog-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 50;
        padding: 1rem;
      }
      .dialog {
        background: var(--color-surface-1);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        padding: 1.25rem;
        max-width: 720px;
        width: 100%;
        max-height: 90vh;
        overflow-y: auto;
      }
      .chip--success {
        background: var(--color-success-bg, rgba(34, 197, 94, 0.15));
        color: var(--color-success);
      }
      .chip--error {
        background: var(--color-error-bg, rgba(239, 68, 68, 0.15));
        color: var(--color-error);
      }
      .chip--warning {
        background: var(--color-warning-bg, rgba(234, 179, 8, 0.15));
        color: var(--color-warning);
      }
    `,
  ],
})
export class Regears {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);

  protected readonly pricingLocations = PRICING_LOCATIONS;
  protected readonly slotBits = SLOT_BITS;

  protected readonly tab = signal<RegearTab>('mine');
  protected readonly loading = signal(false);
  protected readonly acting = signal(false);
  protected readonly deaths = signal<RegearDeathView[]>([]);
  protected readonly summary = signal<RegearBudgetSummary | null>(null);

  protected readonly settingsLoading = signal(false);
  protected readonly settingsSaving = signal(false);
  protected readonly settings = signal<RegearSettingsView | null>(null);
  private readonly settingsDraft = signal<UpdateRegearSettingsRequest>({});

  protected readonly acceptDialog = signal<{
    death: RegearDeathView;
    rows: EditableBreakdownRow[];
    note: string;
  } | null>(null);
  protected readonly rejectDialog = signal<{ death: RegearDeathView; note: string } | null>(null);

  protected readonly canAdjudicate = computed(() => this.auth.hasPermission('regear.adjudicate'));
  protected readonly canManageSettings = computed(() =>
    this.auth.hasPermission('regear.settings.manage'),
  );
  protected readonly currentUserId = computed(() => this.auth.profile()?.user_id ?? null);

  /** Deaths currently shown, filtered by the active tab. */
  protected readonly visibleDeaths = computed<RegearDeathView[]>(() => {
    const all = this.deaths();
    switch (this.tab()) {
      case 'queue':
        return all.filter((death) => death.status === 'pending');
      case 'history':
        return all.filter((death) => death.status === 'approved' || death.status === 'rejected');
      default:
        return all;
    }
  });

  constructor() {
    void this.load();
  }

  protected switchTab(next: RegearTab): void {
    this.tab.set(next);
    void this.load();
  }

  protected breakdownFor(death: RegearDeathView): RegearBreakdownRow[] {
    return death.final_breakdown ?? death.auto_estimate_breakdown;
  }

  protected async requestRegear(deathId: number): Promise<void> {
    this.acting.set(true);
    try {
      await firstValueFrom(this.api.post<RegearDeathView>(`api/regear/deaths/${deathId}/request`));
      this.toasts.success('Regear requested.');
      await this.load();
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.acting.set(false);
    }
  }

  protected openAcceptDialog(death: RegearDeathView): void {
    const source = death.auto_estimate_breakdown;
    const rows: EditableBreakdownRow[] = source.map((row) => ({
      ...row,
      unit_price_input: String(row.unit_price),
    }));
    this.acceptDialog.set({ death, rows, note: '' });
  }

  protected closeAcceptDialog(): void {
    this.acceptDialog.set(null);
  }

  protected updateEditablePrice(row: EditableBreakdownRow, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    row.unit_price_input = value;
    row.unit_price = Number(value) || 0;
  }

  protected toggleEditableIncluded(row: EditableBreakdownRow, event: Event): void {
    row.included = (event.target as HTMLInputElement).checked;
  }

  protected updateAcceptNote(event: Event): void {
    const dialog = this.acceptDialog();
    if (!dialog) {
      return;
    }
    this.acceptDialog.set({ ...dialog, note: (event.target as HTMLInputElement).value });
  }

  protected computeEditableTotal(rows: readonly EditableBreakdownRow[]): number {
    return rows
      .filter((row) => row.included)
      .reduce((acc, row) => acc + (Number(row.unit_price) || 0) * row.quantity, 0);
  }

  protected async confirmAccept(dialog: NonNullable<RegearAuthDialogAccept>): Promise<void> {
    this.acting.set(true);
    try {
      const finalAmount = this.computeEditableTotal(dialog.rows);
      const payload: AcceptRegearRequest = {
        final_amount: finalAmount,
        breakdown: dialog.rows.map(({ unit_price_input: _ignored, ...row }) => row),
        note: dialog.note.trim() || undefined,
      };
      await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${dialog.death.id}/accept`, payload),
      );
      this.toasts.success('Regear accepted. Bank credited.');
      this.closeAcceptDialog();
      await this.load();
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.acting.set(false);
    }
  }

  protected openRejectDialog(death: RegearDeathView): void {
    this.rejectDialog.set({ death, note: '' });
  }

  protected closeRejectDialog(): void {
    this.rejectDialog.set(null);
  }

  protected updateRejectNote(event: Event): void {
    const dialog = this.rejectDialog();
    if (!dialog) {
      return;
    }
    this.rejectDialog.set({ ...dialog, note: (event.target as HTMLTextAreaElement).value });
  }

  protected async confirmReject(dialog: NonNullable<RegearAuthDialogReject>): Promise<void> {
    this.acting.set(true);
    try {
      const payload: RejectRegearRequest = { note: dialog.note.trim() };
      await firstValueFrom(
        this.api.post<RegearDeathView>(`api/regear/requests/${dialog.death.id}/reject`, payload),
      );
      this.toasts.success('Regear rejected (terminal).');
      this.closeRejectDialog();
      await this.load();
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.acting.set(false);
    }
  }

  protected isSlotEnabled(mask: number, bit: number): boolean {
    return (mask & bit) !== 0;
  }

  protected toggleSlot(bit: number, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.settings();
    if (!current) {
      return;
    }
    const newMask = checked ? current.enabled_slots_mask | bit : current.enabled_slots_mask & ~bit;
    this.settings.set({ ...current, enabled_slots_mask: newMask });
    this.settingsDraft.update((draft) => ({ ...draft, enabled_slots_mask: newMask }));
  }

  protected updateSettingsField(field: keyof UpdateRegearSettingsRequest, event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const current = this.settings();
    if (!current) {
      return;
    }
    const raw = target.value;
    const next =
      field === 'pricing_location' || field === 'pricing_fallback_strategy' ? raw : Number(raw);
    this.settings.set({ ...current, [field]: next });
    this.settingsDraft.update((draft) => ({ ...draft, [field]: next }));
  }

  protected async onSettingsSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.settingsDraft();
    if (Object.keys(draft).length === 0) {
      this.toasts.info('No changes to save.');
      return;
    }
    this.settingsSaving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.put<RegearSettingsView>('api/regear/settings', draft),
      );
      this.settings.set(updated);
      this.settingsDraft.set({});
      this.toasts.success('Settings saved.');
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.settingsSaving.set(false);
    }
  }

  protected formatDate(value: string | null): string {
    if (!value) {
      return '—';
    }
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  }

  protected formatSilver(value: number | string | null): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }
    const numeric = typeof value === 'string' ? Number(value) : value;
    if (Number.isNaN(numeric)) {
      return String(value);
    }
    return numeric.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' silver';
  }

  protected statusChipClass(status: RegearDeathView['status']): string {
    switch (status) {
      case 'approved':
        return 'chip--success';
      case 'rejected':
        return 'chip--error';
      case 'pending':
        return 'chip--warning';
      default:
        return '';
    }
  }

  private async load(): Promise<void> {
    if (this.tab() === 'settings') {
      await this.loadSettings();
      return;
    }
    this.loading.set(true);
    try {
      const filters: RegearDeathFilters = {};
      if (this.tab() === 'mine') {
        filters.global = false;
      } else {
        filters.global = true;
      }
      if (this.tab() === 'history') {
        // The history view is a client-side filter; load a broad set.
        filters.global = true;
      }
      const params: Record<string, string | number | boolean | undefined> = {
        page: 1,
        limit: PAGE_SIZE * 4,
        global: filters.global,
      };
      const page = await firstValueFrom(
        this.api.get<PaginatedData<RegearDeathView>>('api/regear/deaths', params),
      );
      this.deaths.set(page.items);

      if (this.tab() === 'mine') {
        const summary = await firstValueFrom(
          this.api.get<RegearBudgetSummary>('api/regear/me/summary'),
        );
        this.summary.set(summary);
      }
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
      this.deaths.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSettings(): Promise<void> {
    this.settingsLoading.set(true);
    try {
      const settings = await firstValueFrom(
        this.api.get<RegearSettingsView>('api/regear/settings'),
      );
      this.settings.set(settings);
      this.settingsDraft.set({});
    } catch (error) {
      this.toasts.error(this.errorMessage(error));
    } finally {
      this.settingsLoading.set(false);
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Unexpected error.';
  }
}

/** Local helper alias for the non-null accept dialog shape (used in template-typed callbacks). */
type RegearAuthDialogAccept = {
  death: RegearDeathView;
  rows: EditableBreakdownRow[];
  note: string;
};
/** Local helper alias for the non-null reject dialog shape. */
type RegearAuthDialogReject = { death: RegearDeathView; note: string };
