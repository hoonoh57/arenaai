import React from 'react';
import type {Formula} from '../../shared/formula';

/** 싱글·멀티 공통 매매 막대. 허브 /api/trade·/api/book 만 호출한다. */
export function TradeBar({
  code,
  status = 'wait',
  inPos,
  locked,
  strategyId,
  systems,
  onTrade,
  onStrategy,
  onBuy,
  onSell,
  onLock,
}: {
  code: string;
  status?: 'wait' | 'run' | 'stop' | 'backtest';
  inPos?: boolean;
  locked?: boolean;
  strategyId?: string;
  systems: Formula[];
  onTrade: (status: 'wait' | 'run' | 'stop' | 'backtest') => void;
  onStrategy?: (id: string) => void;
  onBuy: () => void;
  onSell: () => void;
  onLock?: () => void;
}) {
  if (!/^\d{6}$/.test(code)) return null;
  const label = inPos ? '매매중' : status === 'run' ? '적용' : status === 'backtest' ? '백테스트' : status === 'stop' ? '정지' : '대기';
  const next = status === 'wait' || status === 'stop' ? 'run' : status === 'run' ? 'backtest' : 'wait';
  const cls = inPos || status === 'run' ? 'run' : status === 'backtest' ? 'backtest' : 'wait';
  return (
    <span className="trade-bar" onMouseDown={(e) => e.stopPropagation()}>
      {onStrategy ? (
        <select
          className="strategy-select"
          value={strategyId || ''}
          title="이 종목 전략"
          onChange={(e) => onStrategy(e.target.value)}
        >
          <option value="">전략 없음</option>
          {systems.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        className={'trade-tag ' + cls}
        title="대기 → 적용(자동매매) → 백테스트. 신호만 나와도 적용해야 주문이 나갑니다."
        onClick={() => onTrade(next)}
      >
        {label}
      </button>
      <button className="hts-tool" title="시장 매수" onClick={onBuy}>
        매수
      </button>
      <button className="hts-tool" title="시장 매도" onClick={onSell}>
        매도
      </button>
      {onLock ? (
        <button className={'hts-tool' + (locked || inPos ? ' on' : '')} title="종목 잠금" onClick={onLock}>
          {locked || inPos ? '잠김' : '풀림'}
        </button>
      ) : null}
    </span>
  );
}
