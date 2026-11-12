import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'primary';

/** Data shape for the `items` shortcut of {@link SummaryBand}. */
export interface SummaryItem {
  readonly label: string;
  readonly value: string | number | null;
  readonly hint?: string;
  readonly tone?: StatTone;
}

/**
 * One figure of a summary band: a quiet label, the value, and an optional hint line.
 *
 * Colour is only for state and always has text beside it: `tone` tints the value, and the hint
 * (or label) must say what the state is ("3 overdue"), never leave the colour to carry it.
 *
 * @example
 * <app-stat [label]="t('bank.outstanding')" [value]="fmt(total)" [hint]="t('bank.requests', { count })" tone="warning" />
 */
@Component({
  selector: 'app-stat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-tone]': 'tone()',
  },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      min-width: 0;
      padding: 0.625rem 0.875rem;
      background: var(--color-surface);
      /* Hairline on the left and top of every cell; the band clips the outer edges. */
      box-shadow:
        -1px 0 0 0 var(--color-border),
        0 -1px 0 0 var(--color-border);
    }
    .stat__label {
      overflow: hidden;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      font-weight: 600;
      line-height: 1rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .stat__value {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      color: var(--color-text-heading);
      font-size: var(--ui-text-xl);
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      line-height: 1.5rem;
    }
    :host([data-tone='success']) .stat__value { color: var(--color-success); }
    :host([data-tone='warning']) .stat__value { color: var(--color-warning); }
    :host([data-tone='danger']) .stat__value { color: var(--color-error); }
    :host([data-tone='primary']) .stat__value { color: var(--color-primary); }
    .stat__delta {
      font-size: var(--ui-text-xs);
      font-weight: 500;
      color: var(--color-text-secondary);
    }
    .stat__delta--up { color: var(--color-success); }
    .stat__delta--down { color: var(--color-error); }
    .stat__hint {
      overflow: hidden;
      color: var(--color-text-secondary);
      font-size: var(--ui-text-xs);
      line-height: 1rem;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
  template: `
    <span class="stat__label">{{ label() }}</span>
    <span class="stat__value">
      {{ value() !== null && value() !== undefined ? value() : '—' }}
      @if (delta()) {
        <span
          class="stat__delta"
          [class.stat__delta--up]="deltaDirection() === 'up'"
          [class.stat__delta--down]="deltaDirection() === 'down'"
          >{{ deltaDirection() === 'up' ? '▲' : deltaDirection() === 'down' ? '▼' : '' }} {{ delta() }}</span
        >
      }
    </span>
    @if (hint()) {
      <span class="stat__hint">{{ hint() }}</span>
    }
  `,
})
export class Stat {
  readonly label = input.required<string>();
  readonly value = input.required<string | number | null>();
  /** Small line under the value: a unit, a period, or the state in words. */
  readonly hint = input('');
  readonly tone = input<StatTone>('default');
  /** Optional change figure shown beside the value ("+12%"); the arrow is shown with it. */
  readonly delta = input('');
  readonly deltaDirection = input<'up' | 'down' | 'neutral'>('neutral');
}

/**
 * A compact band of 3-6 key figures, one hairline-divided strip. It replaces rows of big KPI cards:
 * the figures sit inline, take one row on a desktop and wrap into a grid on a phone.
 *
 * Project `app-stat` children, or pass `items` for the plain case (both can be used together;
 * `items` render first).
 *
 * @example
 * ```html
 * <app-summary-band [ariaLabel]="t('bank.summary')">
 *   <app-stat [label]="t('bank.balance')" [value]="fmt(balance)" />
 *   <app-stat [label]="t('bank.pending')" [value]="pending" tone="warning" [hint]="t('bank.waiting')" />
 * </app-summary-band>
 * ```
 */
@Component({
  selector: 'app-summary-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Stat],
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .band {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
      overflow: hidden;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-smallcards);
      background: var(--color-surface);
    }
  `,
  template: `
    <div class="band" role="group" [attr.aria-label]="ariaLabel() || null">
      @for (item of items(); track $index) {
        <app-stat [label]="item.label" [value]="item.value" [hint]="item.hint ?? ''" [tone]="item.tone ?? 'default'" />
      }
      <ng-content />
    </div>
  `,
})
export class SummaryBand {
  /** Accessible name of the group ("Bank summary"). */
  readonly ariaLabel = input('');
  readonly items = input<readonly SummaryItem[]>([]);
}
