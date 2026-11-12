import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket, WebSocketServer} from 'ws';
import {AuditLog} from './audit';
import {SharedCache} from './cache';
import {RealtimeHub, type WsLike} from './hub';
import {LimitGovernor, RealtimeCaps} from './limits';

type FakeServer = {
  url: string;
  received: any[];
  push: (frame: unknown) => void;
  setLoginCode: (code: number) => void;
  dropClients: () => void;
  close: () => Promise<void>;
};

/** Minimal Kiwoom-shaped realtime server (LOGIN/PING/REG/REMOVE/CNSR*) for integration tests. */
async function startFakeServer(): Promise<FakeServer> {
  const wss = new WebSocketServer({port: 0});
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const address = wss.address();
  if (typeof address === 'string' || address === null) throw new Error('테스트 서버 주소 오류');
  const received: any[] = [];
  const sockets = new Set<WebSocket>();
  let loginCode = 0;

  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const text = raw.toString();
      let message: any;
      try {
        message = JSON.parse(text);
      } catch {
        received.push({raw: text});
        return;
      }
      received.push(message);
      if (message.trnm === 'LOGIN') {
        socket.send(JSON.stringify({trnm: 'LOGIN', return_code: loginCode, return_msg: loginCode === 0 ? 'LOGIN SUCCESS' : 'fail'}));
      } else if (message.trnm === 'REG' || message.trnm === 'REMOVE') {
        socket.send(JSON.stringify({trnm: message.trnm, return_code: 0, return_msg: 'ok'}));
      } else if (message.trnm === 'CNSRLST') {
        socket.send(JSON.stringify({trnm: 'CNSRLST', return_code: 0, data: [['4', '테스트조건']]}));
      } else if (message.trnm === 'CNSRREQ') {
        socket.send(JSON.stringify({trnm: 'CNSRREQ', return_code: 0, data: [{'9001': '005930', '302': '삼성전자'}]}));
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}/api/dostk/websocket`,
    received,
    push: (frame) => {
      const text = typeof frame === 'string' ? frame : JSON.stringify(frame);
      for (const socket of sockets) socket.send(text);
    },
    setLoginCode: (code) => {
      loginCode = code;
    },
    dropClients: () => {
      for (const socket of sockets) socket.close();
    },
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

type HubOptions = {
  token?: string;
  onToken?: (force: boolean) => void;
  governor?: LimitGovernor;
  cache?: SharedCache;
  audit?: AuditLog;
  now?: () => number;
  reconnectBaseMs?: number;
};

function createHub(
  server: FakeServer,
  options: HubOptions = {},
) {
  const cache = options.cache ?? new SharedCache({now: options.now});
  const audit = options.audit ?? new AuditLog({now: options.now});
  const governor =
    options.governor ??
    new LimitGovernor({
      total: {capacity: 100, refillPerSecond: 1000},
      perApi: {capacity: 100, refillPerSecond: 1000},
      order: {capacity: 10, refillPerSecond: 10},
    });
  const hub = new RealtimeHub({
    url: server.url,
    getToken: async (force = false) => {
      options.onToken?.(force);
      return options.token ?? 'test-token';
    },
    governor,
    cache,
    audit,
    caps: new RealtimeCaps(),
    createSocket: (url) => new WebSocket(url) as unknown as WsLike,
    now: options.now,
    reconnectBaseMs: options.reconnectBaseMs ?? 20,
    reconnectMaxMs: 200,
    loginTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    staleMs: 60000,
    candleRefreshDebounceMs: 20,
  });
  return {hub, cache, audit, governor};
}

async function waitFor<T>(check: () => T | null | undefined | false, label: string, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() - started > timeoutMs) throw new Error(`시간 초과: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const tradeFrame = (price = '71000', strength = '110.5') => ({
  trnm: 'REAL',
  data: [{item: '005930', type: '0B', values: {20: '090100', 10: `+${price}`, 12: '+2.35', 25: '2', 13: '1000', 14: '500000', 228: strength, 1314: '40'}}],
});

test('중앙 세션: 로그인 → 구독 등록 → 실시간 캐시 반영 → PING 응답', async () => {
  const server = await startFakeServer();
  const {hub, cache, audit} = createHub(server);
  try {
    await hub.start();
    assert.equal(hub.currentState, 'ready');
    assert.ok(server.received.some((message) => message.trnm === 'LOGIN'));

    await hub.subscribe('chart:1', ['005930'], ['0B']);
    const reg = server.received.find((message) => message.trnm === 'REG');
    assert.deepEqual(reg.data, [{item: ['005930'], type: ['0B']}]);

    server.push(tradeFrame());
    const quote = await waitFor(() => cache.getQuote('005930'), '실시간 체결 반영');
    assert.equal(quote.price, 71000);
    assert.equal(quote.strength, 110.5);

    server.push('PING');
    const echo = await waitFor(() => server.received.find((message) => message.raw === 'PING'), 'PING 에코');
    assert.equal(echo.raw, 'PING');

    const status = hub.status();
    assert.equal(status.subscriptions, 1);
    assert.deepEqual(status.caps, {maxConnections: 1, maxSubscriptions: 100, maxItemsPerPacket: 10, verified: false});
    assert.ok(audit.list(50).some((entry) => entry.category === 'subscription'));
  } finally {
    hub.stop();
    await server.close();
  }
});

test('구독은 참조 카운트로 관리되며 마지막 소유자만 해제 패킷을 보낸다', async () => {
  const server = await startFakeServer();
  const {hub} = createHub(server);
  try {
    await hub.start();
    await hub.subscribe('chart:1', ['005930'], ['0B']);
    await hub.subscribe('chart:2', ['005930'], ['0B']);
    assert.equal(server.received.filter((message) => message.trnm === 'REG').length, 1, '중복 등록 패킷 금지');

    await hub.unsubscribe('chart:1', ['005930'], ['0B']);
    assert.equal(server.received.filter((message) => message.trnm === 'REMOVE').length, 0, '다른 소유자가 남아 있으면 해제 금지');

    await hub.unsubscribe('chart:2', ['005930'], ['0B']);
    const remove = server.received.find((message) => message.trnm === 'REMOVE');
    assert.ok(remove);
    assert.deepEqual(remove.data, [{item: ['005930'], type: ['0B']}]);
    assert.equal(hub.status().subscriptions, 0);
  } finally {
    hub.stop();
    await server.close();
  }
});

test('중복 프레임은 캐시에 두 번 반영되지 않는다', async () => {
  const server = await startFakeServer();
  const {hub, cache} = createHub(server);
  try {
    await hub.start();
    server.push(tradeFrame());
    await waitFor(() => cache.getQuote('005930'), '첫 체결');
    const version = cache.quoteVersionCount();
    server.push(tradeFrame());
    await waitFor(() => hub.status().duplicatesDropped >= 1, '중복 억제');
    assert.equal(cache.quoteVersionCount(), version);
  } finally {
    hub.stop();
    await server.close();
  }
});

test('연결이 끊기면 재연결하고 구독을 복원한다', async () => {
  const server = await startFakeServer();
  const {hub} = createHub(server, {reconnectBaseMs: 20});
  try {
    await hub.start();
    await hub.subscribe('chart:1', ['005930'], ['0B']);
    const before = server.received.filter((message) => message.trnm === 'REG').length;
    assert.equal(before, 1);

    server.dropClients();
    await waitFor(() => hub.status().reconnects >= 1, '재연결 시도');
    await waitFor(() => hub.currentState === 'ready', '재연결 완료');
    await waitFor(() => server.received.filter((message) => message.trnm === 'REG').length >= 2, '구독 복원');
    assert.equal(hub.status().subscriptions, 1);
  } finally {
    hub.stop();
    await server.close();
  }
});

test('로그인 토큰 만료(8005) 시 강제 재발급 후 한 번만 재시도', async () => {
  const server = await startFakeServer();
  server.setLoginCode(8005);
  const forces: boolean[] = [];
  const {hub, audit} = createHub(server, {onToken: (force) => forces.push(force)});
  try {
    await hub.start().catch(() => undefined);
    await waitFor(() => forces.filter(Boolean).length >= 1, '토큰 강제 재발급');
    assert.deepEqual(forces, [false, true]);
    assert.equal(hub.currentState, 'reconnecting');
    assert.ok(audit.list(50).some((entry) => entry.message.includes('재발급')));
  } finally {
    hub.stop();
    await server.close();
  }
});

test('조건식 목록·검색은 중앙 세션의 요청/응답으로 처리', async () => {
  const server = await startFakeServer();
  const {hub} = createHub(server);
  try {
    await hub.start();
    const list = await hub.request({trnm: 'CNSRLST'}, 'CNSRLST');
    assert.deepEqual(list.data, [['4', '테스트조건']]);
    const search = await hub.request({trnm: 'CNSRREQ', seq: '4', search_type: '1', stex_tp: 'K'}, 'CNSRREQ');
    assert.equal((search.data as any[])[0]['9001'], '005930');
  } finally {
    hub.stop();
    await server.close();
  }
});

test('모의 신호는 확정봉당 한 번만 처리되고 감사에 기록된다', async () => {
  const now = 1_700_000_000_000;
  const server = await startFakeServer();
  const {hub, cache, audit} = createHub(server, {now: () => now});
  try {
    hub.setSignalEvaluator(() => ({buy: true, sell: false}));
    hub.setActiveCodes(['005930']);
    cache.mergeCandles('005930', [
      {time: 1_699_999_880, open: 1, high: 1, low: 1, close: 1},
      {time: 1_699_999_940, open: 1, high: 1, low: 1, close: 1},
    ]);
    hub.evaluateSignals('005930');
    hub.evaluateSignals('005930');
    assert.equal(hub.eventsSnapshot().length, 1, '같은 봉에서 중복 신호 금지');
    assert.equal(hub.positionsSnapshot()['005930'], 1);
    assert.ok(audit.list(50).some((entry) => entry.category === 'position'));
    assert.ok(audit.list(50).some((entry) => entry.category === 'order' && entry.message.includes('가정 체결')));
  } finally {
    hub.stop();
    await server.close();
  }
});

test('지연·미래 봉은 신호를 만들지 않고 경고를 남긴다', async () => {
  const now = 1_700_000_000_000;
  const server = await startFakeServer();
  const {hub, cache} = createHub(server, {now: () => now});
  try {
    hub.setSignalEvaluator(() => ({buy: true, sell: false}));
    hub.setActiveCodes(['005930']);
    cache.mergeCandles('005930', [{time: 1_699_990_000, open: 1, high: 1, low: 1, close: 1}]);
    hub.evaluateSignals('005930');
    assert.equal(hub.eventsSnapshot().length, 0);
    assert.equal(cache.getWarning('005930'), '확정 1분봉 지연');

    cache.clearCandles('005930');
    cache.mergeCandles('005930', [{time: 1_700_000_100, open: 1, high: 1, low: 1, close: 1}]);
    hub.evaluateSignals('005930');
    assert.equal(hub.eventsSnapshot().length, 0);
    assert.equal(cache.getWarning('005930'), '미래 또는 유효하지 않은 봉 시각');
  } finally {
    hub.stop();
    await server.close();
  }
});

test('차트 페이지는 중앙 캐시에 두고 실시간 체결은 같은 종목 마지막 봉만 갱신한다', () => {
  const cache = new SharedCache();
  const t = 1_700_000_060;
  const bars = [
    {time: t - 60, open: 1, high: 1, low: 1, close: 1},
    {time: t, open: 2, high: 2, low: 2, close: 2},
  ];
  cache.putChartPage('005930', '1', '', bars);
  assert.equal(cache.chartPage('005930', '1', '').length, 2);
  cache.applyLiveQuote('005930', t + 10, 8);
  assert.equal(cache.candles('005930').at(-1)?.close, 8);
  assert.equal(cache.chartPage('005930', '1', '').at(-1)?.close, 8);
});

test('종료 후에는 구독을 시도할 수 없고 타이머가 남지 않는다', async () => {
  const server = await startFakeServer();
  const {hub} = createHub(server);
  try {
    await hub.start();
    hub.stop();
    assert.equal(hub.currentState, 'closed');
    await assert.rejects(() => hub.subscribe('chart:1', ['005930'], ['0B']), /준비되지 않았습니다/);
    await assert.rejects(() => hub.start(), /다시 시작할 수 없습니다/);
  } finally {
    await server.close();
  }
});
