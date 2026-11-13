/**
 * 자동매매에 쓰는 키움 REST TR 목록.
 * 창은 이 id로 hub.ask({op:'tr', tr})만 호출. 미배선은 허브가 거절하고 키움으로 안 나간다.
 * 화면번호는 구 HTS. REST는 api-id.
 */
export type HubTrLane = 'read' | 'order';
export type HubTrRow = {
  id: string;
  name: string;
  group: string;
  path: string;
  lane: HubTrLane;
  screen?: string;
  wired: boolean;
  auto: boolean;
  rate: string;
  note: string;
};

export const HUB_TR_CATALOG: HubTrRow[] = [
  {id: 'ka00001', name: '계좌번호조회', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '계좌', wired: false, auto: true, rate: '초당 5', note: '토큰 계좌. 주문 전 잔고 기준'},
  {id: 'kt00001', name: '예수금상세현황', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '예수금', wired: false, auto: true, rate: '초당 5', note: '주문가능금액'},
  {id: 'kt00004', name: '계좌평가현황', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '잔고', wired: false, auto: true, rate: '초당 5', note: '보유·평가'},
  {id: 'kt00005', name: '체결잔고요청', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '잔고', wired: false, auto: true, rate: '초당 5', note: '실잔고 동기'},
  {id: 'ka10075', name: '미체결요청', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '미체결', wired: false, auto: true, rate: '초당 5', note: '미체결 복원'},
  {id: 'ka10076', name: '체결요청', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '체결', wired: false, auto: true, rate: '초당 5', note: '당일 체결'},
  {id: 'ka10077', name: '당일실현손익상세', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '손익', wired: false, auto: false, rate: '초당 5', note: '성과'},
  {id: 'ka10085', name: '계좌수익률', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '수익률', wired: false, auto: false, rate: '초당 5', note: ''},
  {id: 'ka01690', name: '일별잔고수익률', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '일별', wired: false, auto: false, rate: '초당 5', note: ''},
  {id: 'kt00007', name: '계좌별주문체결내역상세', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '체결내역', wired: false, auto: true, rate: '초당 5', note: ''},
  {id: 'kt00009', name: '계좌별주문체결현황', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '체결현황', wired: false, auto: true, rate: '초당 5', note: ''},
  {id: 'ka10170', name: '당일매매일지', group: '계좌', path: '/api/dostk/acnt', lane: 'read', screen: '매매일지', wired: false, auto: false, rate: '초당 5', note: ''},
  {id: 'kt10000', name: '매수주문', group: '주문', path: '/api/dostk/ordr', lane: 'order', screen: '주문', wired: true, auto: true, rate: '주문레인', note: '모의만. 실전 전송 안 함'},
  {id: 'kt10001', name: '매도주문', group: '주문', path: '/api/dostk/ordr', lane: 'order', screen: '주문', wired: true, auto: true, rate: '주문레인', note: '모의만'},
  {id: 'kt10002', name: '정정주문', group: '주문', path: '/api/dostk/ordr', lane: 'order', screen: '정정', wired: false, auto: true, rate: '주문레인', note: '미체결 정정'},
  {id: 'kt10003', name: '취소주문', group: '주문', path: '/api/dostk/ordr', lane: 'order', screen: '취소', wired: true, auto: true, rate: '주문레인', note: '모의 취소'},
  {id: 'ka10080', name: '분봉차트', group: '차트', path: '/api/dostk/chart', lane: 'read', screen: '차트', wired: true, auto: true, rate: '총량', note: '한 페이지 reverse. ask chart'},
  {id: 'ka10081', name: '일봉차트', group: '차트', path: '/api/dostk/chart', lane: 'read', screen: '차트', wired: true, auto: false, rate: '총량', note: 'ask chart timeframe D'},
  {id: 'ka10079', name: '틱차트', group: '차트', path: '/api/dostk/chart', lane: 'read', screen: '틱', wired: true, auto: false, rate: '총량', note: '한 페이지'},
  {id: 'ka10001', name: '주식기본정보', group: '종목', path: '/api/dostk/stkinfo', lane: 'read', screen: '종목정보', wired: true, auto: true, rate: '총량', note: 'ask name'},
  {id: 'ka10046', name: '체결강도추이(분)', group: '시세', path: '/api/dostk/mrkcond', lane: 'read', screen: '강도', wired: true, auto: true, rate: '총량', note: 'ask strength. 08:30부터'},
  {id: 'ka10047', name: '체결강도추이(일)', group: '시세', path: '/api/dostk/mrkcond', lane: 'read', screen: '강도', wired: true, auto: false, rate: '총량', note: ''},
  {id: 'ka10171', name: '조건검색 목록', group: '조건', path: 'WSS CNSRLST', lane: 'read', screen: '0150', wired: true, auto: true, rate: 'WSS', note: 'bridge.loadConditions'},
  {id: 'ka10172', name: '조건검색 요청', group: '조건', path: 'WSS CNSRREQ', lane: 'read', screen: '0150', wired: true, auto: true, rate: 'WSS', note: '포착'},
  {id: 'ka10173', name: '조건검색 실시간', group: '조건', path: 'WSS', lane: 'read', screen: '0150', wired: true, auto: true, rate: 'WSS', note: '삽입삭제'},
  {id: '0B', name: '주식체결 실시간', group: '실시간', path: 'WSS REG', lane: 'read', screen: '실시간', wired: true, auto: true, rate: '구독100', note: 'ask watch'},
];

export const HUB_TR_SCREENS = [
  {screen: '0150', name: '조건검색', tr: ['ka10171', 'ka10172', 'ka10173']},
  {screen: '차트', name: '분·일·틱', tr: ['ka10080', 'ka10081', 'ka10079']},
  {screen: '강도', name: '체결강도', tr: ['ka10046', 'ka10047']},
  {screen: '잔고', name: '계좌평가·체결잔고', tr: ['kt00004', 'kt00005']},
  {screen: '미체결', name: '미체결', tr: ['ka10075']},
  {screen: '체결', name: '당일체결', tr: ['ka10076', 'kt00007', 'kt00009']},
  {screen: '주문', name: '매수·매도·취소', tr: ['kt10000', 'kt10001', 'kt10002', 'kt10003']},
  {screen: '예수금', name: '주문가능', tr: ['kt00001']},
  {screen: '실시간', name: '0B 체결', tr: ['0B']},
];
