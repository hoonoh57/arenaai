import {evaluate,type Formula} from './formula';
import type {Candle} from '../server/core';
export type BacktestTrade={direction:'long'|'short';entryTime:number;exitTime:number;entryPrice:number;exitPrice:number;pnl:number;reason:'signal'|'stop'|'target'};
export type PositionMode='long'|'short'|'both';
export type BacktestOptions={slippageBps?:number;positionMode?:PositionMode;stopLossPct?:number;takeProfitPct?:number;startTime?:number;endTime?:number};
export type BacktestResult={trades:BacktestTrade[];totalPnl:number;wins:number;maxDrawdown:number;openPosition:'long'|'short'|null;bars:number;feeBps:number;slippageBps:number;positionMode:PositionMode;stopLossPct:number;takeProfitPct:number;};
/** Signals at closed bar i are executed at the next bar's open, one share, no forced liquidation. */
export function backtest(candles:Candle[],strategy:Formula,all:Formula[],feeBps:number,options:BacktestOptions={}):BacktestResult{
 if(strategy.kind!=='system')throw new Error('시스템 전략을 선택하세요.');
 if(!Number.isFinite(feeBps)||feeBps<0||feeBps>1000)throw new Error('비용은 0~1000bp로 입력하세요.');
 const slip=options.slippageBps??0,mode=options.positionMode??'both',stop=options.stopLossPct??0,target=options.takeProfitPct??0,start=options.startTime??-Infinity,end=options.endTime??Infinity;
 if(typeof start!=='number'||typeof end!=='number'||Number.isNaN(start)||Number.isNaN(end)||start>end)throw new Error('백테스트 기간을 확인하세요.');
 if(!Number.isFinite(slip)||slip<0||slip>1000||!['long','short','both'].includes(mode))throw new Error('슬리피지 또는 포지션 설정을 확인하세요.');
 if(!Number.isFinite(stop)||!Number.isFinite(target)||stop<0||target<0||stop>100||target>1000)throw new Error('손절·목표 수익률 설정을 확인하세요.');
 if(candles.some((c,i)=>!Number.isFinite(c.time)||!Number.isFinite(c.close)||c.close<=0||!Number.isFinite(c.open)||c.open<=0||i>0&&c.time<=candles[i-1].time))throw new Error('봉 데이터가 올바르지 않습니다.');
 const signals=[strategy.expression,strategy.exitExpression,strategy.shortEntry,strategy.shortExit].map(expr=>expr?evaluate(expr,candles,strategy.variables,all):Array(candles.length).fill(null));
 let position:{direction:'long'|'short';entryTime:number;entryPrice:number}|null=null;const trades:BacktestTrade[]=[];const fee=feeBps/10000,slippage=slip/10000;
 for(let i=1;i<candles.length;i++){
  const candle=candles[i];if(candle.time<start||candle.time>end)continue;const [buy,exit,short,cover]=signals.map(s=>candles[i-1].time>=start&&Boolean(s[i-1]));
  if(position){const previous=candles[i-1].close;const move=(position.direction==='long'?previous-position.entryPrice:position.entryPrice-previous)/position.entryPrice*100;const stopHit=stop>0&&move<=-stop,targetHit=target>0&&move>=target;const close=position.direction==='long'?exit:cover;if(stopHit||targetHit||close){const price=candle.open*(position.direction==='long'?1-slippage:1+slippage);const gross=position.direction==='long'?price-position.entryPrice:position.entryPrice-price;trades.push({direction:position.direction,entryTime:position.entryTime,exitTime:candle.time,entryPrice:position.entryPrice,exitPrice:price,pnl:gross-(position.entryPrice+price)*fee,reason:stopHit?'stop':targetHit?'target':'signal'});position=null;}continue;}
  const goLong=mode!=='short'&&buy,goShort=mode!=='long'&&short;if(goLong===goShort)continue;position={direction:goLong?'long':'short',entryTime:candle.time,entryPrice:candle.open*(goLong?1+slippage:1-slippage)};
 }
 let totalPnl=0,peak=0,maxDrawdown=0;for(const trade of trades){totalPnl+=trade.pnl;peak=Math.max(peak,totalPnl);maxDrawdown=Math.max(maxDrawdown,peak-totalPnl);}
 return {trades,totalPnl,wins:trades.filter(t=>t.pnl>0).length,maxDrawdown,openPosition:position?.direction||null,bars:candles.filter(c=>c.time>=start&&c.time<=end).length,feeBps,slippageBps:slip,positionMode:mode,stopLossPct:stop,takeProfitPct:target};
}
