import type { EChartsOption } from 'echarts';

import type { HourBucket, TrendBucket } from '../../core/models/api.models';
import type { TranslationKey } from '../../i18n/en';
import type { ChartTableRow } from '../components/chart/chart';
import type { ChartChrome, ChartPalette } from '../components/chart/chart-theme';

/**
 * Pure `EChartsOption` builders for the `GuildReport`'s time-series slices.
 *
 * Kept independent of any component: every function takes its data, the
 * active theme's `ChartPalette`/`ChartChrome`, and a translate function, and
 * returns both the chart option and its accessible table twin — the two
 * always derive from the same rows, so bundling them keeps a call site from
 * ever building one without the other (see `Chart`'s `tableHead`/`tableRows`
 * contract in `chart.ts`).
 *
 * Self-contained rather than shared with `admin-finance.ts`: that page's own
 * `flowOption`/`netOption`/`lossRegearOption`/`activityOption` builders are
 * bound instance methods that read `this.t()` through a locale-aware
 * `TranslateService` and already ship their own table-twin computeds. Lifting
 * them into pure functions would mean either dropping locale-aware number
 * formatting (a real behaviour change on a live page) or growing this
 * module's signature well past what a "pure builder" should take. The
 * grid/tooltip/area-fill *style* below is deliberately modelled on that
 * file's helpers so both pages read as one system.
 */

/** One built chart: the option ECharts renders, plus its table twin. */
export interface ChartBuild {
  readonly option: EChartsOption;
  readonly tableHead: string[];
  readonly tableRows: ChartTableRow[];
}

/** Matches `TranslateService#t`'s signature without importing the service. */
export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function fmt(value: number): string {
  return numberFormat.format(Number.isFinite(value) ? value : 0);
}

function fmtCompact(value: number): string {
  return compactFormat.format(Number.isFinite(value) ? value : 0);
}

function weekLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

/** Minimal shape of an ECharts tooltip callback payload. */
interface TooltipParam {
  readonly seriesName?: string;
  readonly name?: string;
  readonly axisValueLabel?: string;
  readonly value?: unknown;
  readonly color?: string;
}

function toParamList(input: unknown): TooltipParam[] {
  return Array.isArray(input) ? (input as TooltipParam[]) : [input as TooltipParam];
}

/** Series and category names ultimately come from the API — never interpolate raw. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

/** Shared axis/grid skeleton so every plot in this module lines up the same way. */
function baseGrid(bottom = 8): EChartsOption['grid'] {
  return { left: 4, right: 12, top: 32, bottom, containLabel: true };
}

function valueAxisLabel(): Record<string, unknown> {
  return { formatter: (value: number) => fmtCompact(value), hideOverlap: true };
}

/** Axis tooltip listing every series at the hovered point, value first. */
function axisTooltip(): Record<string, unknown> {
  return {
    trigger: 'axis',
    axisPointer: { type: 'line' },
    formatter: (input: unknown) => {
      const params = toParamList(input);
      const header = escapeHtml(params[0]?.axisValueLabel ?? params[0]?.name ?? '');
      const rows = params
        .map((param) => {
          const value = fmt(toNumber(param.value));
          const key = `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${
            param.color ?? 'currentColor'
          };vertical-align:middle;margin-inline-end:6px"></span>`;
          return `<div style="display:flex;align-items:center;gap:12px;justify-content:space-between;margin-top:3px">
            <span style="opacity:0.75">${key}${escapeHtml(param.seriesName ?? '')}</span>
            <strong style="font-variant-numeric:tabular-nums">${escapeHtml(value)}</strong>
          </div>`;
        })
        .join('');
      return `<div style="font-size:11px;opacity:0.7;margin-bottom:2px">${header}</div>${rows}`;
    },
  };
}

/** Vertical gradient under a line, fading to nothing at the baseline. */
function areaFill(color: string): Record<string, unknown> {
  return {
    color: {
      type: 'linear',
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: `${color}3d` },
        { offset: 1, color: `${color}00` },
      ],
    },
  };
}

function lineMarker(color: string, chrome: ChartChrome): Record<string, unknown> {
  return { color, borderColor: chrome.surface, borderWidth: 2 };
}

/**
 * Weekly fights/kills/deaths, oldest week first.
 *
 * Fights render as bars (a count of *events*, not a rate) while kills/deaths
 * share the ally/enemy diverging pair so the "are we winning the exchange"
 * read is immediate — the same framing `admin-finance.ts`'s `netOption` uses
 * for silver, applied here to combat.
 */
