import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { BankAnalyticsSummary, BankBreakdown, GuildReport, TrendBucket } from '../../core/models/api.models';
import { ApiService } from '../../core/services/api.service';
import { ToastService } from '../../core/services/toast.service';
import { TranslateService } from '../../core/services/translate.service';
import type { TranslationKey } from '../../i18n/en';
import { Icon } from '../../shared/components/icon/icon';
import { PageHeader } from '../../shared/components/page-header/page-header';
import { PageStack } from '../../shared/components/page-stack/page-stack';
import { TooltipDirective } from '../../shared/directives/tooltip.directive';

interface FinanceBar {
  readonly label: string;
  readonly value: number;
  readonly width: number;
  readonly tone: 'primary' | 'success' | 'warning' | 'neutral';
}

interface FlowTrendPoint {
  readonly label: string;
  readonly fullDate: string;
  readonly x: number;
  readonly lootY: number;
  readonly outflowY: number;
  readonly lootValue: number;
  readonly outflowValue: number;
  readonly netValue: number;
}

interface LossRegearTrendPoint {
  readonly label: string;
  readonly fullDate: string;
  readonly x: number;
  readonly lossX: number;
  readonly lossY: number;
  readonly lossHeight: number;
  readonly lossValue: number;
  readonly regearX: number;
  readonly regearY: number;
  readonly regearHeight: number;
  readonly regearValue: number;
  readonly barWidth: number;
}

interface ActivityTrendPoint {
  readonly label: string;
  readonly fullDate: string;
  readonly x: number;
  readonly fightX: number;
  readonly fightY: number;
  readonly fightHeight: number;
  readonly fights: number;
  readonly eventX: number;
  readonly eventY: number;
  readonly eventHeight: number;
  readonly events: number;
  readonly barWidth: number;
}

