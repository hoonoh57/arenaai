/** 키움 [0150] 분류. 로컬 일/분봉으로 평가 가능한 항목. */
export type ConditionItem = {
  id: string;
  group: string;
  name: string;
  expression: string;
  hint: string;
  example: string;
};

export const CONDITION_CATALOG: ConditionItem[] = [
  {id: 'price', group: '시세분석>가격조건', name: '주가범위(종가)', expression: 'INRANGE(CLOSE, 1000, 500000)', hint: '종가가 하한~상한(원).', example: 'INRANGE(CLOSE, 5000, 100000)  → 5천원~10만원'},
  {id: 'chg', group: '시세분석>가격조건', name: '주가등락률 종가대비', expression: 'ROC(CLOSE, 1) >= 2', hint: '1봉전 종가 대비 등락률(%).', example: 'ROC(CLOSE, 1) >= 3  → 전봉 대비 +3% 이상'},
  {id: 'openchg', group: '시세분석>가격조건', name: '주가등락률 시가대비', expression: '(CLOSE - OPEN) / OPEN * 100 >= 5.5', hint: '당봉 시가 대비 종가 %.', example: '(CLOSE-OPEN)/OPEN*100 >= 3  → 시가 대비 +3%'},
  {id: 'hlrate', group: '시세분석>가격조건', name: '기간내 등락률 저가대비고가', expression: 'HLRATE(10) >= 20', hint: 'n봉 최저가 대비 최고가 %.', example: 'HLRATE(5) >= 10  → 5봉 저가 대비 고가 10%↑'},
  {id: 'newhigh', group: '시세분석>가격조건', name: '신고가 근접', expression: 'NEARHIGH(5, 1, 1)', hint: 'NEARHIGH(기간, 몇봉전고가, 허용%).', example: 'NEARHIGH(20, 0, 1)  → 당봉 고가가 20봉 신고가 1% 이내'},
  {id: 'upbars', group: '시세분석>가격조건', name: '기간내 양봉수', expression: 'UPBARS(10) >= 6', hint: 'n봉 중 종가>시가 개수.', example: 'UPBARS(5) >= 4  → 최근 5봉 중 양봉 4개 이상'},
  {id: 'vol', group: '시세분석>거래량/거래대금', name: '거래량', expression: 'VOLUME >= 2000000', hint: '당봉 거래량(주).', example: 'VOLUME >= 1000000  → 100만주 이상'},
  {id: 'value', group: '시세분석>거래량/거래대금', name: '거래대금(원)', expression: 'ACCOUNT >= 10000000000', hint: '로컬은 거래량×종가. 시총 아님.', example: 'ACCOUNT >= 5000000000  → 약 50억원 이상'},
  {id: 'strength', group: '시세분석>체결강도', name: '체결강도', expression: 'STRENGTH >= 120', hint: '봉 CSV에 strength 열이 있을 때만.', example: 'STRENGTH >= 150  → 체결강도 150 이상'},
  {id: 'maarr', group: '기술적분석>주가이동평균', name: '이평 정배열 5>20>60', expression: 'SMA(CLOSE, 5) > SMA(CLOSE, 20) AND SMA(CLOSE, 20) > SMA(CLOSE, 60)', hint: '단기>중기>장기.', example: 'SMA(CLOSE,5) > SMA(CLOSE,20)  → 5>20 정배열'},
  {id: 'golden', group: '기술적분석>주가이동평균', name: '골든크로스 5/20', expression: 'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))', hint: '단기이평이 장기를 상향 돌파.', example: 'CROSSUP(SMA(CLOSE,5), SMA(CLOSE,20))'},
  {id: 'dead', group: '기술적분석>주가이동평균', name: '데드크로스 5/20', expression: 'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))', hint: '단기이평이 장기를 하향 돌파.', example: 'CROSSDOWN(SMA(CLOSE,5), SMA(CLOSE,20))'},
  {id: 'disparity', group: '기술적분석>이동평균이격도', name: '이격도 20', expression: 'DISPARITY(CLOSE, 20) >= 102', hint: '종가/이평×100.', example: 'DISPARITY(CLOSE, 20) <= 98  → 20이평 대비 과매도'},
  {id: 'mom', group: '기술적분석>모멘텀', name: 'Momentum', expression: 'MOM(CLOSE, 10) >= 100', hint: '당봉 종가 / n봉전 종가 ×100.', example: 'MOM(CLOSE, 10) >= 105  → 10봉 모멘텀 105'},
  {id: 'rsi', group: '기술적분석>RSI', name: 'RSI 과매수', expression: 'RSI(CLOSE, 14) >= 70', hint: '0~100. 70 과매수, 30 과매도.', example: 'RSI(CLOSE, 14) <= 30  → 과매도'},
  {id: 'bb', group: '기술적분석>Bollinger Band', name: '볼린저 상단 근접', expression: 'CLOSE >= BBUPPER(CLOSE, 20, 2) * 0.99', hint: '종가가 상단 근처.', example: 'CLOSE <= BBLOWER(CLOSE, 20, 2)  → 하단 이탈/터치'},
  {id: 'macd', group: '기술적분석>MACD', name: 'MACD 골든', expression: 'CROSSUP(EMA(CLOSE, 12) - EMA(CLOSE, 26), EMA(EMA(CLOSE, 12) - EMA(CLOSE, 26), 9))', hint: 'MACD선이 시그널을 상향.', example: '같은 식을 CROSSDOWN 하면 데드'},
  {id: 'stoch', group: '기술적분석>Stochastic', name: '스토캐 과매수', expression: 'STOCHK(5) >= 80', hint: 'Fast %K.', example: 'STOCHK(5) <= 20  → 과매도'},
];

export const FUNCTION_HELP = [
  {name: 'CLOSE OPEN HIGH LOW VOLUME', desc: '당봉 시세. 비교·사칙 가능.', example: 'CLOSE > OPEN'},
  {name: 'SMA(x,n) EMA(x,n)', desc: '단순·지수 이동평균.', example: 'SMA(CLOSE, 20)'},
  {name: 'ROC(x,n)', desc: 'n봉전 대비 등락률 %.', example: 'ROC(CLOSE, 1) >= 2'},
  {name: 'HLRATE(n)', desc: 'n봉 저가 대비 고가 %.', example: 'HLRATE(10) >= 20'},
  {name: 'NEARHIGH(n, lag, pct)', desc: 'lag봉전 고가가 n봉 최고가에 pct% 이내.', example: 'NEARHIGH(5, 1, 1)'},
  {name: 'INRANGE(x, a, b)', desc: 'x가 a~b.', example: 'INRANGE(CLOSE, 1000, 500000)'},
  {name: 'CROSSUP(a,b) CROSSDOWN(a,b)', desc: '골든·데드 교차.', example: 'CROSSUP(SMA(CLOSE,5), SMA(CLOSE,20))'},
  {name: 'RSI MOM DISPARITY STOCHK', desc: '모멘텀 계열.', example: 'RSI(CLOSE, 14) >= 70'},
  {name: 'AND OR NOT ( )', desc: '조건 결합. 최대 약 20개.', example: '(A) AND (B) OR (C)'},
];

export const SAMPLE_0150 =
  '(HLRATE(10) >= 20 AND (NEARHIGH(5, 1, 1) OR NEARHIGH(5, 5, 1)) AND ROC(CLOSE, 1) >= 2 AND INRANGE(CLOSE, 1000, 500000)) OR (((CLOSE - OPEN) / OPEN * 100 >= 5.5 OR ACCOUNT >= 10000000000) AND INRANGE(CLOSE, 1000, 500000) AND VOLUME >= 2000000)';
