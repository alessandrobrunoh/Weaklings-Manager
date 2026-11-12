import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';

import type { ParticipantGuild } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { TooltipDirective } from '../../../shared/directives/tooltip.directive';

/**
 * Small chip naming the member guild a roster participant signed up for.
 *
 * The backend only attributes participants on linked (alliance) events, so a
 * missing guild means "unattributed or not linked" and renders nothing.
 */
@Component({
  selector: 'app-event-guild-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TooltipDirective],
  template: `
    @if (guild(); as g) {
      <span
        class="event-guild-badge chip chip--tonal text-xs font-bold px-1.5 py-0.2 truncate max-w-[6rem]"
        [appTooltip]="t('events.detail.participant_guild', { name: g.name })"
        tooltipPosition="top"
      >
        {{ g.name }}
      </span>
    }
  `,
})
export class EventGuildBadge {
  private readonly translate = inject(TranslateService);

  readonly guild = input<ParticipantGuild | null | undefined>(null);

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
