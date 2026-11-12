import {chartHub, type ChartHub} from './hub';
import {listChartAddons, paintChartAddons, type AddonPaintCtx} from './addons';
import type {ChartPersistV1} from './state';

/**
 * 브리지/런타임: 창마다 인스턴스. 허브·애드온·상태 JSON만 연결한다.
 * 멀티차트는 이 팩토리를 종목 수만큼 호출한다.
 */
export type ChartRuntime = {
  id: string;
  hub: ChartHub;
  persist: ChartPersistV1 | null;
  addonIds: () => string[];
  paintAddons: (ctx: AddonPaintCtx) => void;
};

export function createChartRuntime(id: string, persist: ChartPersistV1 | null = null): ChartRuntime {
  return {
    id,
    hub: chartHub,
    persist,
    addonIds: () => listChartAddons().map((a) => a.id),
    paintAddons: paintChartAddons,
  };
}
