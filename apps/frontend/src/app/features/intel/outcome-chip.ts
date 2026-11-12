import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import type { IntelOutcome } from '../../core/models/api.models';
import { TranslateService } from '../../core/services/translate.service';
import { Icon, type IconName } from '../../shared/components/icon/icon';

interface OutcomeLook {
  readonly icon: IconName;
  readonly tone: 'success' | 'error' | 'neutral';
}

const LOOKS: Record<IntelOutcome, OutcomeLook> = {
  victory: { icon: 'check', tone: 'success' },
  defeat: { icon: 'close', tone: 'error' },
  draw: { icon: 'circle-dot', tone: 'neutral' },
  unknown: { icon: 'info', tone: 'neutral' },
};

/**
 * A fight outcome as icon plus word, so colour is never the only signal.
 *
 * `unknown` is deliberately neutral: a fight with no recorded winner is not a loss.
 */
@Component({
  selector: 'app-outcome-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  styles: `
    :host {
      display: inline-flex;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      white-space: nowrap;
    }
  `,
  template: `
    <span class="chip" [class]="'chip--' + look().tone">
      <app-icon [name]="look().icon" size="0.75rem" />
      {{ label() }}
    </span>
  `,
})
export class OutcomeChip {
  private readonly translate = inject(TranslateService);

  readonly outcome = input.required<IntelOutcome>();

  protected readonly look = computed(() => LOOKS[this.outcome()] ?? LOOKS.unknown);

  protected readonly label = computed(() => {
    switch (this.outcome()) {
      case 'victory':
        return this.translate.t('intel.outcome.victory');
      case 'defeat':
        return this.translate.t('intel.outcome.defeat');
      case 'draw':
        return this.translate.t('intel.outcome.draw');
      default:
        return this.translate.t('intel.outcome.unknown');
    }
  });
}
