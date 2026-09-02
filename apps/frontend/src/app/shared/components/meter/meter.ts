import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Labelled horizontal bar: label, track, right-aligned figure.
 *
 * Used wherever a set of parts should be compared at a glance — role coverage,
 * weapon distribution, per-comp records. The percentage is clamped so a value
 * exceeding its max renders full rather than overflowing the track.
 *
 * @example
 * <app-meter [label]="'Healer'" [value]="3" [max]="5" [display]="'3 / 5'" tone="primary" />
 */
@Component({
  selector: 'app-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .meter-track {
      background-color: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.04);
      height: 0.4375rem;
      border-radius: 9999px;
      overflow: hidden;
    }
    .meter-fill {
      height: 100%;
      border-radius: 9999px;
      transition: width 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    }
  `,
  template: `
    <div class="grid grid-cols-[minmax(5rem,1fr)_minmax(4rem,2fr)_auto] items-center gap-3 py-1">
      <span class="truncate text-xs font-medium" style="color: var(--color-text-secondary)">{{ label() }}</span>
      <span
        class="meter-track block"
        role="progressbar"
        [attr.aria-label]="ariaLabel()"
        [attr.aria-valuemin]="0"
        [attr.aria-valuemax]="max()"
        [attr.aria-valuenow]="clampedValue()"
      >
        <span
          class="meter-fill block"
          [style.width.%]="percent()"
          [style.background-color]="barColor()"
        ></span>
      </span>
      <span class="mono text-xs font-semibold" style="color: var(--color-text)">{{ display() || percent() + '%' }}</span>
    </div>
  `,
})
export class Meter {
  readonly label = input.required<string>();
  readonly value = input.required<number>();
  readonly max = input<number>(100);
  /** Overrides the right-hand figure; defaults to the percentage. */
  readonly display = input<string | null>();
  readonly tone = input<'primary' | 'success' | 'danger' | 'neutral'>('primary');

  protected readonly clampedValue = computed(() => {
    const max = this.max();
    return !max || max <= 0 ? 0 : Math.min(max, Math.max(0, this.value()));
  });

  protected readonly percent = computed(() => {
    const max = this.max();
    if (!max || max <= 0) {
      return 0;
    }
    return Math.round((this.clampedValue() / max) * 100);
  });

  /** Some callers pass an empty label when the surrounding context (a table
   *  row, say) already names the row — but blindly prefixing `label() + ': '`
   *  in that case produced a stray leading colon like ": 62%". */
  protected readonly ariaLabel = computed(() => {
    const figure = this.display() || `${this.percent()}%`;
    const label = this.label();
    return label ? `${label}: ${figure}` : figure;
  });

  protected barColor(): string {
    switch (this.tone()) {
      case 'success':
        return '#4ade80';
      case 'danger':
        return '#f87171';
      case 'neutral':
        return 'rgba(148, 163, 184, 0.6)';
      default:
        return '#38bdf8';
    }
  }
}
