import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Compact KPI tile: a quiet label above a large tabular figure.
 *
 * Numbers are set in the mono face so columns of figures line up and read as
 * measurements rather than prose. `tone` tints only the value, never the
 * surface — the card itself stays neutral so a row of tiles reads as one
 * object rather than a traffic light.
 *
 * @example
 * <app-stat-card [label]="'Win rate'" [value]="'62%'" [sub]="'18 fights'" tone="success" />
 */
@Component({
  selector: 'app-stat-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card p-4">
      <p class="eyebrow">{{ label() }}</p>
      <p class="mono mt-1.5 text-xl leading-none" [style.color]="valueColor()">
        {{ value() ?? '—' }}
      </p>
      @if (sub()) {
        <p class="mt-1.5 text-xs" style="color: var(--color-text-secondary)">{{ sub() }}</p>
      }
    </div>
  `,
})
export class StatCard {
  readonly label = input.required<string>();
  readonly value = input.required<string | null>();
  /** Optional supporting line under the figure. */
  readonly sub = input<string>();
  /** Tints the figure only. */
  readonly tone = input<'default' | 'success' | 'warning' | 'danger' | 'primary'>('default');

  protected valueColor(): string {
    switch (this.tone()) {
      case 'success':
        return 'var(--color-success)';
      case 'warning':
        return 'var(--color-warning)';
      case 'danger':
        return 'var(--color-error)';
      case 'primary':
        return 'var(--color-primary)';
      default:
        return 'var(--color-text)';
    }
  }
}
