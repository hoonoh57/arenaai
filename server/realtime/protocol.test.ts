import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  changePercent,
  clockToSeconds,
  conditionEvent,
  decodeEvents,
  isPing,
  kstDate,
  loginPacket,
  numeric,
  parseFrame,
  pingEcho,
  quoteFromEvent,
  registerPacket,
  removePacket,
  returnCode,
  sectorFromEvent,
  stockInfoFromEvent,
  wsUrl,
} from './protocol';

test('공식 명세의 WebSocket 엔드포인트와 패킷 형태를 사용', () => {
  assert.equal(wsUrl('real'), 'wss://api.kiwoom.com:10000/api/dostk/websocket');
  assert.equal(wsUrl('mock'), 'wss://mockapi.kiwoom.com:10000/api/dostk/websocket');
  assert.deepEqual(loginPacket('tkn'), {trnm: 'LOGIN', token: 'tkn'});
  assert.deepEqual(registerPacket(['005930'], ['0B']), {
    trnm: 'REG',
    grp_no: '1',
    refresh: '1',
    data: [{item: ['005930'], type: ['0B']}],
  });
  assert.deepEqual(removePacket(['005930'], ['0B']), {
    trnm: 'REMOVE',
    grp_no: '1',
    data: [{item: ['005930'], type: ['0B']}],
  });
  assert.throws(() => registerPacket([], ['0B']));
  assert.throws(() => registerPacket(['005930'], []));
  assert.throws(() => registerPacket(['005930'], ['ZZ']));
  assert.throws(() => loginPacket(''));
});

test('PING은 원문 그대로 되돌려 보낸다', () => {
  const text = parseFrame('PING');
  assert.equal(isPing(text), true);
  assert.equal(pingEcho(text), 'PING');
  const json = parseFrame(JSON.stringify({trnm: 'PING'}));
  assert.equal(isPing(json), true);
  assert.deepEqual(pingEcho(json), {trnm: 'PING'});
  assert.equal(isPing(parseFrame(JSON.stringify({trnm: 'REAL', data: []}))), false);
});

test('손상된 프레임은 추측하지 않고 거부', () => {
  assert.throws(() => parseFrame('not-json'));
  assert.throws(() => parseFrame('[]'));
  assert.throws(() => parseFrame(JSON.stringify({data: []})));
  assert.throws(() => parseFrame('   '));
  assert.equal(returnCode({trnm: 'REG', return_code: '0'}), 0);
  assert.equal(returnCode({trnm: 'REG', return_code: 8005}), 8005);
  assert.equal(returnCode({trnm: 'REG', return_code: 'abc'}), null);
  assert.equal(returnCode({trnm: 'REG'}), null);
});

test('REAL 프레임을 종목/타입별 이벤트로 전개', () => {
  const frame = parseFrame(
    JSON.stringify({
      trnm: 'REAL',
      data: [
        {item: '005930', type: '0B', values: {10: '+71000', 13: '123', 228: '110.5'}},
        {item: 'A000660', type: '0B', values: {10: '-100000'}},
        {item: '', type: '0B', values: {}},
        'garbage',
      ],
    }),
  );
  const events = decodeEvents(frame as never);
  assert.equal(events.length, 2);
  assert.equal(events[0].item, '005930');
  assert.equal(events[1].item, '000660');
  assert.deepEqual(decodeEvents({trnm: 'REG', data: []}), []);
});

test('키움 숫자 표기와 부호 처리', () => {
  assert.equal(numeric('+000070000'), 70000);
  assert.equal(numeric('-1,234.5'), -1234.5);
  assert.equal(numeric(''), null);
  assert.equal(numeric('abc'), null);
  assert.equal(changePercent('+2.35', ''), 2.35);
  assert.equal(changePercent('000001500', '2'), 1.5);
  assert.equal(changePercent('000001500', '5'), -1.5);
  assert.equal(changePercent('000000000', '3'), 0);
  assert.equal(changePercent('', '2'), null);
});

