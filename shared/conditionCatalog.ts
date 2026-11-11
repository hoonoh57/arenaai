/** 키움 [0150] 조건검색 분류(공식 도움말: 시세·기술적·패턴·재무·순위). 로컬 일/분봉으로 평가 가능한 항목. */
export const CONDITION_CATALOG = [
  {id: 'price', group: '시세분석>가격조건', name: '주가범위(종가)', expression: 'INRANGE(CLOSE, 1000, 500000)', hint: '0봉전 종가 범위'},
  {id: 'chg', group: '시세분석>가격조건', name: '주가등락률 종가대비', expression: 'ROC(CLOSE, 1) >= 2', hint: '1봉전 종가대비 0봉전 종가'},
  {id: 'openchg', group: '시세분석>가격조건', name: '주가등락률 시가대비', expression: '(CLOSE - OPEN) / OPEN * 100 >= 5.5', hint: '0봉전 시가대비 종가'},
  {id: 'hlrate', group: '시세분석>가격조건', name: '기간내 등락률 저가대비고가', expression: 'HLRATE(10) >= 20', hint: 'n봉 저가대비 고가 %'},
  {id: 'newhigh', group: '시세분석>가격조건', name: '신고가 근접', expression: 'NEARHIGH(5, 1, 1)', hint: '1봉전 고가가 n봉 신고가에 pct% 이내'},
  {id: 'upbars', group: '시세분석>가격조건', name: '기간내 양봉수', expression: 'UPBARS(10) >= 6', hint: 'n봉 중 종>시'},
  {id: 'vol', group: '시세분석>거래량/거래대금', name: '거래량', expression: 'VOLUME >= 2000000', hint: '0봉전 거래량'},
  {id: 'value', group: '시세분석>거래량/거래대금', name: '거래대금(원)', expression: 'ACCOUNT >= 10000000000', hint: '없으면 거래량×종가. 키움 일:백만은 ×1e6'},
  {id: 'strength', group: '시세분석>체결강도', name: '체결강도', expression: 'STRENGTH >= 120', hint: '로컬 봉에 strength 필드 필요'},
  {id: 'maarr', group: '기술적분석>주가이동평균', name: '이평 정배열 5>20>60', expression: 'SMA(CLOSE, 5) > SMA(CLOSE, 20) AND SMA(CLOSE, 20) > SMA(CLOSE, 60)', hint: '0봉전'},
  {id: 'golden', group: '기술적분석>주가이동평균', name: '골든크로스 5/20', expression: 'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))', hint: '상향돌파'},
  {id: 'dead', group: '기술적분석>주가이동평균', name: '데드크로스 5/20', expression: 'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))', hint: '하향돌파'},
  {id: 'disparity', group: '기술적분석>이동평균이격도', name: '이격도 20', expression: 'DISPARITY(CLOSE, 20) >= 102', hint: '종가/이평×100'},
  {id: 'mom', group: '기술적분석>모멘텀', name: 'Momentum', expression: 'MOM(CLOSE, 50) >= 95', hint: '60분봉은 스캔 주기를 60으로'},
  {id: 'rsi', group: '기술적분석>RSI', name: 'RSI', expression: 'RSI(CLOSE, 14) >= 70', hint: ''},
  {id: 'bb', group: '기술적분석>Bollinger Band', name: '볼린저 상단 근접', expression: 'CLOSE >= BBUPPER(CLOSE, 20, 2) * 0.99', hint: ''},
  {id: 'macd', group: '기술적분석>MACD', name: 'MACD 골든', expression: 'CROSSUP(EMA(CLOSE, 12) - EMA(CLOSE, 26), EMA(EMA(CLOSE, 12) - EMA(CLOSE, 26), 9))', hint: ''},
  {id: 'stoch', group: '기술적분석>Stochastic', name: '스토캐 과매수', expression: 'STOCHK(5) >= 80', hint: ''},
];

/** 화면의 5%_기존버전에서 로컬 봉으로 평가 가능한 핵심 조합 */
export const SAMPLE_0150 =
  '(HLRATE(10) >= 20 AND (NEARHIGH(5, 1, 1) OR NEARHIGH(5, 5, 1)) AND ROC(CLOSE, 1) >= 2 AND INRANGE(CLOSE, 1000, 500000)) OR (((CLOSE - OPEN) / OPEN * 100 >= 5.5 OR ACCOUNT >= 10000000000) AND INRANGE(CLOSE, 1000, 500000) AND VOLUME >= 2000000)';
