/**
 * Chart palette and ECharts theme for both colour schemes.
 *
 * The series colours are a *validated* categorical palette: every pair that can
 * appear together in one plot clears the colour-blind separation floor
 * (OKLab ΔE ≥ 8 under protan/deutan/tritan simulation) and the normal-vision
 * floor (ΔE ≥ 15) against this app's two chart surfaces (`#ffffff` light,
 * `#0f1011` dark). Do not re-order or hand-tune these hexes without re-running
 * that validation — the ordering *is* the accessibility mechanism.
 *
 * Slots are assigned to entities, never to rank, so filtering a series out
 * never repaints the survivors:
 *
 * | slot | entity                          |
 * |------|---------------------------------|
 * | 1    | loot in / generic single series |
 * | 2    | member outflow                  |
 * | 3    | regear paid (recovery, aqua)    |
 * | 4    | silver lost (cost, yellow)      |
 * | 6    | events                          |
 * | 7    | fights                          |
 */

/** Semantic series slots. Keys are entity names, not positions. */
export interface ChartPalette {
  readonly lootIn: string;
  readonly outflow: string;
  readonly silverLost: string;
  readonly regearPaid: string;
  readonly events: string;
  readonly fights: string;
  /** Single-series bars and the positive arm of a diverging scale. */
  readonly neutralSeries: string;
  /** Negative arm of a diverging scale (net result below zero). */
  readonly negativeSeries: string;
  /** Combat contexts: "us" — alias of `neutralSeries`, same validated hex. */
  readonly ally: string;
  /** Combat contexts: "them" — alias of `negativeSeries`, same validated hex. */
  readonly enemy: string;
}

const LIGHT_PALETTE: ChartPalette = {
  lootIn: '#2a78d6',
  outflow: '#eb6834',
  silverLost: '#eda100',
  regearPaid: '#1baf7a',
  events: '#008300',
  fights: '#4a3aa7',
  neutralSeries: '#2a78d6',
  negativeSeries: '#e34948',
  ally: '#2a78d6',
  enemy: '#e34948',
};

const DARK_PALETTE: ChartPalette = {
  lootIn: '#3987e5',
  outflow: '#d95926',
  silverLost: '#c98500',
  regearPaid: '#199e70',
  events: '#008300',
  fights: '#9085e9',
  neutralSeries: '#3987e5',
  negativeSeries: '#e66767',
  ally: '#3987e5',
  enemy: '#e66767',
};

/** Chart chrome: the ink and hairlines every plot shares. */
export interface ChartChrome {
  readonly surface: string;
  readonly elevated: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly gridline: string;
  readonly axis: string;
}

const LIGHT_CHROME: ChartChrome = {
  surface: '#ffffff',
  elevated: '#ffffff',
  textPrimary: '#151617',
  textSecondary: '#42464d',
  textMuted: '#62666d',
  gridline: '#e7e9ed',
  axis: '#c6c9cf',
};

const DARK_CHROME: ChartChrome = {
  surface: '#0f1011',
  elevated: '#161718',
  textPrimary: '#ffffff',
  textSecondary: '#d0d6e0',
  textMuted: '#8a8f98',
  gridline: '#1d1f22',
  axis: '#383b3f',
};

export function chartPalette(isDark: boolean): ChartPalette {
  return isDark ? DARK_PALETTE : LIGHT_PALETTE;
}

export function chartChrome(isDark: boolean): ChartChrome {
  return isDark ? DARK_CHROME : LIGHT_CHROME;
}

const FONT_FAMILY =
  'Inter, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

/**
 * ECharts theme object registered per colour scheme.
 *
 * Everything recessive lives here — hairline grid, muted tick labels, quiet
 * tooltip surface — so feature charts only ever describe data and never repeat
 * chrome styling.
 */
export function echartsTheme(isDark: boolean): Record<string, unknown> {
  const chrome = chartChrome(isDark);
  const palette = chartPalette(isDark);

  const axisCommon = {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: chrome.textMuted, fontSize: 11, fontFamily: FONT_FAMILY },
    splitLine: { show: false },
  };

  return {
    color: [
      palette.lootIn,
      palette.outflow,
      palette.silverLost,
      palette.regearPaid,
      palette.events,
      palette.fights,
    ],
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_FAMILY, color: chrome.textSecondary },
    animationDuration: 320,
    title: {
      textStyle: { color: chrome.textPrimary, fontSize: 13, fontWeight: 600 },
      subtextStyle: { color: chrome.textMuted, fontSize: 11 },
    },
    legend: {
      itemWidth: 14,
      itemHeight: 3,
      itemGap: 16,
      icon: 'roundRect',
      textStyle: { color: chrome.textSecondary, fontSize: 11 },
      inactiveColor: chrome.textMuted,
    },
    tooltip: {
      backgroundColor: chrome.elevated,
      borderColor: chrome.axis,
      borderWidth: 1,
      padding: [8, 10],
      extraCssText: 'border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,0.28);',
      textStyle: { color: chrome.textPrimary, fontSize: 12, fontFamily: FONT_FAMILY },
      axisPointer: {
        type: 'line',
        lineStyle: { color: chrome.axis, width: 1 },
        crossStyle: { color: chrome.axis, width: 1 },
        label: { backgroundColor: chrome.elevated, color: chrome.textPrimary, fontSize: 11 },
      },
    },
    categoryAxis: {
      ...axisCommon,
      axisLine: { show: true, lineStyle: { color: chrome.axis, width: 1 } },
    },
    valueAxis: {
      ...axisCommon,
      splitLine: { show: true, lineStyle: { color: chrome.gridline, width: 1, type: 'solid' } },
    },
    logAxis: axisCommon,
    timeAxis: axisCommon,
    dataZoom: {
      borderColor: chrome.gridline,
      backgroundColor: 'transparent',
      fillerColor: isDark ? 'rgba(57,135,229,0.14)' : 'rgba(42,120,214,0.10)',
      handleStyle: { color: chrome.elevated, borderColor: chrome.axis },
      moveHandleStyle: { color: chrome.axis },
      textStyle: { color: chrome.textMuted, fontSize: 10 },
      dataBackground: {
        lineStyle: { color: chrome.axis, opacity: 0.5 },
        areaStyle: { color: chrome.gridline },
      },
      selectedDataBackground: {
        lineStyle: { color: palette.neutralSeries, opacity: 0.7 },
        areaStyle: { color: palette.neutralSeries, opacity: 0.15 },
      },
      emphasis: { handleStyle: { borderColor: palette.neutralSeries } },
    },
  };
}