/** Whole-ledger finance workspace for officers with bank reporting access. */
@Component({
  selector: 'app-admin-finance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PageHeader, PageStack, TooltipDirective],
  styles: `
    .finance-overview, .finance-analytics { display: grid; gap: 0.875rem; }
    .finance-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--color-border); border-radius: 8px; overflow: clip; background: var(--color-surface); }
    .finance-metric { min-inline-size: 0; padding: 0.875rem 1rem; border-inline-end: 1px solid var(--color-border); }
    .finance-metric:last-child { border-inline-end: 0; }
    .finance-metric__label, .finance-section-label { margin: 0; color: var(--color-text-tertiary); font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.035em; text-transform: uppercase; }
    .finance-metric__value { margin: 0.375rem 0 0; color: var(--color-text); font-family: var(--font-mono); font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    .finance-metric__detail { margin: 0.25rem 0 0; color: var(--color-text-secondary); font-size: 0.6875rem; }
    .finance-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.875rem; }
    .finance-chart { min-inline-size: 0; padding: 1rem; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); display: flex; flex-direction: column; justify-content: space-between; }
    .finance-chart--full { grid-column: 1 / -1; }
    .finance-chart__header { display: flex; align-items: safe center; justify-content: space-between; gap: 0.75rem; margin-block-end: 1rem; }
    .finance-chart__title { margin: 0; color: var(--color-text); font-size: 0.875rem; font-weight: 600; }
    .finance-chart__sub { margin: 0.125rem 0 0; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-bars { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
    .finance-bar { display: grid; grid-template-columns: minmax(6rem, 1fr) auto; align-items: safe center; gap: 0.5rem; }
    .finance-bar__label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    .finance-bar__amount { color: var(--color-text); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600; text-align: end; }
    .finance-bar__track { grid-column: 1 / -1; block-size: 0.375rem; overflow: hidden; border-radius: 999px; background: var(--color-surface-2); }
    .finance-bar__fill { display: block; block-size: 100%; min-inline-size: 2px; border-radius: inherit; transition: width 0.3s ease; }
    .finance-bar__fill--primary { background: var(--color-primary); }
    .finance-bar__fill--success { background: var(--color-success); }
    .finance-bar__fill--warning { background: var(--color-warning); }
    .finance-bar__fill--neutral { background: var(--color-text-tertiary); }
    
    .finance-donut-container { display: grid; grid-template-columns: 10rem minmax(0, 1fr); align-items: center; gap: 1.25rem; }
    .finance-donut-svg { inline-size: 10rem; block-size: 10rem; overflow: visible; }
    .finance-donut__ring { fill: none; stroke: var(--color-surface-2); stroke-width: 14; }
    .finance-donut__segment { fill: none; stroke-width: 14; stroke-linecap: round; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dasharray 0.3s ease, stroke-dashoffset 0.3s ease; }
    .finance-donut__segment--primary { stroke: var(--color-primary); }
    .finance-donut__segment--success { stroke: var(--color-success); }
    .finance-donut__segment--warning { stroke: var(--color-warning); }
    .finance-donut__segment--neutral { stroke: var(--color-text-tertiary); }
    .finance-donut__center-label { fill: var(--color-text-tertiary); font-size: 0.5rem; text-anchor: middle; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
    .finance-donut__center-val { fill: var(--color-text); font-family: var(--font-mono); font-size: 0.8125rem; font-weight: 700; text-anchor: middle; }
    
    .finance-legend { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
    .finance-legend__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; color: var(--color-text-secondary); font-size: 0.75rem; }
    .finance-legend__dot { inline-size: 0.625rem; block-size: 0.625rem; border-radius: 50%; }
    .finance-legend__dot--primary { background: var(--color-primary); }
    .finance-legend__dot--success { background: var(--color-success); }
    .finance-legend__dot--warning { background: var(--color-warning); }
    .finance-legend__dot--neutral { background: var(--color-text-tertiary); }
    .finance-legend__amount { color: var(--color-text); font-family: var(--font-mono); font-weight: 600; }
    
    .finance-svg-wrapper { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .finance-svg-chart { display: block; inline-size: 100%; min-inline-size: 460px; block-size: 13.5rem; overflow: visible; }
    .finance-svg__grid { stroke: var(--color-border); stroke-width: 1; stroke-dasharray: 4 4; }
    .finance-svg__axis { stroke: var(--color-border-strong, var(--color-border)); stroke-width: 1.25; }
    .finance-svg__scale-label { fill: var(--color-text-tertiary); font-family: var(--font-mono); font-size: 9px; text-anchor: end; }
    .finance-svg__date-label { fill: var(--color-text-secondary); font-size: 9.5px; text-anchor: middle; font-weight: 500; }
    .finance-svg__line-loot { fill: none; stroke: var(--color-success); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .finance-svg__line-outflow { fill: none; stroke: var(--color-primary); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .finance-svg__area-loot { fill: url(#lootGradient); }
    .finance-svg__area-outflow { fill: url(#outflowGradient); }
    .finance-svg__node-loot { fill: var(--color-surface); stroke: var(--color-success); stroke-width: 2.5; cursor: pointer; transition: transform 0.15s ease; }
    .finance-svg__node-loot:hover { transform: scale(1.4); }
    .finance-svg__node-outflow { fill: var(--color-surface); stroke: var(--color-primary); stroke-width: 2.5; cursor: pointer; transition: transform 0.15s ease; }
    .finance-svg__node-outflow:hover { transform: scale(1.4); }
    .finance-svg__bar-loss { fill: #ef4444; opacity: 0.85; transition: opacity 0.15s ease; }
    .finance-svg__bar-loss:hover { opacity: 1; }
    .finance-svg__bar-regear { fill: var(--color-success); opacity: 0.9; transition: opacity 0.15s ease; }
    .finance-svg__bar-regear:hover { opacity: 1; }
    .finance-svg__bar-fight { fill: #38bdf8; opacity: 0.85; }
    .finance-svg__bar-fight:hover { opacity: 1; }
    .finance-svg__bar-event { fill: var(--color-warning); opacity: 0.85; }
    .finance-svg__bar-event:hover { opacity: 1; }
    
    .finance-chart-legend { display: flex; flex-wrap: wrap; gap: 1rem; margin-block-start: 0.75rem; color: var(--color-text-secondary); font-size: 0.6875rem; }
    .finance-chart-legend span { display: inline-flex; align-items: center; gap: 0.375rem; font-weight: 500; }
    .finance-chart-legend__key { inline-size: 0.75rem; block-size: 0.25rem; border-radius: 1px; }
    .finance-chart-legend__key--loot { background: var(--color-success); }
    .finance-chart-legend__key--outflow { background: var(--color-primary); }
    .finance-chart-legend__key--loss { background: #ef4444; }
    .finance-chart-legend__key--regear { background: var(--color-success); }
    .finance-chart-legend__key--fight { background: #38bdf8; }
    .finance-chart-legend__key--event { background: var(--color-warning); }
    
    .finance-panels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.875rem; }
    .finance-panel { min-inline-size: 0; border: 1px solid var(--color-border); border-radius: 8px; background: var(--color-surface); }
    .finance-panel__header { display: flex; align-items: safe center; justify-content: space-between; gap: 0.5rem; padding: 0.75rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-panel__title { margin: 0; color: var(--color-text-secondary); font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.035em; }
    .finance-list { margin: 0; padding: 0; list-style: none; }
    .finance-list__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: safe center; gap: 0.75rem; padding: 0.625rem 0.875rem; border-block-end: 1px solid var(--color-border); }
    .finance-list__row:last-child { border-block-end: 0; }
    .finance-list__label { overflow: hidden; color: var(--color-text-secondary); font-size: 0.75rem; text-overflow: ellipsis; white-space: nowrap; }
    .finance-list__meta { display: block; margin-block-start: 0.125rem; color: var(--color-text-tertiary); font-size: 0.6875rem; }
    .finance-list__amount { color: var(--color-text); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600; }
    .finance-note, .finance-empty { margin: 0; padding: 0.75rem 0.875rem; border: 1px solid var(--color-border); border-radius: 6px; color: var(--color-text-tertiary); font-size: 0.75rem; line-height: 1.5; }
    .finance-empty { padding: 2rem 0; border: 0; text-align: center; }
    
    @media (max-width: 72rem) {
      .finance-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .finance-metric:nth-child(2) { border-inline-end: 0; }
      .finance-metric:nth-child(-n + 2) { border-block-end: 1px solid var(--color-border); }
      .finance-chart-grid, .finance-panels { grid-template-columns: 1fr; }
    }
    @media (max-width: 48rem) {
      .finance-metrics { grid-template-columns: 1fr; }
      .finance-metric, .finance-metric:nth-child(2) { border-inline-end: 0; border-block-end: 1px solid var(--color-border); }
      .finance-metric:last-child { border-block-end: 0; }
      .finance-donut-container { grid-template-columns: 1fr; justify-items: center; }
    }
  `,
  template: `
    <app-page-header [title]="t('bank.finance.heading')" [subtitle]="t('bank.finance.description')">
      <button type="button" class="btn btn--outline btn--sm" [disabled]="loading()" (click)="loadFinance()">
        <app-icon name="sparkles" size="0.875rem" />
        {{ t('common.refreshNow') }}
      </button>
    </app-page-header>

    <app-page-stack>
      <section class="finance-overview" [attr.aria-label]="t('bank.finance.ariaLabel')">
        @if (summary(); as bank) {
          <!-- High-Level Financial Ledger Metrics -->
          <div class="finance-metrics">
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.openLiability') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.outstanding_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.creditsOwed', { count: bank.outstanding_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.awaitingApproval') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.requested_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.requestedWithdrawals', { count: bank.requested_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.paidOut') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.paid_out_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.settledPayouts', { count: bank.paid_out_count }) }}</p>
            </div>
            <div class="finance-metric">
              <p class="finance-metric__label">{{ t('bank.finance.donatedBack') }}</p>
              <p class="finance-metric__value">{{ formatAmount(bank.donated_total) }}</p>
              <p class="finance-metric__detail">{{ t('bank.finance.memberDonations', { count: bank.donated_count }) }}</p>
            </div>
          </div>

          <!-- Comprehensive Visual Financial Analytics Grid -->
          <section class="finance-analytics" [attr.aria-label]="t('bank.finance.analytics')">
            <div class="flex items-center justify-between">
              <h2 class="finance-section-label">{{ t('bank.finance.analytics') }}</h2>
              @if (report()?.economy; as econ) {
                <div class="flex items-center gap-3 text-xs">
                  <span class="text-[var(--color-text-secondary)]">
                    {{ t('bank.finance.netCashFlow') }}:
                    <strong class="font-mono" [style.color]="econ.net >= 0 ? 'var(--color-success)' : '#ef4444'">
                      {{ econ.net >= 0 ? '+' : '' }}{{ formatAmount(econ.net) }}
                    </strong>
                  </span>
                </div>
              }
            </div>

            <div class="finance-chart-grid">
              <!-- Chart 1 (Full width): Weekly Cash Flow (Loot In vs Member Outflow Area Chart) -->
              <section class="finance-chart finance-chart--full" aria-labelledby="finance-flow-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-flow-chart" class="finance-chart__title">{{ t('bank.finance.weeklyFlow') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.weeklyFlowDescription') }}</p>
                  </div>
                  @if (report()?.economy; as econ) {
                    <div class="flex items-center gap-2">
                      <span class="text-xs font-mono font-semibold px-2 py-0.5 rounded" style="background: var(--color-surface-2)">
                        {{ t('bank.finance.avgWeeklyLoot') }}: {{ formatAmount(avgWeeklyLoot()) }}
                      </span>
                    </div>
                  }
                </header>

                @if (flowPoints().length > 1) {
                  <div class="finance-svg-wrapper">
                    <svg class="finance-svg-chart" viewBox="0 0 600 240" preserveAspectRatio="xMidYMid meet" role="img" [attr.aria-label]="t('bank.finance.weeklyFlow')">
                      <defs>
                        <linearGradient id="lootGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="var(--color-success)" stop-opacity="0.32" />
                          <stop offset="100%" stop-color="var(--color-success)" stop-opacity="0.0" />
                        </linearGradient>
                        <linearGradient id="outflowGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stop-color="var(--color-primary)" stop-opacity="0.28" />
                          <stop offset="100%" stop-color="var(--color-primary)" stop-opacity="0.0" />
                        </linearGradient>
                      </defs>

                      <!-- Grid background lines & Scale markers -->
                      <line class="finance-svg__grid" x1="45" y1="35" x2="585" y2="35" />
                      <text class="finance-svg__scale-label" x="40" y="38">{{ formatCompact(maxFlowValue()) }}</text>

                      <line class="finance-svg__grid" x1="45" y1="115" x2="585" y2="115" />
                      <text class="finance-svg__scale-label" x="40" y="118">{{ formatCompact(maxFlowValue() / 2) }}</text>

                      <line class="finance-svg__axis" x1="45" y1="195" x2="585" y2="195" />
                      <text class="finance-svg__scale-label" x="40" y="198">0</text>

                      <!-- Area fills below curves -->
                      <path class="finance-svg__area-loot" [attr.d]="lootAreaPath()" />
                      <path class="finance-svg__area-outflow" [attr.d]="outflowAreaPath()" />

                      <!-- Multi-curves -->
                      <path class="finance-svg__line-loot" [attr.d]="lootLinePath()" />
                      <path class="finance-svg__line-outflow" [attr.d]="outflowLinePath()" />

                      <!-- Data node markers & date labels -->
                      @for (pt of flowPoints(); track pt.label) {
                        <circle class="finance-svg__node-loot" [attr.cx]="pt.x" [attr.cy]="pt.lootY" r="4.5">
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.lootCreated') }} = {{ formatAmount(pt.lootValue) }}</title>
                        </circle>
                        <circle class="finance-svg__node-outflow" [attr.cx]="pt.x" [attr.cy]="pt.outflowY" r="4.5">
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.memberOutflow') }} = {{ formatAmount(pt.outflowValue) }}</title>
                        </circle>
                        <text class="finance-svg__date-label" [attr.x]="pt.x" y="215">{{ pt.label }}</text>
                      }
                    </svg>
                  </div>

                  <div class="finance-chart-legend">
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--loot"></i>{{ t('bank.finance.lootCreated') }}</span>
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--outflow"></i>{{ t('bank.finance.memberOutflow') }}</span>
                  </div>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>

              <!-- Chart 2: Combat Losses vs Regear Reimbursement -->
              <section class="finance-chart" aria-labelledby="finance-loss-regear-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-loss-regear-chart" class="finance-chart__title">{{ t('bank.finance.lossVsRegear') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.regearCoverage') }}</p>
                  </div>
                  @if (regearCoverageRatio() > 0) {
                    <span class="text-xs font-mono font-semibold px-2 py-0.5 rounded text-[var(--color-success)]" style="background: var(--color-success-container)">
                      {{ regearCoverageRatio() }}% {{ t('bank.finance.regearCoverage') }}
                    </span>
                  }
                </header>

                @if (lossRegearPoints().length > 0) {
                  <div class="finance-svg-wrapper">
                    <svg class="finance-svg-chart" viewBox="0 0 600 240" preserveAspectRatio="xMidYMid meet" role="img" [attr.aria-label]="t('bank.finance.lossVsRegear')">
                      <!-- Grid lines -->
                      <line class="finance-svg__grid" x1="45" y1="35" x2="585" y2="35" />
                      <text class="finance-svg__scale-label" x="40" y="38">{{ formatCompact(maxLossRegearValue()) }}</text>

                      <line class="finance-svg__grid" x1="45" y1="115" x2="585" y2="115" />
                      <text class="finance-svg__scale-label" x="40" y="118">{{ formatCompact(maxLossRegearValue() / 2) }}</text>

                      <line class="finance-svg__axis" x1="45" y1="195" x2="585" y2="195" />
                      <text class="finance-svg__scale-label" x="40" y="198">0</text>

                      <!-- Grouped bars -->
                      @for (pt of lossRegearPoints(); track pt.label) {
                        <rect
                          class="finance-svg__bar-loss"
                          [attr.x]="pt.lossX"
                          [attr.y]="pt.lossY"
                          [attr.width]="pt.barWidth"
                          [attr.height]="pt.lossHeight"
                          rx="3"
                        >
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.silverLost') }} = {{ formatAmount(pt.lossValue) }}</title>
                        </rect>
                        <rect
                          class="finance-svg__bar-regear"
                          [attr.x]="pt.regearX"
                          [attr.y]="pt.regearY"
                          [attr.width]="pt.barWidth"
                          [attr.height]="pt.regearHeight"
                          rx="3"
                        >
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.regearPaid') }} = {{ formatAmount(pt.regearValue) }}</title>
                        </rect>
                        <text class="finance-svg__date-label" [attr.x]="pt.x" y="215">{{ pt.label }}</text>
                      }
                    </svg>
                  </div>

                  <div class="finance-chart-legend">
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--loss"></i>{{ t('bank.finance.silverLost') }}</span>
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--regear"></i>{{ t('bank.finance.regearPaid') }}</span>
                  </div>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>

              <!-- Chart 3: Weekly Operational Activity (Fights vs Events) -->
              <section class="finance-chart" aria-labelledby="finance-ops-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-ops-chart" class="finance-chart__title">{{ t('bank.finance.weeklyActivity') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.weeklyActivityDescription') }}</p>
                  </div>
                </header>

                @if (activityPoints().length > 0) {
                  <div class="finance-svg-wrapper">
                    <svg class="finance-svg-chart" viewBox="0 0 600 240" preserveAspectRatio="xMidYMid meet" role="img" [attr.aria-label]="t('bank.finance.weeklyActivity')">
                      <!-- Grid lines -->
                      <line class="finance-svg__grid" x1="45" y1="35" x2="585" y2="35" />
                      <text class="finance-svg__scale-label" x="40" y="38">{{ maxActivityValue() }}</text>

                      <line class="finance-svg__grid" x1="45" y1="115" x2="585" y2="115" />
                      <text class="finance-svg__scale-label" x="40" y="118">{{ Math.round(maxActivityValue() / 2) }}</text>

                      <line class="finance-svg__axis" x1="45" y1="195" x2="585" y2="195" />
                      <text class="finance-svg__scale-label" x="40" y="198">0</text>

                      <!-- Grouped bars -->
                      @for (pt of activityPoints(); track pt.label) {
                        <rect
                          class="finance-svg__bar-fight"
                          [attr.x]="pt.fightX"
                          [attr.y]="pt.fightY"
                          [attr.width]="pt.barWidth"
                          [attr.height]="pt.fightHeight"
                          rx="3"
                        >
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.fights') }} = {{ pt.fights }}</title>
                        </rect>
                        <rect
                          class="finance-svg__bar-event"
                          [attr.x]="pt.eventX"
                          [attr.y]="pt.eventY"
                          [attr.width]="pt.barWidth"
                          [attr.height]="pt.eventHeight"
                          rx="3"
                        >
                          <title>{{ pt.fullDate }}: {{ t('bank.finance.events') }} = {{ pt.events }}</title>
                        </rect>
                        <text class="finance-svg__date-label" [attr.x]="pt.x" y="215">{{ pt.label }}</text>
                      }
                    </svg>
                  </div>

                  <div class="finance-chart-legend">
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--fight"></i>{{ t('bank.finance.fights') }}</span>
                    <span><i class="finance-chart-legend__key finance-chart-legend__key--event"></i>{{ t('bank.finance.events') }}</span>
                  </div>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>

              <!-- Chart 4: Solvency & Liability Ring Breakdown -->
              <section class="finance-chart" aria-labelledby="finance-liability-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-liability-chart" class="finance-chart__title">{{ t('bank.finance.liabilityMix') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.currentLedger') }}</p>
                  </div>
                </header>

                @if (liabilityBars().length > 0) {
                  <div class="finance-donut-container">
                    <svg class="finance-donut-svg" viewBox="0 0 160 160" role="img" [attr.aria-label]="t('bank.finance.liabilityMix')">
                      <circle class="finance-donut__ring" cx="80" cy="80" r="58" />
                      @for (segment of donutSegments(); track segment.label) {
                        <circle
                          class="finance-donut__segment"
                          [class]="'finance-donut__segment--' + segment.tone"
                          cx="80"
                          cy="80"
                          r="58"
                          [attr.stroke-dasharray]="segment.dasharray"
                          [attr.stroke-dashoffset]="segment.dashoffset"
                        />
                      }
                      <text class="finance-donut__center-label" x="80" y="74">Volume</text>
                      <text class="finance-donut__center-val" x="80" y="92">{{ formatCompact(donutTotal()) }}</text>
                    </svg>

                    <ul class="finance-legend" role="list">
                      @for (bar of liabilityBars(); track bar.label) {
                        <li class="finance-legend__row">
                          <span class="finance-legend__dot" [class]="'finance-legend__dot--' + bar.tone"></span>
                          <span>{{ bar.label }}</span>
                          <span class="finance-legend__amount">{{ formatAmount(bar.value) }}</span>
                        </li>
                      }
                    </ul>
                  </div>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>

              <!-- Chart 5: Outflow Allocation Distribution -->
              <section class="finance-chart" aria-labelledby="finance-outflow-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-outflow-chart" class="finance-chart__title">{{ t('bank.finance.outflowAllocation') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.lastThirtyDays') }}</p>
                  </div>
                </header>

                @if (outflowBars().length > 0) {
                  <ul class="finance-bars" role="list">
                    @for (bar of outflowBars(); track bar.label) {
                      <li class="finance-bar">
                        <span class="finance-bar__label">{{ bar.label }}</span>
                        <span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span>
                        <span class="finance-bar__track">
                          <span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span>
                        </span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>

              <!-- Chart 6: Transaction Types Distribution -->
              <section class="finance-chart" aria-labelledby="finance-type-chart">
                <header class="finance-chart__header">
                  <div>
                    <h3 id="finance-type-chart" class="finance-chart__title">{{ t('bank.finance.ledgerMix') }}</h3>
                    <p class="finance-chart__sub">{{ t('bank.finance.byTransactionType') }}</p>
                  </div>
                </header>

                @if (transactionTypeBars().length > 0) {
                  <ul class="finance-bars" role="list">
                    @for (bar of transactionTypeBars(); track bar.label) {
                      <li class="finance-bar">
                        <span class="finance-bar__label">{{ bar.label }}</span>
                        <span class="finance-bar__amount">{{ formatAmount(bar.value) }}</span>
                        <span class="finance-bar__track">
                          <span class="finance-bar__fill" [class]="'finance-bar__fill--' + bar.tone" [style.inlineSize.%]="bar.width"></span>
                        </span>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="finance-empty">{{ t('bank.finance.noChartData') }}</p>
                }
              </section>
            </div>
          </section>

          <!-- Fund Sources & Destinations Breakdown Panels -->
          <div class="finance-panels">
            <section class="finance-panel" aria-labelledby="finance-source-heading">
              <header class="finance-panel__header">
                <h2 id="finance-source-heading" class="finance-panel__title">{{ t('bank.finance.topSourcesTitle') }}</h2>
              </header>
              <ul class="finance-list">
                @for (line of bank.sources.slice(0, 5); track line.label) {
                  <li class="finance-list__row">
                    <span class="finance-list__label">
                      {{ line.label }}
                      <span class="finance-list__meta">{{ t('bank.finance.ledgerEntries', { count: line.transaction_count }) }}</span>
                    </span>
                    <span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span>
                  </li>
                }
              </ul>
            </section>

            <section class="finance-panel" aria-labelledby="finance-dest-heading">
              <header class="finance-panel__header">
                <h2 id="finance-dest-heading" class="finance-panel__title">{{ t('bank.finance.topDestinationsTitle') }}</h2>
              </header>
              <ul class="finance-list">
                @for (line of bank.destinations.slice(0, 5); track line.label) {
                  <li class="finance-list__row">
                    <span class="finance-list__label">
                      {{ line.label }}
                      <span class="finance-list__meta">{{ t('bank.finance.ledgerEntries', { count: line.transaction_count }) }}</span>
                    </span>
                    <span class="finance-list__amount">{{ formatAmount(line.total_amount) }}</span>
                  </li>
                }
              </ul>
            </section>

            <section class="finance-panel" aria-labelledby="finance-period-heading">
              <header class="finance-panel__header">
                <h2 id="finance-period-heading" class="finance-panel__title">{{ t('bank.finance.lastThirtyDays') }}</h2>
              </header>
              @if (report(); as guildReport) {
                <ul class="finance-list">
                  <li class="finance-list__row">
                    <span class="finance-list__label">{{ t('bank.finance.lootCreated') }}</span>
                    <span class="finance-list__amount" style="color: var(--color-success)">{{ formatAmount(guildReport.economy.loot_in) }}</span>
                  </li>
                  <li class="finance-list__row">
                    <span class="finance-list__label">{{ t('bank.finance.memberOutflow') }}</span>
                    <span class="finance-list__amount" style="color: var(--color-primary)">{{ formatAmount(guildReport.economy.outflow_total) }}</span>
                  </li>
                  <li class="finance-list__row">
                    <span class="finance-list__label">{{ t('bank.finance.regearPaid') }}</span>
                    <span class="finance-list__amount">{{ formatAmount(guildReport.economy.regear_paid) }}</span>
                  </li>
                  <li class="finance-list__row">
                    <span class="finance-list__label">
                      {{ t('bank.finance.siphonedNet') }}
                      <span class="finance-list__meta">{{ t('bank.finance.siphonedDetail') }}</span>
                    </span>
                    <span class="finance-list__amount">{{ formatAmount(guildReport.economy.siphoned_net) }}</span>
                  </li>
                </ul>
              } @else {
                <p class="finance-note">{{ t('bank.finance.reportPermission') }}</p>
              }
            </section>
          </div>

          <p class="finance-note">{{ t('bank.finance.ledgerNote') }}</p>
        } @else if (loading()) {
          <p class="finance-note">{{ t('bank.finance.loading') }}</p>
        } @else {
          <p class="finance-note">{{ t('bank.finance.unavailable') }}</p>
        }
      </section>
    </app-page-stack>
  `,
})
export class AdminFinance {
  private readonly api = inject(ApiService);
  private readonly toasts = inject(ToastService);
  private readonly translate = inject(TranslateService);

