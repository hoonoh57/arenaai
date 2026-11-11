import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  createDesk,
  defaultWorkspace,
  ensureMockTradeWorkspace,
  insertWindow,
  removeWindow,
  setWindowState,
  syncVars,
  toggleLock,
  validateWorkspace,
  nextDeskNumber,
} from './desk';

test('빈 3번 화면에 모의매매 세 창을 넣는다', () => {
  const ws = ensureMockTradeWorkspace({
    active: 1,
    desks: [{id: 'desk-1', number: 1, name: '가상화면 1', vars: {code: '', name: '', strategyId: ''}, windows: []}],
  });
  const d3 = ws.desks.find((d) => d.number === 3);
  assert.ok(d3);
  assert.deepEqual(d3!.windows.map((w) => w.kind), ['scanner', 'multi-chart', 'book']);
});

test('가상화면은 1~8번만 만들고 번호가 비지 않게 채운다', () => {
  const desks = [defaultWorkspace().desks[0]];
  for (let i = 2; i <= 8; i += 1) desks.push(createDesk(desks));
  assert.equal(nextDeskNumber(desks), null);
  assert.throws(() => createDesk(desks));
  const remaining = desks.filter((desk) => desk.number !== 3);
  assert.equal(nextDeskNumber(remaining), 3);
});

test('자식창 삽입·삭제와 최대화 원복', () => {
  let desk = defaultWorkspace().desks[0];
  desk = insertWindow(desk, 'chart');
  desk = insertWindow(desk, 'scanner');
  assert.equal(desk.windows.length, 2);
  const id = desk.windows[0].id;
  const {x, y, w, h} = desk.windows[0];
  desk = setWindowState(desk, id, 'maximized');
  assert.equal(desk.windows[0].state, 'maximized');
  desk = setWindowState(desk, id, 'normal');
  assert.deepEqual({x: desk.windows[0].x, y: desk.windows[0].y, w: desk.windows[0].w, h: desk.windows[0].h}, {x, y, w, h});
  desk = removeWindow(desk, id);
  assert.equal(desk.windows.length, 1);
  assert.equal(desk.windows[0].kind, 'scanner');
});

test('공통변수는 잠기지 않은 자식창만 바꾸고 잠긴 창은 강제 변경하지 않는다', () => {
  let desk = insertWindow(defaultWorkspace().desks[0], 'chart');
  desk = insertWindow(desk, 'tr');
  const locked = desk.windows[1].id;
  desk = toggleLock(desk, locked);
  desk = syncVars(desk, {code: '005930', name: '삼성전자', strategyId: 'sys-1'});
  assert.equal(desk.vars.code, '005930');
  assert.equal(desk.windows[0].code, '005930');
  assert.equal(desk.windows[0].strategyId, 'sys-1');
  assert.notEqual(desk.windows[1].code, '005930');
  assert.notEqual(desk.windows[1].strategyId, 'sys-1');
  assert.equal(desk.windows[1].locked, true);
});

test('잘못된 워크스페이스는 거부한다', () => {
  assert.throws(() => validateWorkspace({active: 1, desks: []}));
  assert.throws(() => validateWorkspace({active: 1, desks: [{id: 'a', number: 9, name: 'x', vars: {}, windows: []}]}));
});
