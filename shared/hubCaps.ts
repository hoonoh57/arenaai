/**
 * 랩 실측으로 고정한 허브 안전 한도.
 * 수요가 넘으면 허브가 자르거나 캐시로 응답한다. 주문 레인은 REST 총량 1칸을 비워 둔다.
 */
export const HUB_CAPS = {
  restBurst: 10,
  restReserveForOrder: 1,
  chartConcurrency: 4,
  restWaitAbortMs: 5000,
  wssMax: 100,
  wssPacket: 10,
  orderWaitMs: 200,
  signalFlushMs: 80,
  note: '분봉 신규 1장 1.5~12초. 11종목 벽시계 ~14초. REG 재전송=TRNM. 강도는 총량 안 페이징.',
} as const;

export {PROVIDER_SPECS, parseProviderMode} from './marketProvider';
