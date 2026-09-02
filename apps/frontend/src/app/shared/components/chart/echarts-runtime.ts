/**
 * Browser-only ECharts runtime, registered once with only the pieces this app
 * draws.
 *
 * Kept in its own module so `Chart` can `await import('./echarts-runtime')`:
 * the named imports below stay static, which is what lets the bundler drop the
 * ~70% of ECharts (map, graph, tree, sankey, 3D…) nothing here uses, and the
 * whole chunk stays out of the SSR build and off the critical path.
 */
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { init, registerTheme, use } from 'echarts/core';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

import { echartsTheme } from './chart-theme';

export const DARK_THEME_NAME = 'weaklings-dark';
export const LIGHT_THEME_NAME = 'weaklings-light';

let registered = false;

/** Registers charts, components and both themes. Idempotent. */
export function setupECharts(): void {
  if (registered) {
    return;
  }
  use([
    BarChart,
    LineChart,
    PieChart,
    ScatterChart,
    AriaComponent,
    DataZoomComponent,
    GridComponent,
    LegendComponent,
    MarkLineComponent,
    TooltipComponent,
    LabelLayout,
    CanvasRenderer,
  ]);
  registerTheme(DARK_THEME_NAME, echartsTheme(true));
  registerTheme(LIGHT_THEME_NAME, echartsTheme(false));
  registered = true;
}

export { init };
