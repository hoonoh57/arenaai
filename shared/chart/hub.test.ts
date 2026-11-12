import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartHub} from './hub';
import {registerChartAddon, unregisterChartAddon, listChartAddons, paintChartAddons} from './addons';
import {createChartRuntime} from './runtime';
import {parseChartPersist, windowPatchFromChartState} from './state';

test('애드온을 모두 빼도 허브 수식 계산은 산다', () => {
  const id = 'tmp-addon';
  registerChartAddon({id, paint: () => { throw new Error('addon boom'); }});
  assert.ok(listChartAddons().some((a) => a.id === id));
  paintChartAddons({bars: [], formulas: []});
  unregisterChartAddon(id);
  assert.equal(listChartAddons().some((a) => a.id === id), false);
  const candles = [1, 2, 3].map((c, i) => ({time: i, open: c, high: c, low: c, close: c}));
  assert.deepEqual(chartHub.evaluate('CLOSE', candles), [1, 2, 3]);
});

test('런타임 인스턴스는 허브를 공유하고 상태는 JSON으로 복원', () => {
  const a = createChartRuntime('c1');
  const b = createChartRuntime('c2');
  assert.equal(a.hub, b.hub);
  const s = parseChartPersist('{"v":1,"code":"005930","timeframe":"3","paneById":{"adx":2}}');
  assert.equal(s?.code, '005930');
  assert.equal(windowPatchFromChartState(s!).indicatorPanes?.adx, 2);
});
