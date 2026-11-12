import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';

import type { EventDetailView } from '../../../core/models/api.models';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { Icon } from '../../../shared/components/icon/icon';
import { PageHeader } from '../../../shared/components/page-header/page-header';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../../shared/components/view-toggle/view-toggle';
import { TooltipDirective } from '../../../shared/directives/tooltip.directive';

/**
 * Page header of the event detail page: title, officer actions (start, cancel,
 * uncancel, stop, edit, archive) and the tab switcher. Emits intents only; the
 * page owns the handlers, dialogs and state.
 */
@Component({
  selector: 'app-event-detail-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, TooltipDirective, ViewToggle],
  template: `
    @let detail = event();
    <!-- ================= PAGE HEADER: title, officer actions, tabs ================= -->
    <app-page-header
      [title]="detail.title"
      [badge]="
        detail.is_link
          ? detail.source_tenant_name
            ? t('events.linkFrom', { name: detail.source_tenant_name })
            : t('events.linkShared')
          : detail.archived_at
            ? t('events.archived')
            : undefined
      "
    >
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        (click)="back.emit()"
        [appTooltip]="t('events.detail.back')"
        tooltipPosition="bottom"
      >
        <app-icon name="chevron-left" size="0.875rem" />
        {{ t('events.detail.back') }}
      </button>
      @if (canEdit() && detail.status === 'scheduled' && !detail.archived_at) {
        <button
          type="button"
          class="btn btn--primary btn--sm"
          (click)="start.emit(detail.id)"
          [appTooltip]="t('events.start')"
          tooltipPosition="bottom"
        >
          <app-icon name="sparkles" size="0.875rem" />
          {{ t('events.start') }}
        </button>
      }
      @if (canEdit() && detail.status === 'scheduled' && !detail.archived_at) {
        <button
          type="button"
          class="btn btn--danger btn--sm"
          (click)="cancel.emit(detail.id)"
          [appTooltip]="t('events.cancel')"
          tooltipPosition="bottom"
        >
          <app-icon name="close" size="0.875rem" />
          {{ t('events.cancel') }}
        </button>
      }
      @if (canEdit() && detail.status === 'cancelled' && !detail.archived_at) {
        <button
          type="button"
          class="btn btn--primary btn--sm"
          (click)="uncancel.emit(detail.id)"
          [appTooltip]="t('events.uncancel')"
          tooltipPosition="bottom"
        >
          <app-icon name="refresh" size="0.875rem" />
          {{ t('events.uncancel') }}
        </button>
      }
      @if (canEdit() && detail.status === 'live' && !detail.archived_at) {
        <button
          type="button"
          class="btn btn--danger btn--sm"
          (click)="stop.emit(detail.id)"
          [appTooltip]="t('events.end')"
          tooltipPosition="bottom"
        >
          <app-icon name="close" size="0.875rem" />
          {{ t('events.stop') }}
        </button>
      }
      @if (canEdit() && !detail.archived_at) {
        <button
          type="button"
          class="btn btn--outline btn--sm"
          (click)="edit.emit()"
          [appTooltip]="t('events.editTooltip')"
          tooltipPosition="bottom"
        >
          <app-icon name="settings" size="0.875rem" />
          {{ t('common.edit') }}
        </button>
      }
      @if (canDelete()) {
        @if (detail.archived_at) {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            (click)="unarchive.emit()"
            [disabled]="saving()"
          >
            {{ t('events.unarchive') }}
          </button>
        } @else {
          <button
            type="button"
            class="btn btn--outline btn--sm"
            (click)="archive.emit()"
            [disabled]="saving()"
          >
            {{ t('events.archive') }}
          </button>
        }
      }
      <app-view-toggle
        pageTabs
        [options]="tabOptions()"
        [active]="tab()"
        (activeChange)="tabChange.emit($event)"
      />
    </app-page-header>
  `,
})
export class EventHeader {
  private readonly translate = inject(TranslateService);

  readonly event = input.required<EventDetailView>();
  readonly canEdit = input.required<boolean>();
  readonly canDelete = input.required<boolean>();
  readonly saving = input.required<boolean>();
  readonly tab = input.required<string>();
  readonly tabOptions = input.required<ViewToggleOption[]>();

  readonly back = output<void>();
  readonly start = output<number>();
  readonly cancel = output<number>();
  readonly uncancel = output<number>();
  readonly stop = output<number>();
  readonly edit = output<void>();
  readonly archive = output<void>();
  readonly unarchive = output<void>();
  readonly tabChange = output<string>();

  protected readonly t = (key: TranslationKey, params?: Record<string, string | number>) =>
    this.translate.t(key, params);
}