export function buildCombatTrendsChart(
  trends: readonly TrendBucket[],
  palette: ChartPalette,
  chrome: ChartChrome,
  t: Translate,
): ChartBuild {
  const labels = trends.map((bucket) => weekLabel(bucket.week_start));

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: baseGrid(8),
    legend: { top: 0, left: 0 },
    tooltip: axisTooltip(),
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value', axisLabel: valueAxisLabel(), minInterval: 1 },
    series: [
      {
        name: t('guild.charts.fights'),
        type: 'bar',
        data: trends.map((bucket) => bucket.fights),
        itemStyle: { color: palette.fights, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 22,
      },
      {
        name: t('battles.kills'),
        type: 'line',
        data: trends.map((bucket) => bucket.kills),
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color: palette.ally },
        itemStyle: lineMarker(palette.ally, chrome),
        emphasis: { focus: 'series' },
      },
      {
        name: t('battles.deaths'),
        type: 'line',
        data: trends.map((bucket) => bucket.deaths),
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color: palette.enemy },
        itemStyle: lineMarker(palette.enemy, chrome),
        emphasis: { focus: 'series' },
      },
    ],
  };

  const tableHead = [t('guild.charts.week'), t('guild.charts.fights'), t('battles.kills'), t('battles.deaths')];
  const tableRows: ChartTableRow[] = trends.map((bucket) => [
    weekLabel(bucket.week_start),
    fmt(bucket.fights),
    fmt(bucket.kills),
    fmt(bucket.deaths),
  ]);

  return { option, tableHead, tableRows };
}

/**
 * Weekly silver created against member outflow.
 *
 * Same two-line-with-area-fill shape as `admin-finance.ts`'s `flowOption`,
 * reused here for the guild page's economy summary tab.
 */
export function buildEconomyFlowChart(
  trends: readonly TrendBucket[],
  palette: ChartPalette,
  chrome: ChartChrome,
  t: Translate,
): ChartBuild {
  const labels = trends.map((bucket) => weekLabel(bucket.week_start));

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: baseGrid(8),
    legend: { top: 0, left: 0 },
    tooltip: axisTooltip(),
    xAxis: { type: 'category', boundaryGap: false, data: labels },
    yAxis: { type: 'value', axisLabel: valueAxisLabel() },
    series: [
      {
        name: t('bank.finance.lootCreated'),
        type: 'line',
        data: trends.map((bucket) => bucket.loot_in),
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color: palette.lootIn },
        itemStyle: lineMarker(palette.lootIn, chrome),
        areaStyle: areaFill(palette.lootIn),
        emphasis: { focus: 'series' },
      },
      {
        name: t('bank.finance.memberOutflow'),
        type: 'line',
        data: trends.map((bucket) => bucket.outflow),
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color: palette.outflow },
        itemStyle: lineMarker(palette.outflow, chrome),
        areaStyle: areaFill(palette.outflow),
        emphasis: { focus: 'series' },
      },
    ],
  };

  const tableHead = [
    t('guild.charts.week'),
    t('bank.finance.lootCreated'),
    t('bank.finance.memberOutflow'),
    t('guild.charts.net'),
  ];
  const tableRows: ChartTableRow[] = trends.map((bucket) => [
    weekLabel(bucket.week_start),
    fmt(bucket.loot_in),
    fmt(bucket.outflow),
    fmt(bucket.loot_in - bucket.outflow),
  ]);

  return { option, tableHead, tableRows };
}

/** Weekly combat losses against regear reimbursement. */
export function buildLossRegearChart(
  trends: readonly TrendBucket[],
  palette: ChartPalette,
  t: Translate,
): ChartBuild {
  const labels = trends.map((bucket) => weekLabel(bucket.week_start));

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: baseGrid(8),
    legend: { top: 0, left: 0 },
    tooltip: axisTooltip(),
    xAxis: { type: 'category', data: labels },
    yAxis: { type: 'value', axisLabel: valueAxisLabel() },
    series: [
      {
        name: t('bank.finance.silverLost'),
        type: 'bar',
        data: trends.map((bucket) => Math.abs(bucket.silver_lost || 0)),
        itemStyle: { color: palette.silverLost, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 18,
        barGap: '18%',
        barCategoryGap: '40%',
      },
      {
        name: t('bank.finance.regearPaid'),
        type: 'bar',
        data: trends.map((bucket) => Math.abs(bucket.regear_paid || 0)),
        itemStyle: { color: palette.regearPaid, borderRadius: [4, 4, 0, 0] },
        barMaxWidth: 18,
      },
    ],
  };

  const tableHead = [t('guild.charts.week'), t('bank.finance.silverLost'), t('bank.finance.regearPaid')];
  const tableRows: ChartTableRow[] = trends.map((bucket) => [
    weekLabel(bucket.week_start),
    fmt(Math.abs(bucket.silver_lost || 0)),
    fmt(Math.abs(bucket.regear_paid || 0)),
  ]);

  return { option, tableHead, tableRows };
}