test('체결시간은 유효한 시각만 KST로 해석', () => {
  const t = clockToSeconds('090100', '20250102');
  assert.equal(new Date((t as number) * 1000).toISOString(), '2025-01-02T00:01:00.000Z');
  assert.equal(clockToSeconds('256100', '20250102'), null);
  assert.equal(clockToSeconds('0901', '20250102'), null);
  assert.equal(clockToSeconds('090100', '2025-01-02'), null);
  assert.equal(kstDate(Date.parse('2025-01-02T00:00:00Z')), '20250102');
});

test('0B 체결에서 체결강도와 순매수체결량을 명세 필드로만 해석', () => {
  const receivedAt = 1_700_000_000_000;
  const quote = quoteFromEvent(
    {
      type: '0B',
      item: '005930',
      values: {
        20: '090100',
        10: '+71000',
        12: '+2.35',
        25: '2',
        15: '120',
        13: '1000',
        14: '500000',
        16: '70000',
        17: '71500',
        18: '69800',
        228: '110.5',
        1314: '40',
        1030: '10',
        1031: '50',
      },
    },
    '20250102',
    receivedAt,
  );
  assert.ok(quote);
  assert.equal(quote.code, '005930');
  assert.equal(quote.price, 71000);
  assert.equal(quote.changePct, 2.35);
  assert.equal(quote.strength, 110.5);
  assert.equal(quote.cumValue, 500000);
  assert.equal(quote.netBuyVolume, 40);
  assert.equal(quote.tradeVolume, 120);
  assert.equal(quote.source, '0B');
  // 봉별 거래대금은 어떤 필드에서도 채우지 않는다.
  assert.equal('turnover' in quote, false);
});

test('0A에는 체결강도가 없으므로 null로 남긴다', () => {
  const quote = quoteFromEvent({type: '0A', item: '000660', values: {10: '100000', 12: '1.00', 228: '99'}}, '20250102', 0);
  assert.ok(quote);
  assert.equal(quote.strength, null);
  assert.equal(quote.tradeVolume, null);
  assert.equal(quoteFromEvent({type: '0B', item: '000660', values: {}}, '20250102', 0), null);
});

test('0g 종목정보와 0U 업종등락 필드', () => {
  const info = stockInfoFromEvent({type: '0g', item: '005930', values: {305: '93000', 306: '50000', 307: '71000'}}, 0);
  assert.deepEqual(info, {code: '005930', upperLimit: 93000, lowerLimit: 50000, basePrice: 71000, receivedAt: 0});
  assert.equal(stockInfoFromEvent({type: '0g', item: '005930', values: {}}, 0), null);

  const sector = sectorFromEvent({type: '0U', item: '001', values: {20: '093000', 10: '+250.1', 12: '+1.2', 252: '300', 255: '150', 253: '50'}}, '20250102', 0);
  assert.ok(sector);
  assert.equal(sector.upCount, 300);
  assert.equal(sector.downCount, 150);
  assert.equal(sector.flatCount, 50);
  assert.equal(sector.changePct, 1.2);
  // 0U에는 업종 현재가가 없으므로 만들어내지 않는다.
  assert.equal(sector.value, 250.1);
});

test('조건검색 실시간은 삽입/삭제 구분이 명확할 때만 반영', () => {
  const base = {type: 'ka10173', item: '005930', values: {841: '4', 9001: '005930', 20: '090100'}};
  assert.deepEqual(conditionEvent({...base, values: {...base.values, 843: 'I'}}, '20250102'), {seq: '4', code: '005930', action: 'insert', time: clockToSeconds('090100', '20250102')});
  assert.equal(conditionEvent({...base, values: {...base.values, 843: 'D'}}, '20250102')?.action, 'delete');
  // 구분 코드가 문서화되지 않은 값이면 무시한다.
  assert.equal(conditionEvent({...base, values: {...base.values, 843: 'X'}}, '20250102'), null);
  assert.equal(conditionEvent({...base, values: {841: '4', 9001: 'ETF001', 843: 'I'}}, '20250102'), null);
});
