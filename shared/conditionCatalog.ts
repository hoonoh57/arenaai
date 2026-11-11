/** 키움 [0150] 분류. available=false 는 로컬 OHLCV에 없어 검색에 넣지 않음. */
export type ConditionItem = {
  id: string;
  group: string;
  name: string;
  expression: string;
  hint: string;
  example: string;
  available?: boolean;
};

const no = (id: string, group: string, name: string, why: string): ConditionItem => ({
  id,
  group,
  name,
  expression: '',
  hint: why,
  example: '로컬 일·분봉에는 이 데이터가 없습니다.',
  available: false,
});

const yes = (id: string, group: string, name: string, expression: string, hint: string, example: string): ConditionItem => ({
  id, group, name, expression, hint, example, available: true,
});

export const CONDITION_CATALOG: ConditionItem[] = [
  yes('range-px', '범위지정', '주가범위', 'INRANGE(CLOSE, 1000, 500000)', '종가 원 단위.', 'INRANGE(CLOSE, 5000, 100000)'),
  yes('range-vol', '범위지정', '거래량', 'VOLUME >= 2000000', '당봉 거래량.', 'VOLUME >= 1000000'),
  yes('range-val', '범위지정', '거래대금(추정)', 'ACCOUNT >= 5000000000', '거래량×종가. 키움 백만원 단위와 다름.', 'ACCOUNT >= 1e10'),
  yes('range-mkt', '범위지정', '시가총액(원)', 'INRANGE(MARKETCAP, 300000000000, 5000000000000)', '일봉 CSV 7열 market_cap. 30십억~5000십억 예.', 'INRANGE(MARKETCAP, 1e11, 5e12)'),
  no('range-kospi', '범위지정', '코스피/코스닥 구분', '시장 코드가 봉 CSV에 없음.'),
  no('range-cap', '범위지정', '자본금·상장주식수·액면가', '종목 마스터 없음.'),
  no('range-list', '범위지정', '상장일·증거금·신용', '종목 마스터 없음.'),

  yes('px-roc', '시세분석>가격조건', '주가등락률 종가대비', 'ROC(CLOSE, 1) >= 2', '1봉전 종가 대비 %.', 'ROC(CLOSE, 1) >= 3'),
  yes('px-open', '시세분석>가격조건', '주가등락률 시가대비', '(CLOSE - OPEN) / OPEN * 100 >= 5.5', '당봉 시가 대비.', '(CLOSE-OPEN)/OPEN*100 >= 3'),
  yes('px-hl', '시세분석>가격조건', '기간내 등락률 저가대비고가', 'HLRATE(10) >= 20', 'n봉 저가 대비 고가 %.', 'HLRATE(5) >= 10'),
  yes('px-nh', '시세분석>가격조건', '신고가 근접', 'NEARHIGH(5, 1, 1)', 'NEARHIGH(기간, 몇봉전, %).', 'NEARHIGH(20, 0, 1)'),
  yes('px-hh', '시세분석>가격조건', 'n봉 최고가', 'HIGH >= HIGHEST(HIGH, 20)', '당봉 고가 = 20봉 최고.', 'CLOSE >= HIGHEST(HIGH, 60) * 0.98'),
  yes('px-ll', '시세분석>가격조건', 'n봉 최저가', 'LOW <= LOWEST(LOW, 20)', '당봉 저가 = 20봉 최저.', 'CLOSE <= LOWEST(LOW, 20) * 1.02'),
  yes('px-up', '시세분석>가격조건', '기간내 양봉수', 'UPBARS(10) >= 6', '종>시 개수.', 'UPBARS(5) >= 4'),
  yes('px-dn', '시세분석>가격조건', '기간내 음봉수', 'DOWNBARS(10) >= 6', '종<시 개수.', 'DOWNBARS(5) >= 4'),
  yes('px-pred', '시세분석>가격조건', '전일 종가 대비', 'CLOSE > PREDAYCLOSE()', '분봉에서 전일 종가.', 'CLOSE >= PREDAYCLOSE() * 1.02'),
  no('px-quote', '시세분석>호가잔량', '호가잔량', '호가 원장 없음.'),
  no('px-exp', '시세분석>예상체결', '예상체결', '장전 예상체결 없음.'),
  no('px-frgn', '시세분석>외국인', '외국인 순매수', '투자자 수급 없음.'),
  no('px-broker', '시세분석>거래원', '거래원', '거래원 없음.'),
  no('px-prog', '시세분석>프로그램매매', '프로그램매매', '프로그램 없음.'),
  no('px-short', '시세분석>공매도/대차거래', '공매도·대차', '공매도 없음.'),
  yes('px-str', '시세분석>체결강도', '체결강도', 'STRENGTH >= 120', 'CSV에 strength 열 있을 때만.', 'STRENGTH >= 150'),
  yes('vol-sma', '시세분석>거래량/거래대금', '거래량 이평 돌파', 'VOLUME > SMA(VOLUME, 20)', '당봉 거래량 > 20이평.', 'VOLUME > SMA(VOLUME, 5) * 2'),
  yes('vol-roc', '시세분석>거래량/거래대금', '거래량 전봉비', 'ROC(VOLUME, 1) >= 100', '전봉 대비 거래량 +100%.', 'VOLUME >= REF(VOLUME, 1) * 3'),

  yes('ma-arr', '기술적분석>주가이동평균', '이평 정배열 5>20>60', 'SMA(CLOSE, 5) > SMA(CLOSE, 20) AND SMA(CLOSE, 20) > SMA(CLOSE, 60)', '단기>중기>장기.', 'SMA(CLOSE,5) > SMA(CLOSE,20)'),
  yes('ma-inv', '기술적분석>주가이동평균', '이평 역배열 5<20<60', 'SMA(CLOSE, 5) < SMA(CLOSE, 20) AND SMA(CLOSE, 20) < SMA(CLOSE, 60)', '하락 배열.', 'SMA(CLOSE,5) < SMA(CLOSE,20)'),
  yes('ma-gold', '기술적분석>주가이동평균', '골든크로스 5/20', 'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))', '상향돌파.', 'CROSSUP(SMA(CLOSE,20), SMA(CLOSE,60))'),
  yes('ma-dead', '기술적분석>주가이동평균', '데드크로스 5/20', 'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))', '하향돌파.', 'CROSSDOWN(SMA(CLOSE,5), SMA(CLOSE,20))'),
  yes('ma-pxup', '기술적분석>주가이동평균', '종가 20이평 상향돌파', 'CROSSUP(CLOSE, SMA(CLOSE, 20))', '가격이 이평을 돌파.', 'CLOSE > SMA(CLOSE, 60)'),
  yes('ma-ema', '기술적분석>주가이동평균', 'EMA 12/26 골든', 'CROSSUP(EMA(CLOSE, 12), EMA(CLOSE, 26))', '지수이평 교차.', 'EMA(CLOSE,12) > EMA(CLOSE,26)'),
  yes('ma-hma', '기술적분석>주가이동평균', 'Hull MA 상향', 'CROSSUP(CLOSE, HMA(CLOSE, 16))', 'HMA.', 'CLOSE > HMA(CLOSE, 16)'),
  yes('ma-jma', '기술적분석>주가이동평균', 'JMA 상향', 'CLOSE > JMA(14, 50, 2)', 'JMA(기간, phase, power).', 'CROSSUP(CLOSE, JMA(14, 50, 2))'),
  yes('ma-disp', '기술적분석>이동평균이격도', '이격도 20 과열', 'DISPARITY(CLOSE, 20) >= 102', '종가/이평×100.', 'DISPARITY(CLOSE, 20) <= 98'),
  yes('vma', '기술적분석>거래량이동평균', '거래량 5>20', 'SMA(VOLUME, 5) > SMA(VOLUME, 20)', '단기 거래량 이평 > 장기.', 'CROSSUP(SMA(VOLUME,5), SMA(VOLUME,20))'),

  yes('adx', '기술적분석>추세지표', 'ADX 추세', 'ADX(14) >= 25', '추세 강도.', 'ADX(14) >= 30 AND PLUSDI(14) > MINUSDI(14)'),
  yes('pdi', '기술적분석>추세지표', '+DI > -DI', 'PLUSDI(14) > MINUSDI(14)', '상승 방향.', 'CROSSUP(PLUSDI(14), MINUSDI(14))'),
  yes('st', '기술적분석>추세지표', 'Supertrend 상승', 'STDIR(14, 2) > 0', 'STDIR>0 상승 구간.', 'CLOSE > ST(14, 2)'),

  yes('rsi-ob', '기술적분석>모멘텀지표', 'RSI 과매수', 'RSI(CLOSE, 14) >= 70', '70 과매수 30 과매도.', 'RSI(CLOSE, 14) <= 30'),
  yes('rsi-up', '기술적분석>모멘텀지표', 'RSI 50 상향', 'CROSSUP(RSI(CLOSE, 14), 50)', '중립선 돌파.', 'RSI(CLOSE, 14) >= 50'),
  yes('mom', '기술적분석>모멘텀지표', 'Momentum', 'MOM(CLOSE, 10) >= 100', '종가/n봉전×100.', 'MOM(CLOSE, 50) >= 95'),
  yes('cci', '기술적분석>모멘텀지표', 'CCI', 'CCI(14) >= 100', '100 과열 -100 침체.', 'CCI(14) <= -100'),
  yes('willr', '기술적분석>모멘텀지표', 'Williams %R', 'WILLR(14) <= -80', '0~-100. -80 과매도.', 'WILLR(14) >= -20'),
  yes('stochk', '기술적분석>모멘텀지표', 'Stochastic %K 과매수', 'STOCHK(5) >= 80', 'Fast %K.', 'STOCHK(5) <= 20'),
  yes('stochd', '기술적분석>모멘텀지표', 'Stochastic %D', 'STOCHD(5, 3) >= 80', '%K의 평활.', 'CROSSUP(STOCHK(5), STOCHD(5, 3))'),
  yes('tsi', '기술적분석>모멘텀지표', 'TSI', 'TSI(25, 13) >= 0', 'True Strength.', 'CROSSUP(TSI(25, 13), 0)'),
  yes('macd', '기술적분석>모멘텀지표', 'MACD 골든', 'CROSSUP(EMA(CLOSE, 12) - EMA(CLOSE, 26), EMA(EMA(CLOSE, 12) - EMA(CLOSE, 26), 9))', 'MACD vs signal.', 'EMA(CLOSE,12)-EMA(CLOSE,26) > 0'),

  yes('bb-up', '기술적분석>채널지표', '볼린저 상단 근접', 'CLOSE >= BBUPPER(CLOSE, 20, 2) * 0.99', '상단 근처.', 'CLOSE >= BBUPPER(CLOSE, 20, 2)'),
  yes('bb-lo', '기술적분석>채널지표', '볼린저 하단 근접', 'CLOSE <= BBLOWER(CLOSE, 20, 2) * 1.01', '하단 근처.', 'CLOSE <= BBLOWER(CLOSE, 20, 2)'),
  yes('bb-mid', '기술적분석>채널지표', '볼린저 중심 상향', 'CROSSUP(CLOSE, BBMID(CLOSE, 20))', '중심선 돌파.', 'CLOSE > BBMID(CLOSE, 20)'),
  yes('kc-up', '기술적분석>채널지표', '켈트너 상단', 'CLOSE >= KCUPPER(CLOSE, 20, 1.5)', 'KC.', 'CLOSE <= KCLOWER(CLOSE, 20, 1.5)'),
  yes('dc-hi', '기술적분석>채널지표', '돈치안 고가 돌파', 'HIGH >= DCHIGH(20)', '20봉 채널 상단.', 'LOW <= DCLOW(20)'),

  yes('atr', '기술적분석>변동성지표', 'ATR 확대', 'ATR(14) >= SMA(ATR(14), 20)', '변동성 확대.', 'ATR(14) > REF(ATR(14), 1)'),
  yes('stdev', '기술적분석>변동성지표', '종가 표준편차', 'STDEV(CLOSE, 20) >= SMA(STDEV(CLOSE, 20), 60)', '변동성 비교.', 'STDEV(CLOSE, 20) > 0'),

  yes('obv', '기술적분석>거래량지표', 'OBV 상승', 'OBV() > SMA(OBV(), 20)', '누적 거래량.', 'CROSSUP(OBV(), SMA(OBV(), 20))'),
  yes('mfi', '기술적분석>거래량지표', 'MFI 과매수', 'MFI(14) >= 80', '자금흐름 0~100.', 'MFI(14) <= 20'),
  yes('vwma', '기술적분석>거래량지표', 'VWMA 상향', 'CLOSE > VWMA(CLOSE, 20)', '거래량가중 이평.', 'CROSSUP(CLOSE, VWMA(CLOSE, 20))'),
  yes('vwap', '기술적분석>거래량지표', 'VWAP 상회', 'CLOSE > VWAP()', '당일 VWAP(분봉).', 'CLOSE >= VWAP()'),

  yes('pat-up3', '패턴분석', '연속 양봉 3', 'UPBARS(3) >= 3', '3봉 연속 양봉.', 'UPBARS(5) >= 5'),
  yes('pat-dn3', '패턴분석', '연속 음봉 3', 'DOWNBARS(3) >= 3', '3봉 연속 음봉.', 'DOWNBARS(5) >= 5'),
  yes('pat-eng', '패턴분석', '상승 장악', 'CLOSE > OPEN AND REF(CLOSE, 1) < REF(OPEN, 1) AND CLOSE >= REF(OPEN, 1) AND OPEN <= REF(CLOSE, 1)', '전봉 음봉을 양봉이 장악.', 'CLOSE > REF(HIGH, 1)'),
  no('pat-hts', '패턴분석', '키움 고정 캔들패턴', '키움 전용 패턴 엔진은 없음. 위 조합으로 유사 구성.'),

  no('fin', '재무분석', '수익성·성장성·안정성·P/L·B/S', 'FnGuide 재무. 로컬 봉 불가.'),
  no('rank', '순위분석', '시세·수급·외국인 순위', '전종목 순위 테이블 없음. 조건 검색 후 결과 정렬로 대체.'),
];