  protected readonly Math = Math;
  protected readonly summary = signal<BankAnalyticsSummary | null>(null);
  protected readonly report = signal<GuildReport | null>(null);
  protected readonly loading = signal(true);

  protected readonly liabilityBars = computed(() => {
    const summary = this.summary();
    if (!summary) return [];
    return this.makeBars([
      { label: this.t('bank.finance.openLiability'), value: summary.outstanding_total, tone: 'warning' },
      { label: this.t('bank.finance.awaitingApproval'), value: summary.requested_total, tone: 'primary' },
      { label: this.t('bank.finance.paidOut'), value: summary.paid_out_total, tone: 'success' },
      { label: this.t('bank.finance.donatedBack'), value: summary.donated_total, tone: 'neutral' },
    ]);
  });

  protected readonly transactionTypeBars = computed(() => this.breakdownBars(this.summary()?.transaction_types));
  protected readonly sourceBars = computed(() => this.breakdownBars(this.summary()?.sources));
  protected readonly destinationBars = computed(() => this.breakdownBars(this.summary()?.destinations));

  protected readonly outflowBars = computed(() => {
    const economy = this.report()?.economy;
    if (!economy) return [];
    return this.makeBars([
      { label: this.t('bank.finance.splitOutflow'), value: economy.outflow_splits, tone: 'primary' },
      { label: this.t('bank.finance.regearPaid'), value: economy.outflow_regear, tone: 'warning' },
      { label: this.t('bank.finance.otherOutflow'), value: economy.outflow_other, tone: 'neutral' },
    ]);
  });

