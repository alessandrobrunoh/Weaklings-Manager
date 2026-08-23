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
  template: `
    <div class="grid grid-cols-[minmax(5rem,1fr)_minmax(4rem,2fr)_auto] items-center gap-3 py-1">
      <span class="truncate text-xs" style="color: var(--color-text-secondary)">{{ label() }}</span>
      <span
        class="h-1.5 overflow-hidden rounded-full"
        style="background-color: var(--color-surface-2)"
        role="img"
        [attr.aria-label]="label() + ': ' + (display() || percent() + '%')"
      >
        <span
          class="block h-full rounded-full"
          [style.width.%]="percent()"
          [style.background-color]="barColor()"
        ></span>
      </span>
      <span class="mono text-xs" style="color: var(--color-text)">{{ display() || percent() + '%' }}</span>
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

  protected readonly percent = computed(() => {
    const max = this.max();
    if (!max || max <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, Math.round((this.value() / max) * 100)));
  });

  protected barColor(): string {
    switch (this.tone()) {
      case 'success':
        return 'var(--color-success)';
      case 'danger':
        return 'var(--color-error)';
      case 'neutral':
        return 'var(--color-border-strong)';
      default:
        return 'var(--color-primary)';
    }
  }
}