export const FUNCTION_HELP = [
  {name: 'CLOSE OPEN HIGH LOW VOLUME ACCOUNT', desc: '당봉 시세. ACCOUNT=거래량×종가.', example: 'CLOSE > OPEN'},
  {name: 'REF(x,n) PREDAYCLOSE()', desc: 'n봉전 값, 전일 종가.', example: 'CLOSE > REF(CLOSE, 1)'},
  {name: 'SMA EMA HMA VWMA JMA ALMA', desc: '이동평균.', example: 'SMA(CLOSE, 20)'},
  {name: 'CROSSUP CROSSDOWN', desc: '골든·데드.', example: 'CROSSUP(SMA(CLOSE,5), SMA(CLOSE,20))'},
  {name: 'ROC HLRATE NEARHIGH INRANGE', desc: '등락·신고가·범위.', example: 'ROC(CLOSE, 1) >= 2'},
  {name: 'RSI MOM CCI WILLR STOCHK STOCHD TSI', desc: '모멘텀.', example: 'RSI(CLOSE, 14) <= 30'},
  {name: 'ADX PLUSDI MINUSDI ST STDIR', desc: '추세.', example: 'ADX(14) >= 25'},
  {name: 'BBUPPER BBLOWER BBMID KCUPPER DCHIGH', desc: '채널.', example: 'CLOSE >= BBUPPER(CLOSE, 20, 2)'},
  {name: 'ATR STDEV', desc: '변동성.', example: 'ATR(14)'},
  {name: 'OBV MFI VWAP VOLUME', desc: '거래량 계열.', example: 'MFI(14) >= 80'},
  {name: 'UPBARS DOWNBARS HIGHEST LOWEST', desc: '패턴·기간 고저.', example: 'UPBARS(5) >= 4'},
  {name: 'AND OR NOT ( )', desc: '조건 결합.', example: '(A) AND (B) OR (C)'},
];

export const SAMPLE_0150 =
  '(HLRATE(10) >= 20 AND (NEARHIGH(5, 1, 1) OR NEARHIGH(5, 5, 1)) AND ROC(CLOSE, 1) >= 2 AND INRANGE(CLOSE, 1000, 500000)) OR (((CLOSE - OPEN) / OPEN * 100 >= 5.5 OR ACCOUNT >= 10000000000) AND INRANGE(CLOSE, 1000, 500000) AND VOLUME >= 2000000)';
