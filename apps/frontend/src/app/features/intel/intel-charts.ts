import type { EChartsOption } from 'echarts';

import type { ChartTableRow } from '../../shared/components/chart/chart';
import type { ChartChrome, ChartPalette } from '../../shared/components/chart/chart-theme';

/** One built chart plus its accessible table twin. */
export interface IntelChartBuild {
  readonly option: EChartsOption;
  readonly tableHead: string[];
  readonly tableRows: ChartTableRow[];
}

/** One week on a trend chart. `line` is null when there is nothing to plot that week. */
export interface TrendPoint {
  readonly label: string;
  readonly bar: number;
  readonly line: number | null;
}

export interface TrendChartSpec {
  readonly points: readonly TrendPoint[];
  readonly barName: string;
  readonly lineName: string;
  /** True when the line is a 0..100 percentage. */
  readonly linePercent: boolean;
  readonly weekHeader: string;
  /** Formats a line value for the table twin. */
  readonly formatLine: (value: number | null) => string;
  readonly palette: ChartPalette;
  readonly chrome: ChartChrome;
}

/**
 * Weekly trend: bars for volume, a line for the rate.
 *
 * Gaps stay gaps — a week with no decided fights breaks the line rather than dropping it to 0%.
 */
export function buildTrendChart(spec: TrendChartSpec): IntelChartBuild {
  const { points, palette, chrome } = spec;
  const labels = points.map((point) => point.label);
  const option: EChartsOption = {
    aria: { enabled: true },
    grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
    legend: {
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: chrome.textSecondary, fontSize: 12 },
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: labels, axisLabel: { color: chrome.textMuted, fontSize: 12 } },
    yAxis: [
      {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: chrome.textMuted, fontSize: 12 },
        splitLine: { show: true, lineStyle: { color: chrome.gridline } },
      },
      {
        type: 'value',
        min: 0,
        ...(spec.linePercent ? { max: 100 } : {}),
        axisLabel: {
          color: chrome.textMuted,
          fontSize: 12,
          formatter: spec.linePercent ? '{value}%' : '{value}',
        },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        type: 'bar',
        name: spec.barName,
        data: points.map((point) => point.bar),
        itemStyle: { color: palette.fights, borderRadius: [2, 2, 0, 0] },
        barMaxWidth: 28,
      },
      {
        type: 'line',
        name: spec.lineName,
        yAxisIndex: 1,
        data: points.map((point) => point.line),
        connectNulls: false,
        symbolSize: 6,
        itemStyle: { color: palette.ally },
        lineStyle: { color: palette.ally, width: 2 },
      },
    ],
  };
  return {
    option,
    tableHead: [spec.weekHeader, spec.barName, spec.lineName],
    tableRows: points.map((point) => [point.label, String(point.bar), spec.formatLine(point.line)]),
  };
}
