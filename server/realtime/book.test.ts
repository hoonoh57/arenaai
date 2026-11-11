import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AuditLog} from './audit';
import {SimulationBook} from './book';
import {SharedCache} from './cache';
import type {Quote} from './protocol';

function quote(code: string, price: number): Quote {
  return {
    code,
    time: null,
    price,
    changePct: 0,
    strength: null,
    cumVolume: null,
    cumValue: null,
    dayOpen: null,
    dayHigh: null,
    dayLow: null,
    tradeVolume: null,
    netBuyVolume: null,
    buyVolume: null,
    sellVolume: null,
    source: '0B',
    receivedAt: Date.now(),
  };
}

test('시장가는 관측 가격이 있으면 즉시 가정 체결하고 키움 주문은 없다', () => {
  const cache = new SharedCache();
  cache.setQuote(quote('005930', 70000));
  const book = new SimulationBook({cache, audit: new AuditLog()});
  const order = book.place({code: '005930', side: 'buy', type: 'market', qty: 2, source: 'manual'});
  assert.equal(order.status, 'filled');
  assert.equal(order.fillPrice, 70000);
  assert.equal(book.qty('005930'), 2);
  assert.equal(book.snapshot().brokerOrders, false);
  assert.equal(book.snapshot().assumedFill, true);
});

test('가격이 없으면 시장가도 미체결로 남고 시세가 오면 체결한다', () => {
  const cache = new SharedCache();
  const book = new SimulationBook({cache, audit: new AuditLog()});
  const order = book.place({code: '005930', side: 'buy', type: 'market'});
  assert.equal(order.status, 'working');
  cache.setQuote(quote('005930', 71000));
  const filled = book.onQuote('005930', 71000);
  assert.equal(filled.length, 1);
  assert.equal(filled[0].status, 'filled');
  assert.equal(book.qty('005930'), 1);
});

test('지정가 매수는 가격이 한도에 닿을 때만 체결한다', () => {
  const cache = new SharedCache();
  const book = new SimulationBook({cache, audit: new AuditLog()});
  book.place({code: '005930', side: 'buy', type: 'limit', limitPrice: 70000, qty: 1});
  assert.equal(book.onQuote('005930', 70100).length, 0);
  assert.equal(book.snapshot().working.length, 1);
  assert.equal(book.onQuote('005930', 69900).length, 1);
  assert.equal(book.qty('005930'), 1);
});

test('개별·일괄 매도와 미체결 취소', async () => {
  const cache = new SharedCache();
  cache.setQuote(quote('005930', 100));
  cache.setQuote(quote('000660', 200));
  const book = new SimulationBook({cache, audit: new AuditLog()});
  book.place({code: '005930', side: 'buy', type: 'market'});
  book.place({code: '000660', side: 'buy', type: 'market'});
  const waiting = book.place({code: '005930', side: 'buy', type: 'limit', limitPrice: 50, qty: 1});
  assert.equal(waiting.status, 'working');
  assert.equal((await book.cancel(waiting.id)).status, 'cancelled');
  book.place({code: '000660', side: 'buy', type: 'limit', limitPrice: 10, qty: 1});
  assert.equal(await book.cancelAll(), 1);
  await book.sell('005930', 'market');
  assert.equal(book.qty('005930'), 0);
  const rest = await book.flatten();
  assert.equal(rest.length, 1);
  assert.equal(book.snapshot().holdings.length, 0);
});

test('없는 가격으로 체결을 만들지 않고 보유 없이 매도하지 않는다', async () => {
  const book = new SimulationBook({cache: new SharedCache(), audit: new AuditLog()});
  await assert.rejects(() => book.sell('005930', 'market'));
  assert.throws(() => book.place({code: 'ABC', side: 'buy', type: 'market'}));
});

test('모의 주문 모드에서는 가정 체결하지 않고 브로커 주문번호만 남긴다', async () => {
  const calls: string[] = [];
  const book = new SimulationBook({
    cache: new SharedCache(),
    audit: new AuditLog(),
    allowBroker: true,
    broker: {
      async stockOrder(input) {
        calls.push(`${input.side}:${input.code}`);
        return {ordNo: '0000140'};
      },
      async cancelStock() {
        calls.push('cancel');
        return {ordNo: '0000141'};
      },
    },
  });
  book.setFillMode('kiwoom-mock');
  const order = await book.submit({code: '005930', side: 'buy', type: 'market', qty: 1});
  assert.equal(order.status, 'working');
  assert.equal(order.brokerOrdNo, '0000140');
  assert.equal(book.onQuote('005930', 70000).length, 0, '모의 모드에서 시세로 가정 체결하지 않음');
  await book.cancel(order.id);
  assert.deepEqual(calls, ['buy:005930', 'cancel']);
});

test('실전 호스트에서는 모의 주문 모드를 켤 수 없다', () => {
  const book = new SimulationBook({cache: new SharedCache(), audit: new AuditLog(), allowBroker: false});
  assert.throws(() => book.setFillMode('kiwoom-mock'), /KIWOOM_MODE=mock/);
});
