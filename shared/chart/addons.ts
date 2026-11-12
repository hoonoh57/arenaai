/** 애드온 레지스트리. 수십 개를 넣거나 빼도 코어 페인트는 그대로 돈다. */
export type AddonPaintCtx = {
  bars: {time: number; open: number; high: number; low: number; close: number}[];
  formulas: unknown[];
  paneById?: Record<string, number>;
};

export type ChartAddon = {
  id: string;
  paint?: (ctx: AddonPaintCtx) => void;
};

const registry = new Map<string, ChartAddon>();

export function registerChartAddon(addon: ChartAddon): void {
  if (!addon?.id) return;
  registry.set(addon.id, addon);
}

export function unregisterChartAddon(id: string): void {
  registry.delete(id);
}

export function listChartAddons(): ChartAddon[] {
  return [...registry.values()];
}

export function paintChartAddons(ctx: AddonPaintCtx): void {
  for (const addon of registry.values()) {
    try {
      addon.paint?.(ctx);
    } catch {
      /* 애드온 실패가 코어를 죽이지 않음 */
    }
  }
}
