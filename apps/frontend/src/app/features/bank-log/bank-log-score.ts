import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { TranslateService } from '../../core/services/translate.service';

/** Score from which a match counts as likely. */
export const HIGH_SCORE = 75;
/** Score from which a match is worth a look; below it is a long shot. */
export const MEDIUM_SCORE = 50;

/**
 * How likely a bank log match is: the 0-100 score with a word for it, so the colour is never
 * the only cue.
 */
@Component({
  selector: 'app-bank-log-score',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: inline-flex;
    }
    .score {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      min-width: 4.75rem;
      padding: 0.125rem 0.5rem;
      border-radius: var(--radius-badges);
      border: 1px solid var(--color-border);
      background: var(--color-surface-2);
      font-size: var(--ui-text-xs);
      line-height: 1.25rem;
      white-space: nowrap;
    }
    .score__value {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .score__bar {
      position: relative;
      width: 1.75rem;
      height: 0.25rem;
      overflow: hidden;
      border-radius: var(--radius-badges);
      background: var(--color-border);
    }
    .score__fill {
      position: absolute;
      inset: 0 auto 0 0;
      background: currentColor;
    }
    .score--high {
      color: var(--color-success);
      border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-border));
    }
    .score--medium {
      color: var(--color-info);
      border-color: color-mix(in srgb, var(--color-info) 40%, var(--color-border));
    }
    .score--low {
      color: var(--color-warning);
      border-color: color-mix(in srgb, var(--color-warning) 40%, var(--color-border));
    }
    .score__label {
      color: var(--color-text-secondary);
    }
  `,
  template: `
    <span
      class="score"
      [class.score--high]="level() === 'high'"
      [class.score--medium]="level() === 'medium'"
      [class.score--low]="level() === 'low'"
      [attr.title]="title()"
      [attr.aria-label]="title()"
    >
      <span class="score__value">{{ value() }}</span>
      <span class="score__bar" aria-hidden="true"><span class="score__fill" [style.width.%]="value()"></span></span>
      @if (!compact()) {
        <span class="score__label">{{ label() }}</span>
      }
    </span>
  `,
})
export class BankLogScore {
  private readonly translate = inject(TranslateService);

  /** 0-100; null (a manual link) shows as 0. */
  readonly score = input.required<number | null>();
  /** Number and bar only, without the word. */
  readonly compact = input(false);

  protected readonly value = computed(() => Math.max(0, Math.min(100, Math.round(this.score() ?? 0))));
  protected readonly level = computed(() => {
    const value = this.value();
    return value >= HIGH_SCORE ? 'high' : value >= MEDIUM_SCORE ? 'medium' : 'low';
  });
  protected readonly label = computed(() =>
    this.translate.t(
      this.level() === 'high'
        ? 'bankLog.score.high'
        : this.level() === 'medium'
          ? 'bankLog.score.medium'
          : 'bankLog.score.low',
    ),
  );
  protected readonly title = computed(() =>
    this.translate.t('bankLog.score.title', { score: this.value(), level: this.label() }),
  );
}
