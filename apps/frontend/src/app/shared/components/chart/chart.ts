import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { EChartsOption } from 'echarts';

import { ThemeService } from '../../../core/services/theme.service';
import { TranslateService } from '../../../core/services/translate.service';
import type { TranslationKey } from '../../../i18n/en';

/** One row of the accessible table twin rendered under a chart. */
export type ChartTableRow = readonly string[];

/** Payload of a click on a chart data point, as ECharts reports it. */
export interface ChartClickEvent {
  readonly dataIndex: number;
  readonly seriesName?: string;
  readonly name?: string;
  readonly value: unknown;
}

type EChartsInstance = {
  setOption(option: EChartsOption, opts?: { notMerge?: boolean; lazyUpdate?: boolean }): void;
  resize(): void;
  dispose(): void;
  on(event: 'click', handler: (params: ChartClickEvent) => void): void;
};

/**
 * ECharts host: one canvas, one option object, both colour schemes.
 *
 * Charts are a browser-only concern — the library touches `canvas` and
 * `ResizeObserver`, and shipping it through the Analog SSR pass would only
 * cost bytes on a route that is auth-gated anyway. So the runtime is imported
 * lazily inside `afterNextRender`, and the server render emits just the
 * container plus the table twin below it.
 *
 * Every chart ships that table twin (`tableHead` / `tableRows`): a tooltip is
 * an enhancement, never the only way to read a value, and a `<details>` table
 * is the WCAG-clean equivalent for screen readers, keyboard users and anyone
 * who wants the raw figures.
 *
 * @example
 * ```html
 * <app-chart [option]="flowOption()" height="19rem" [label]="t('...')"
 *            [tableHead]="flowHead()" [tableRows]="flowRows()" />
 * ```
 */
