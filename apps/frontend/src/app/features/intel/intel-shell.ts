import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { PageHeader } from '../../shared/components/page-header/page-header';
import {
  ViewToggle,
  type ViewToggleOption,
} from '../../shared/components/view-toggle/view-toggle';
import { IntelPeriodState } from './intel-period';

/** Tab ids, in display order. The id doubles as the child route path. */
const TABS = ['overview', 'players', 'fights', 'comps', 'opponents'] as const;
type IntelTab = (typeof TABS)[number];

/** The path segment under `/intel` for each tab; the overview is the index route. */
const TAB_PATH: Record<IntelTab, string> = {
  overview: '',
  players: 'players',
  fights: 'fights',
  comps: 'comps',
  opponents: 'opponents',
};

const TAB_LABEL: Record<IntelTab, TranslationKey> = {
  overview: 'intel.hub.tab.overview',
  players: 'intel.hub.tab.players',
  fights: 'intel.hub.tab.fights',
  comps: 'intel.hub.tab.comps',
  opponents: 'intel.hub.tab.opponents',
};

/**
 * Intel: one section, five questions.
 *
 * - Overview: how are we doing, and what changed?
 * - Players: how is each member doing?
 * - Fights: every fight, filterable.
 * - Comps: which comps do well, and against whom?
 * - Opponents: who are we facing, and what do they field?
 *
 * The shell owns the page header, the tabs and the shared period; each tab is a child route.
 */
@Component({
  selector: 'app-intel-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeader, RouterOutlet, ViewToggle],
  providers: [IntelPeriodState],
  styles: `
    :host {
      display: block;
      color: var(--color-text);
    }
  `,
  template: `
    <app-page-header [title]="t('intel.hub.title')" [subtitle]="t('intel.hub.subtitle')">
      <app-view-toggle pageTabs [options]="tabs()" [active]="active()" (activeChange)="open($event)" />
    </app-page-header>
    <router-outlet />
  `,
})
export class IntelShell {
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly period = inject(IntelPeriodState);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly active = computed<IntelTab>(() => {
    const path = this.url().split('?')[0].split('#')[0];
    const segment = path.replace(/^\/intel\/?/, '').split('/')[0];
    return TABS.find((tab) => TAB_PATH[tab] === segment) ?? 'overview';
  });

  protected readonly tabs = computed<ViewToggleOption[]>(() =>
    TABS.map((tab) => ({ id: tab, label: this.t(TAB_LABEL[tab]) })),
  );

  protected t = (key: TranslationKey) => this.translate.t(key);

  protected open(id: string): void {
    const tab = TABS.find((candidate) => candidate === id);
    if (!tab) {
      return;
    }
    const commands = TAB_PATH[tab] === '' ? ['/intel'] : ['/intel', TAB_PATH[tab]];
    void this.router.navigate(commands, { queryParams: this.period.queryParams() });
  }
}
