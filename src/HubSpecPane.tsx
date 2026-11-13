import React, {useEffect, useState} from 'react';
import {HUB_ASK_CATALOG, HUB_ASK_OPS} from '../shared/hubAsk';
import {HUB_CAPS} from '../shared/hubCaps';
import {HUB_TR_CATALOG, HUB_TR_SCREENS} from '../shared/hubTrCatalog';

type Dash = {
  rest?: {used: number; left: number; cap: number; waitForOneMs: number; refillPerSecond: number};
  wss?: {used: number; left: number; cap: number; packet: number};
  hub?: {state: string; link: string; silentMs: number | null; subscriptions: number; emergency: boolean};
  book?: {holdings: {code: string}[]; working: unknown[]; recent: unknown[]; fillMode?: string};
};

export function HubSpecPane() {
  const [dash, setDash] = useState<Dash>({});
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const s = await fetch('/api/state').then((r) => r.json());
        const live = await fetch('/api/hub/lab/live').then((r) => r.json()).catch(() => ({}));
        if (stop) return;
        setDash({
          rest: live.quota?.rest || s.quota?.rest,
          wss: live.quota?.wss || s.quota?.wss,
          hub: s.realtime?.hub,
          book: s.book,
        });
      } catch {
        /* */
      }
    };
    void pull();
    const id = window.setInterval(() => void pull(), 1000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);
  const rest = dash.rest;
  const wss = dash.wss;
  const hub = dash.hub;
  const book = dash.book;
  return (
    <div className="hub-spec">
      <section className="hub-spec-dash">
        <h3>중앙관리자 대시보드</h3>
        <div className="hub-spec-kpis">
          <article>
            <b>링크</b>
            <span>
              {hub?.state || '-'} · {hub?.link || '-'}
              {hub?.emergency ? ' · 긴급' : ''}
            </span>
            <small>무음 {hub?.silentMs != null ? `${Math.round(hub.silentMs / 1000)}초` : '-'}</small>
          </article>
          <article>
            <b>REST</b>
            <span>
              {rest ? `${rest.used.toFixed(1)}/${rest.cap} 소모 · 잔여 ${rest.left.toFixed(1)}` : '…'}
            </span>
            <small>
              초당 +{rest?.refillPerSecond?.toFixed(2) ?? HUB_CAPS.restBurst} · 주문 예약 {HUB_CAPS.restReserveForOrder}칸
            </small>
          </article>
          <article>
            <b>WSS</b>
            <span>{wss ? `${wss.used}/${wss.cap} 구독 · 잔여 ${wss.left}` : '…'}</span>
            <small>패킷당 {wss?.packet ?? HUB_CAPS.wssPacket} · 허브 구독 {hub?.subscriptions ?? '-'}</small>
          </article>
          <article>
            <b>장부</b>
            <span>
              보유 {book?.holdings?.length ?? 0} · 미체결 {book?.working?.length ?? 0} · 최근체결 {book?.recent?.length ?? 0}
            </span>
            <small>{book?.fillMode || '-'}</small>
          </article>
        </div>
        <p className="hub-spec-note">
          한도: 버스트 {HUB_CAPS.restBurst} · 차트병렬 {HUB_CAPS.chartConcurrency} · {HUB_CAPS.note} 창은 키움 URL을 열지 않는다.
        </p>
      </section>
      <section className="hub-spec-api">
        <h3>표준 함수 hub.ask — 다음 세션 수요 개발 참고</h3>
        <p>
          요청 타입 <code>HubAsk</code> · 회신 <code>HubAskReply</code> (<code>shared/hubAsk.ts</code>). op 목록:{' '}
          {HUB_ASK_OPS.join(', ')}.
        </p>
        <table>
          <thead>
            <tr>
              <th>함수</th>
              <th>파라미터</th>
              <th>반환</th>
              <th>HTTP · 형식</th>
            </tr>
          </thead>
          <tbody>
            {HUB_ASK_CATALOG.map((row) => (
              <tr key={row.op}>
                <td>
                  <code>ask({'{op:'} '{row.op}'{'}'})</code>
                  <div className="hub-spec-sub">{row.title}</div>
                </td>
                <td>
                  {row.params.map((p) => (
                    <div key={p.name}>
                      <code>{p.name}</code> {p.type}
                      {p.required ? ' *' : ''} {p.note}
                    </div>
                  ))}
                </td>
                <td>
                  {row.returns.map((p) => (
                    <div key={p.name}>
                      <code>{p.name}</code> {p.type} {p.note}
                    </div>
                  ))}
                </td>
                <td>
                  <div>{row.http}</div>
                  {row.note ? <div className="hub-spec-sub">{row.note}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hub-spec-note">
          공통 회신: ok:boolean, held:boolean, reason?:string, candles:Candle[], hasMore, nextKey, quote. 실패해도 book이 있으면 잔고를 그린다. held면 재폭주 금지.
        </p>
      </section>
      <section className="hub-spec-api">
        <h3>자동매매 참조 TR · 화면 (openapi.kiwoom.com)</h3>
        <p>창은 ask(op:'tr', tr:'ka10075')만. 미배선은 허브가 held로 거절하고 키움으로 나가지 않는다. 배선된 것만 총량 안에서 호출.</p>
        <p>
          화면:{' '}
          {HUB_TR_SCREENS.map((s) => `${s.screen} ${s.name}(${s.tr.join(',')})`).join(' · ')}
        </p>
        <table>
          <thead>
            <tr>
              <th>TR</th>
              <th>이름</th>
              <th>그룹·화면</th>
              <th>경로</th>
              <th>레인</th>
              <th>배선</th>
              <th>자동매매</th>
              <th>한도</th>
            </tr>
          </thead>
          <tbody>
            {HUB_TR_CATALOG.map((t) => (
              <tr key={t.id}>
                <td>
                  <code>{t.id}</code>
                </td>
                <td>{t.name}</td>
                <td>
                  {t.group} · {t.screen || '-'}
                </td>
                <td>{t.path}</td>
                <td>{t.lane}</td>
                <td>{t.wired ? '배선' : '준비'}</td>
                <td>{t.auto ? '필수' : '선택'}</td>
                <td>
                  {t.rate}
                  {t.note ? ` · ${t.note}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
