import type {Candle} from '../../server/core';
import {evaluate, type Formula} from '../formula';

/**
 * 중앙관리자. 시세·수식 계산은 여기만 둔다.
 * 차트 인스턴스·애드온은 캔들 배열을 직접 가공하지 않고 hub를 호출한다.
 */
export type ChartHub = {
  evaluate(expression: string, candles: Candle[], variables?: Record<string, number>, all?: Formula[]): (number | null)[];
};

export const chartHub: ChartHub = {
  evaluate(expression, candles, variables = {}, all = []) {
    return evaluate(expression, candles, variables, all);
  },
};