/**
 * Fights by hour of day (0-23, UTC as reported by the backend), wins and
 * losses stacked so the bar height reads as total fights while the split
 * still shows the ally/enemy outcome mix at that hour.
 */
export function buildHoursActivityChart(
  hours: readonly HourBucket[],
  palette: ChartPalette,
  t: Translate,
): ChartBuild {
  // The backend returns whatever hours had activity; fill the missing ones so
  // the x-axis is always a complete 0-23 day instead of a sparse, misleading one.
  const byHour = new Map(hours.map((bucket) => [bucket.hour, bucket]));
  const full: HourBucket[] = Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? {
    hour,
    fights: 0,
    wins: 0,
    losses: 0,
  });

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: baseGrid(8),
    legend: { top: 0, left: 0 },
    tooltip: axisTooltip(),
    xAxis: {
      type: 'category',
      data: full.map((bucket) => `${bucket.hour}h`),
    },
    yAxis: { type: 'value', axisLabel: valueAxisLabel(), minInterval: 1 },
    series: [
      {
        name: t('events.detail.wins'),
        type: 'bar',
        stack: 'fights',
        data: full.map((bucket) => bucket.wins),
        itemStyle: { color: palette.ally },
        barMaxWidth: 16,
      },
      {
        name: t('events.detail.losses'),
        type: 'bar',
        stack: 'fights',
        data: full.map((bucket) => bucket.losses),
        itemStyle: { color: palette.enemy },
        barMaxWidth: 16,
      },
    ],
  };

  const tableHead = [
    t('guild.charts.hour'),
    t('guild.charts.fights'),
    t('events.detail.wins'),
    t('events.detail.losses'),
  ];
  const tableRows: ChartTableRow[] = full.map((bucket) => [
    `${bucket.hour}h`,
    fmt(bucket.fights),
    fmt(bucket.wins),
    fmt(bucket.losses),
  ]);

  return { option, tableHead, tableRows };
}

/** One category folded into a horizontal-bar-friendly `{ label, value }` row. */
export interface WeaponShareRow {
  readonly label: string;
  readonly value: number;
}

/**
 * Top-N weapons by usage count, with the remainder folded into one "Other"
 * bucket — keeps the series count sane no matter how many distinct weapons
 * a report window saw.
 */
export function topWeaponRows(
  weapons: ReadonlyArray<{ weapon: string; count: number }>,
  t: Translate,
  limit = 6,
): WeaponShareRow[] {
  const sorted = [...weapons].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, limit).map((w) => ({ label: w.weapon, value: w.count }));
  const restTotal = sorted.slice(limit).reduce((sum, w) => sum + w.count, 0);
  return restTotal > 0 ? [...top, { label: t('guild.charts.other'), value: restTotal }] : top;
}

/**
 * Horizontal single-series bars for a nominal breakdown (weapon meta, role
 * fill, etc.) — one series, one colour, largest at the top.
 */
export function buildHorizontalBarsChart(
  rows: readonly WeaponShareRow[],
  color: string,
  tableHead: readonly [string, string],
): ChartBuild {
  const ordered = [...rows].sort((a, b) => a.value - b.value);
  const total = ordered.reduce((sum, row) => sum + row.value, 0);

  const option: EChartsOption = {
    aria: { enabled: true },
    grid: { left: 4, right: 56, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (input: unknown) => {
        const param = toParamList(input)[0];
        const raw = toNumber(param?.value);
        const share = total > 0 ? Math.round((raw / total) * 1000) / 10 : 0;
        return `<div style="font-size:11px;opacity:0.7;margin-bottom:2px">${escapeHtml(
          param?.name ?? '',
        )}</div><strong style="font-variant-numeric:tabular-nums">${escapeHtml(
          fmt(raw),
        )}</strong> <span style="opacity:0.6">· ${share}%</span>`;
      },
    },
    xAxis: { type: 'value', splitNumber: 3, axisLabel: valueAxisLabel(), splitLine: { show: true } },
    yAxis: { type: 'category', data: ordered.map((row) => row.label), axisLabel: { width: 110, overflow: 'truncate' } },
    series: [
      {
        type: 'bar',
        data: ordered.map((row) => row.value),
        itemStyle: { color, borderRadius: [0, 4, 4, 0] },
        barMaxWidth: 16,
        barCategoryGap: '42%',
        label: {
          show: true,
          position: 'right',
          distance: 8,
          formatter: (param: { value?: unknown }) => fmtCompact(toNumber(param.value)),
          fontSize: 11,
        },
      },
    ],
  };

  const tableRows: ChartTableRow[] = [...ordered].reverse().map((row) => [row.label, fmt(row.value)]);

  return { option, tableHead: [...tableHead], tableRows };
}
