/**
 * 차트 코어: 봉·시간축·십자선만. 지표·그리기·패턴은 모른다.
 * 애드온이 0개여도 이 모듈만으로 캔들 호스트를 띄울 수 있다.
 */
export type ChartCoreOpts = {
  magnet: boolean;
  grid: boolean;
  percent: boolean;
};

export function coreCrosshairMode(magnet: boolean): 'magnet' | 'normal' {
  return magnet ? 'magnet' : 'normal';
}

export function corePercent(px: number, ref: number, on: boolean): number {
  if (!on || !(ref > 0)) return px;
  return 100 * (px / ref - 1);
}