  protected readonly donutTotal = computed(() =>
    this.liabilityBars().reduce((total, bar) => total + Math.abs(bar.value), 0),
  );

  protected readonly donutSegments = computed(() => {
    const total = this.donutTotal() || 1;
    const circumference = 364.42; // 2 * PI * 58
    let offset = 0;
    return this.liabilityBars().map((bar) => {
      const length = (Math.abs(bar.value) / total) * circumference;
      const segment = { ...bar, dasharray: `${length} ${circumference - length}`, dashoffset: -offset };
      offset += length;
      return segment;
    });
  });

  protected readonly maxFlowValue = computed(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return 1000;
    return Math.max(100, ...trends.flatMap((t) => [Math.abs(t.loot_in), Math.abs(t.outflow)]));
  });

  protected readonly flowPoints = computed<FlowTrendPoint[]>(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return [];
    const max = this.maxFlowValue();
    const span = Math.max(1, trends.length - 1);
    const leftPad = 55;
    const rightPad = 575;
    const chartWidth = rightPad - leftPad;
    const chartHeight = 160; // 195 - 35
    const baseLine = 195;

    return trends.map((trend, index) => {
      const x = leftPad + (chartWidth * index) / span;
      const lootY = baseLine - (Math.abs(trend.loot_in) / max) * chartHeight;
      const outflowY = baseLine - (Math.abs(trend.outflow) / max) * chartHeight;
      return {
        label: this.formatWeek(trend.week_start),
        fullDate: this.formatFullDate(trend.week_start),
        x,
        lootY,
        outflowY,
        lootValue: trend.loot_in,
        outflowValue: trend.outflow,
        netValue: trend.loot_in - trend.outflow,
      };
    });
  });

  protected readonly lootLinePath = computed(() => this.toSmoothPath(this.flowPoints(), 'lootY'));
  protected readonly outflowLinePath = computed(() => this.toSmoothPath(this.flowPoints(), 'outflowY'));

  protected readonly lootAreaPath = computed(() => {
    const pts = this.flowPoints();
    if (pts.length === 0) return '';
    const line = this.toSmoothPath(pts, 'lootY');
    const first = pts[0];
    const last = pts[pts.length - 1];
    return `${line} L ${last.x},195 L ${first.x},195 Z`;
  });

  protected readonly outflowAreaPath = computed(() => {
    const pts = this.flowPoints();
    if (pts.length === 0) return '';
    const line = this.toSmoothPath(pts, 'outflowY');
    const first = pts[0];
    const last = pts[pts.length - 1];
    return `${line} L ${last.x},195 L ${first.x},195 Z`;
  });

  protected readonly maxLossRegearValue = computed(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return 1000;
    return Math.max(100, ...trends.flatMap((t) => [Math.abs(t.silver_lost || 0), Math.abs(t.outflow || 0)]));
  });

  protected readonly lossRegearPoints = computed<LossRegearTrendPoint[]>(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return [];
    const max = this.maxLossRegearValue();
    const leftPad = 55;
    const rightPad = 575;
    const chartWidth = rightPad - leftPad;
    const chartHeight = 160;
    const baseLine = 195;
    const slotWidth = chartWidth / trends.length;
    const barWidth = Math.max(6, Math.min(22, slotWidth * 0.35));

    return trends.map((trend, index) => {
      const centerX = leftPad + slotWidth * index + slotWidth / 2;
      const lossVal = Math.abs(trend.silver_lost || 0);
      const regearVal = Math.abs(trend.outflow || 0);
      const lossH = Math.max(lossVal > 0 ? 3 : 0, (lossVal / max) * chartHeight);
      const regearH = Math.max(regearVal > 0 ? 3 : 0, (regearVal / max) * chartHeight);

      return {
        label: this.formatWeek(trend.week_start),
        fullDate: this.formatFullDate(trend.week_start),
        x: centerX,
        lossX: centerX - barWidth - 2,
        lossY: baseLine - lossH,
        lossHeight: lossH,
        lossValue: lossVal,
        regearX: centerX + 2,
        regearY: baseLine - regearH,
        regearHeight: regearH,
        regearValue: regearVal,
        barWidth,
      };
    });
  });

  protected readonly maxActivityValue = computed(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return 10;
    return Math.max(5, ...trends.flatMap((t) => [t.fights, t.events]));
  });

  protected readonly activityPoints = computed<ActivityTrendPoint[]>(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return [];
    const max = this.maxActivityValue();
    const leftPad = 55;
    const rightPad = 575;
    const chartWidth = rightPad - leftPad;
    const chartHeight = 160;
    const baseLine = 195;
    const slotWidth = chartWidth / trends.length;
    const barWidth = Math.max(6, Math.min(22, slotWidth * 0.35));

    return trends.map((trend, index) => {
      const centerX = leftPad + slotWidth * index + slotWidth / 2;
      const fightH = Math.max(trend.fights > 0 ? 3 : 0, (trend.fights / max) * chartHeight);
      const eventH = Math.max(trend.events > 0 ? 3 : 0, (trend.events / max) * chartHeight);

      return {
        label: this.formatWeek(trend.week_start),
        fullDate: this.formatFullDate(trend.week_start),
        x: centerX,
        fightX: centerX - barWidth - 2,
        fightY: baseLine - fightH,
        fightHeight: fightH,
        fights: trend.fights,
        eventX: centerX + 2,
        eventY: baseLine - eventH,
        eventHeight: eventH,
        events: trend.events,
        barWidth,
      };
    });
  });

  protected readonly avgWeeklyLoot = computed(() => {
    const trends = this.report()?.trends ?? [];
    if (trends.length === 0) return 0;
    const total = trends.reduce((acc, t) => acc + t.loot_in, 0);
    return Math.round(total / trends.length);
  });

  protected readonly regearCoverageRatio = computed(() => {
    const econ = this.report()?.economy;
    if (!econ || econ.outflow_regear <= 0) return 0;
    const trends = this.report()?.trends ?? [];
    const totalLost = trends.reduce((acc, t) => acc + (t.silver_lost || 0), 0);
    if (totalLost <= 0) return 0;
    return Math.min(100, Math.round((econ.regear_paid / totalLost) * 100));
  });

  constructor() {
    void this.loadFinance();
  }

  protected t = (key: TranslationKey, params?: Record<string, string | number>) => this.translate.t(key, params);

  protected async loadFinance(): Promise<void> {
    this.loading.set(true);
    const [bankResult, reportResult] = await Promise.allSettled([
      firstValueFrom(this.api.get<BankAnalyticsSummary>('api/bank/admin/summary')),
      firstValueFrom(this.api.get<GuildReport>('api/intel/report')),
    ]);
    if (bankResult.status === 'fulfilled') {
      this.summary.set(bankResult.value);
    } else {
      this.summary.set(null);
      this.toasts.error(this.t('common.error'));
    }
    this.report.set(reportResult.status === 'fulfilled' ? reportResult.value : null);
    this.loading.set(false);
  }

  private getLocale(): string {
    const lang = this.translate.language();
    if (lang === 'it') return 'it-IT';
    if (lang === 'es') return 'es-ES';
    return 'en-US';
  }

  protected formatAmount(value: number | string | null | undefined): string {
    const numeric = Number(value ?? 0);
    return new Intl.NumberFormat(this.getLocale(), { maximumFractionDigits: 0 }).format(
      Number.isFinite(numeric) ? numeric : 0,
    );
  }

  protected formatCompact(value: number): string {
    return new Intl.NumberFormat(this.getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }

  private breakdownBars(lines: readonly BankBreakdown[] | undefined): FinanceBar[] {
    return this.makeBars(
      (lines ?? []).slice(0, 6).map((line, index) => ({
        label: line.label,
        value: line.total_amount,
        tone: (['primary', 'success', 'warning', 'neutral'] as const)[index % 4],
      })),
    );
  }

  private makeBars(
    values: ReadonlyArray<{ label: string; value: number | string; tone: FinanceBar['tone'] }>,
  ): FinanceBar[] {
    const normalized = values.map((entry) => ({ ...entry, value: Number(entry.value) || 0 }));
    const max = Math.max(1, ...normalized.map((entry) => Math.abs(entry.value)));
    return normalized.map((entry) => ({ ...entry, width: (Math.abs(entry.value) / max) * 100 }));
  }

  private toSmoothPath(points: readonly FlowTrendPoint[], yKey: 'lootY' | 'outflowY'): string {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x},${points[0][yKey]}`;

    let path = `M ${points[0].x},${points[0][yKey]}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const cpX1 = p0.x + (p1.x - p0.x) / 2;
      const cpY1 = p0[yKey];
      const cpX2 = p0.x + (p1.x - p0.x) / 2;
      const cpY2 = p1[yKey];
      path += ` C ${cpX1},${cpY1} ${cpX2},${cpY2} ${p1.x},${p1[yKey]}`;
    }
    return path;
  }

  private formatWeek(value: TrendBucket['week_start']): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : new Intl.DateTimeFormat(this.getLocale(), { month: 'short', day: 'numeric' }).format(date);
  }

  private formatFullDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(this.getLocale(), { dateStyle: 'medium' }).format(date);
  }
}

