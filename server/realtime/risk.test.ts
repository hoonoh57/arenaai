import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RiskManager} from './risk';

const DAY = Date.parse('2025-01-02T00:00:00+09:00');

test('기본 한도로 진입을 승인하고 예약한다', () => {
  const risk = new RiskManager();
  const decision = risk.canEnter({code: '005930', price: 70000, at: DAY});
  assert.deepEqual(decision, {ok: true, reason: ''});
  risk.onEntry('005930', 70000, DAY);
  assert.equal(risk.snapshot(DAY).positions, 1);
  assert.equal(risk.snapshot(DAY).entriesToday, 1);
  assert.deepEqual(risk.canEnter({code: '005930', price: 70000, at: DAY}), {ok: false, reason: '이미 보유 중인 종목입니다.'});
});

test('최대 보유 종목 수를 넘지 않는다', () => {
  const risk = new RiskManager({maxPositions: 2});
  risk.onEntry('000001', 100, DAY);
  risk.onEntry('000002', 100, DAY);
  const decision = risk.canEnter({code: '000003', price: 100, at: DAY});
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /최대 보유 종목 수/);
});

test('종목당·일일 진입 횟수 한도', () => {
  const risk = new RiskManager({maxEntriesPerCode: 2, maxEntriesPerDay: 3, maxPositions: 10});
  for (let index = 0; index < 2; index += 1) {
    assert.equal(risk.canEnter({code: '000001', price: 100, at: DAY + index * 1000}).ok, true);
    risk.onEntry('000001', 100, DAY + index * 1000);
    risk.onExit('000001', 0, DAY + index * 1000 + 10);
  }
  assert.match(risk.canEnter({code: '000001', price: 100, at: DAY + 5000}).reason, /종목당 진입 횟수/);
  risk.onEntry('000002', 100, DAY + 6000);
  risk.onExit('000002', 0, DAY + 6010);
  assert.match(risk.canEnter({code: '000003', price: 100, at: DAY + 7000}).reason, /일일 진입 횟수/);
});

test('연속 손실과 쿨다운이 진입을 막는다', () => {
  const risk = new RiskManager({maxConsecutiveLosses: 2, cooldownMs: 60_000, maxPositions: 10});
  risk.onEntry('000001', 100, DAY);
  risk.onExit('000001', -10, DAY + 1000);
  // 첫 손실 직후에는 쿨다운이 진입을 막는다.
  assert.match(risk.canEnter({code: '000002', price: 100, at: DAY + 2000}).reason, /대기 시간/);
  // 쿨다운이 지나면 다시 허용된다.
  assert.equal(risk.canEnter({code: '000002', price: 100, at: DAY + 61_000}).ok, true);

  risk.onEntry('000002', 100, DAY + 61_000);
  risk.onExit('000002', -5, DAY + 62_000);
  const blocked = risk.canEnter({code: '000003', price: 100, at: DAY + 200_000});
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /연속 손실/);
  assert.equal(risk.snapshot(DAY + 200_000).blocked, true);
});

test('수익 청산은 연속 손실을 초기화한다', () => {
  const risk = new RiskManager({maxConsecutiveLosses: 2, cooldownMs: 0});
  risk.onEntry('000001', 100, DAY);
  risk.onExit('000001', -10, DAY + 1000);
  assert.equal(risk.snapshot(DAY + 1000).consecutiveLosses, 1);
  risk.onEntry('000002', 100, DAY + 2000);
  risk.onExit('000002', 30, DAY + 3000);
  assert.equal(risk.snapshot(DAY + 3000).consecutiveLosses, 0);
  assert.equal(risk.snapshot(DAY + 3000).realisedPnl, 20);
});

test('당일 손실 한도 도달 시 차단', () => {
  const risk = new RiskManager({startEquity: 1_000_000, maxDailyLossPct: 1, maxPositions: 10, cooldownMs: 0, maxConsecutiveLosses: 99});
  risk.onEntry('000001', 100, DAY);
  risk.onExit('000001', -5000, DAY + 1000);
  assert.equal(risk.canEnter({code: '000002', price: 100, at: DAY + 2000}).ok, true, '한도 미만이면 허용');
  risk.onEntry('000002', 100, DAY + 3000);
  risk.onExit('000002', -5001, DAY + 4000);
  const decision = risk.canEnter({code: '000003', price: 100, at: DAY + 5000});
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /당일 실현 손실 한도/);
  const snapshot = risk.snapshot(DAY + 5000);
  assert.equal(snapshot.blocked, true);
  assert.ok(snapshot.realisedPct <= -1);
});

test('분당 진입 요청 상한과 잘못된 입력', () => {
  const risk = new RiskManager({maxEntriesPerMinute: 2, maxPositions: 10, maxEntriesPerCode: 99, maxEntriesPerDay: 99, cooldownMs: 0, maxConsecutiveLosses: 99});
  risk.onEntry('000001', 100, DAY);
  risk.onExit('000001', 0, DAY + 10);
  risk.onEntry('000002', 100, DAY + 1000);
  risk.onExit('000002', 0, DAY + 1010);
  assert.match(risk.canEnter({code: '000003', price: 100, at: DAY + 2000}).reason, /분당 진입 요청/);
  assert.equal(risk.canEnter({code: 'ABC', price: 100, at: DAY + 120_000}).ok, false);
  assert.equal(risk.canEnter({code: '000004', price: 0, at: DAY + 120_000}).ok, false);
  assert.throws(() => new RiskManager({maxPositions: 0}));
  assert.throws(() => new RiskManager({startEquity: 0}));
  assert.throws(() => new RiskManager({cooldownMs: -1}));
});

test('일자가 바뀌면 일일 카운터가 초기화되고 보유는 유지된다', () => {
  const risk = new RiskManager({cooldownMs: 0, maxConsecutiveLosses: 99});
  risk.onEntry('005930', 100, DAY);
  risk.onExit('005930', -100, DAY + 1000);
  risk.onEntry('005930', 100, DAY + 2000);
  const before = risk.snapshot(DAY + 2000);
  assert.equal(before.entriesToday, 2);
  assert.equal(before.positions, 1);
  const nextDay = DAY + 24 * 3600 * 1000;
  const after = risk.snapshot(nextDay);
  assert.equal(after.entriesToday, 0);
  assert.equal(after.realisedPnl, 0);
  assert.equal(after.positions, 1, '보유 포지션은 일자 변경으로 사라지지 않는다');
  risk.resetDay(nextDay);
  assert.equal(risk.snapshot(nextDay).entriesToday, 0);
});
