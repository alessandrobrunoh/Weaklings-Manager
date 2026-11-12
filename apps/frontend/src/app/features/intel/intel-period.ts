import { ChangeDetectionStrategy, Component, Injectable, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import type { IntelPeriodKey } from '../../core/models/api.models';
import type { IntelPeriodQuery } from '../../core/services/intel.service';
import { TranslateService } from '../../core/services/translate.service';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';

const PRESETS: readonly IntelPeriodKey[] = ['7d', '30d', '90d', 'all', 'custom'];
const DEFAULT_KEY: IntelPeriodKey = '30d';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isKey(value: string | null): value is IntelPeriodKey {
  return value !== null && (PRESETS as readonly string[]).includes(value);
}

/**
 * The period every Intel page is computed over.
 *
 * Provided by the Intel shell (and by the player detail page, which sits outside it), so the
 * tabs share one selection. The selection mirrors to the URL (`period`, `from`, `to`) so a link
 * reproduces the same numbers; it is read back from the URL on first load.
 */
@Injectable()
export class IntelPeriodState {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly key = signal<IntelPeriodKey>(DEFAULT_KEY);
  /** `yyyy-mm-dd`, only meaningful for the custom period. */
  readonly fromDate = signal('');
  readonly toDate = signal('');

  /** The request parameters for the current selection. */
  readonly query = computed<IntelPeriodQuery>(() => {
    const key = this.key();
    if (key === 'custom') {
      const from = this.fromDate();
      const to = this.toDate();
      if (DATE_ONLY.test(from) && DATE_ONLY.test(to) && from <= to) {
        return { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
      }
      return { period: DEFAULT_KEY };
    }
    return { period: key };
  });

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    if (DATE_ONLY.test(from) && DATE_ONLY.test(to) && from <= to) {
      this.key.set('custom');
      this.fromDate.set(from);
      this.toDate.set(to);
      return;
    }
    const period = params.get('period');
    if (isKey(period) && period !== 'custom') {
      this.key.set(period);
    }
  }

  /** Query-string parameters that reproduce this selection, for links and tab changes. */
  queryParams(): Record<string, string> {
    if (this.key() === 'custom' && this.fromDate() && this.toDate()) {
      return { from: this.fromDate(), to: this.toDate() };
    }
    return { period: this.key() === 'custom' ? DEFAULT_KEY : this.key() };
  }

  selectPreset(key: IntelPeriodKey): void {
    this.key.set(key);
    this.syncUrl();
  }

  /** Applies a custom range; returns false when the dates are unusable. */
  applyCustom(from: string, to: string): boolean {
    if (!DATE_ONLY.test(from) || !DATE_ONLY.test(to) || from > to) {
      return false;
    }
    this.fromDate.set(from);
    this.toDate.set(to);
    this.key.set('custom');
    this.syncUrl();
    return true;
  }

  private syncUrl(): void {
    const params = this.queryParams();
    void this.router.navigate([], {
      queryParams: {
        period: params['period'] ?? null,
        from: params['from'] ?? null,
        to: params['to'] ?? null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}

/**
 * Period selector: 7 / 30 / 90 days, all time, or a custom date range.
 *
 * Reads and writes {@link IntelPeriodState}, so a page only needs to drop this in and react to
 * `IntelPeriodState.query`.
 */
@Component({
  selector: 'app-intel-period',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ViewToggle],
  styles: `
    :host {
      display: block;
    }
  `,
  template: `
    <div class="flex flex-wrap items-end gap-x-4 gap-y-2" role="group" [attr.aria-label]="t('intel.period.label')">
      <div class="min-w-0 max-w-full">
        <app-view-toggle [options]="options()" [active]="editingCustom() ? 'custom' : state.key()" (activeChange)="onSelect($event)" />
      </div>
      @if (editingCustom()) {
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.period.from') }}</span>
            <input class="input input--sm" type="date" [value]="draftFrom()" (input)="draftFrom.set(inputValue($event))" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs" style="color: var(--color-text-secondary)">{{ t('intel.period.to') }}</span>
            <input class="input input--sm" type="date" [value]="draftTo()" (input)="draftTo.set(inputValue($event))" />
          </label>
          <button type="button" class="btn btn--outline btn--sm" (click)="apply()">
            {{ t('intel.period.apply') }}
          </button>
        </div>
      }
    </div>
    @if (invalid()) {
      <p class="mt-2 text-xs" role="alert" style="color: var(--color-error)">{{ t('intel.period.invalid') }}</p>
    }
  `,
})
export class IntelPeriod {
  protected readonly state = inject(IntelPeriodState);
  private readonly translate = inject(TranslateService);

  protected readonly pickingCustom = signal(false);
  protected readonly invalid = signal(false);
  protected readonly draftFrom = signal(this.state.fromDate());
  protected readonly draftTo = signal(this.state.toDate());
  protected readonly editingCustom = computed(
    () => this.pickingCustom() || this.state.key() === 'custom',
  );

  protected readonly options = computed<ViewToggleOption[]>(() => [
    { id: '7d', label: this.t('intel.period.7d') },
    { id: '30d', label: this.t('intel.period.30d') },
    { id: '90d', label: this.t('intel.period.90d') },
    { id: 'all', label: this.t('intel.period.all') },
    { id: 'custom', label: this.t('intel.period.custom') },
  ]);

  protected t = (key: Parameters<TranslateService['t']>[0]) => this.translate.t(key);

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected onSelect(id: string): void {
    this.invalid.set(false);
    if (id === 'custom') {
      this.pickingCustom.set(true);
      return;
    }
    this.pickingCustom.set(false);
    if (isKey(id)) {
      this.state.selectPreset(id);
    }
  }

  protected apply(): void {
    const ok = this.state.applyCustom(this.draftFrom(), this.draftTo());
    this.invalid.set(!ok);
    if (ok) {
      this.pickingCustom.set(false);
    }
  }
}
