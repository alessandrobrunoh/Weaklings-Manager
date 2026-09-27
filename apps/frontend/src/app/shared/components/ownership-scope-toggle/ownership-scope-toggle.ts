import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';
import { isOwnershipScope, type OwnershipScope } from '../../data/ownership-scope';
import { ViewToggle, type ViewToggleOption } from '../view-toggle/view-toggle';

/**
 * Mine / Everyone switch used on every comps and builds listing and picker.
 *
 * Mine is the default everywhere so an officer's own loadouts sit in front of
 * the guild catalogue; Everyone is an explicit second section.
 */
@Component({
  selector: 'app-ownership-scope-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ViewToggle],
  host: {
    class: 'block min-w-0',
  },
  template: `
    <div role="group" [attr.aria-label]="t('comps.scope.label')">
      <app-view-toggle [options]="options()" [active]="scope()" (activeChange)="onChange($event)" />
    </div>
  `,
})
export class OwnershipScopeToggle {
  readonly scope = input<OwnershipScope>('mine');
  readonly scopeChange = output<OwnershipScope>();

  private readonly translate = inject(TranslateService);

  protected readonly options = computed<ViewToggleOption[]>(() => [
    { id: 'mine', label: this.t('comps.scope.mine') },
    { id: 'all', label: this.t('comps.scope.all') },
  ]);

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected onChange(next: string): void {
    if (!isOwnershipScope(next) || next === this.scope()) {
      return;
    }
    this.scopeChange.emit(next);
  }
}