@Component({
  selector: 'app-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      min-inline-size: 0;
    }
    .chart__canvas {
      inline-size: 100%;
    }
    .chart__canvas--stale {
      opacity: 0.45;
      transition: opacity 0.15s ease;
    }
    .chart__fallback {
      display: grid;
      place-items: center;
      block-size: 100%;
      color: var(--color-text-tertiary);
      font-size: 0.75rem;
    }
    .chart__table-toggle {
      margin-block-start: 0.5rem;
    }
    .chart__table-toggle > summary {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.25rem;
      border-radius: 4px;
      color: var(--color-text-tertiary);
      cursor: pointer;
      font-size: 0.6875rem;
      font-weight: 500;
      list-style: none;
    }
    .chart__table-toggle > summary::-webkit-details-marker {
      display: none;
    }
    .chart__table-toggle > summary::before {
      content: '▸';
      font-size: 0.625rem;
      transition: transform 0.15s ease;
    }
    .chart__table-toggle[open] > summary::before {
      transform: rotate(90deg);
    }
    .chart__table-toggle > summary:hover {
      color: var(--color-text-secondary);
    }
    .chart__table-toggle > summary:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }
    .chart__table-scroll {
      max-block-size: 15rem;
      margin-block-start: 0.5rem;
      overflow: auto;
      border: 1px solid var(--color-border);
      border-radius: 6px;
    }
    .chart__table {
      inline-size: 100%;
      border-collapse: collapse;
      font-size: 0.6875rem;
    }
    .chart__table th,
    .chart__table td {
      padding: 0.3125rem 0.5rem;
      border-block-end: 1px solid var(--color-border);
      text-align: end;
      white-space: nowrap;
    }
    .chart__table th:first-child,
    .chart__table td:first-child {
      text-align: start;
    }
    .chart__table thead th {
      position: sticky;
      inset-block-start: 0;
      background: var(--color-surface-2);
      color: var(--color-text-tertiary);
      font-weight: 600;
    }
    .chart__table td {
      color: var(--color-text-secondary);
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
    }
    .chart__table td:first-child {
      color: var(--color-text);
      font-family: var(--font-sans);
    }
    .chart__table tbody tr:last-child td {
      border-block-end: 0;
    }
  `,
  template: `
    <div
      #host
      class="chart__canvas"
      [class.chart__canvas--stale]="stale()"
      [style.block-size]="height()"
      role="img"
      [attr.aria-label]="label()"
    >
      @if (!ready()) {
        <p class="chart__fallback">{{ failed() ? t('common.error') : t('common.loading') }}</p>
      }
    </div>

    @if (tableRows().length > 0) {
      <details class="chart__table-toggle">
        <summary>{{ t('chart.viewData') }}</summary>
        <div class="chart__table-scroll">
          <table class="chart__table">
            <caption class="sr-only">
              {{
                label()
              }}
            </caption>
            <thead>
              <tr>
                @for (head of tableHead(); track $index) {
                  <th scope="col">{{ head }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of tableRows(); track $index) {
                <tr>
                  @for (cell of row; track $index) {
                    @if ($index === 0) {
                      <th scope="row" style="font-weight: 500; color: var(--color-text)">
                        {{ cell }}
                      </th>
                    } @else {
                      <td>{{ cell }}</td>
                    }
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      </details>
    }
  `,
})
export class Chart {
  private readonly theme = inject(ThemeService);
  private readonly translate = inject(TranslateService);

  /** Full ECharts option. Chrome (grid, axes, tooltip) comes from the theme. */
  readonly option = input.required<EChartsOption>();

  /** Plot height, including the x-axis band so labels are never clipped. */
  readonly height = input('18rem');

  /** Accessible name for the plot; also the caption of the table twin. */
  readonly label = input.required<string>();

  /** Column headers of the table twin. */
  readonly tableHead = input<readonly string[]>([]);

  /** Rows of the table twin. Leave empty only for charts with no tabular form. */
  readonly tableRows = input<readonly ChartTableRow[]>([]);

  /** Dims the current render during a refetch instead of flashing a skeleton. */
  readonly stale = input(false);

  /** Fires on a click on a chart data point. Opt-in — most charts are read-only. */
  readonly chartClick = output<ChartClickEvent>();

  protected readonly ready = signal(false);
  protected readonly failed = signal(false);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private instance: EChartsInstance | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;
  private activeTheme: string | null = null;

  protected readonly t = (key: TranslationKey): string => this.translate.t(key);

  constructor() {
    afterNextRender(() => void this.boot());

    effect(() => {
      // Track both so a data change and a colour-scheme change both land.
      const option = this.option();
      const isDark = this.theme.isDark();
      if (this.instance) {
        void this.render(option, isDark);
      }
    });

    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.instance?.dispose();
      this.instance = null;
    });
  }

  private async boot(): Promise<void> {
    try {
      await this.render(this.option(), this.theme.isDark());
      if (this.destroyed) {
        return;
      }
      this.resizeObserver = new ResizeObserver(() => this.instance?.resize());
      this.resizeObserver.observe(this.host().nativeElement);
      this.ready.set(true);
    } catch {
      this.failed.set(true);
    }
  }

  /**
   * Applies an option, re-creating the instance when the colour scheme flipped.
   * ECharts bakes the theme in at `init`, so a scheme change is a dispose and
   * a fresh init rather than a `setOption`.
   */
  private async render(option: EChartsOption, isDark: boolean): Promise<void> {
    const runtime = await import('./echarts-runtime');
    if (this.destroyed) {
      return;
    }
    runtime.setupECharts();
    const themeName = isDark ? runtime.DARK_THEME_NAME : runtime.LIGHT_THEME_NAME;

    if (this.instance && themeName !== this.activeTheme) {
      this.instance.dispose();
      this.instance = null;
    }
    if (!this.instance) {
      this.activeTheme = themeName;
      this.instance = runtime.init(this.host().nativeElement, themeName, {
        renderer: 'canvas',
      }) as unknown as EChartsInstance;
      this.instance.on('click', (params) => this.chartClick.emit(params));
    }
    this.instance.setOption(option, { notMerge: true });
  }
}
