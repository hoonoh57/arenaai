import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,validateFormula,defaults} from '../shared/formula';
import {validateSet} from './formulas';
const candles=[1,2,3,4,3,2,1,4,5].map((close,time)=>({time:time*60,open:close,high:close,low:close,close}));
test('이동평균, 참조, 산술, 논리 및 교차를 확정 시점까지 계산',()=>{assert.deepEqual(evaluate('SMA(CLOSE, 3)',candles),[null,null,2,3,10/3,3,2,7/3,10/3]);assert.deepEqual(evaluate('REF(CLOSE, 1)',candles),[null,1,2,3,4,3,2,1,4]);assert.deepEqual(evaluate('CROSSUP(CLOSE, SMA(CLOSE, 3))',candles),[null,null,null,0,0,0,0,1,0]);assert.equal(evaluate('CLOSE > 3 && OPEN == CLOSE',candles)[3],1);assert.equal(evaluate('CLOSE / 0',candles)[0],null);});
test('EMA 초기화와 데이터 부족',()=>{assert.deepEqual(evaluate('EMA(CLOSE, 3)',candles).slice(0,4),[null,null,2,3]);assert.deepEqual(evaluate('SMA(CLOSE, 20)',candles),Array(9).fill(null));});
test('임의 코드 실행 및 범위 밖 기간 거부',()=>{for(const expression of ['globalThis.process','constructor(1)','SMA(CLOSE, 0)','SMA(CLOSE, CLOSE)','CLOSE[0]','CLOSE; 1'])assert.throws(()=>evaluate(expression,candles),expression);});
test('수식 세트 유효성 및 중복 시스템 방지',()=>{defaults.forEach(validateFormula);assert.equal(validateSet(defaults).length,3);assert.throws(()=>validateSet([...defaults,{...defaults[2],id:'another'}]));assert.throws(()=>validateSet([...defaults,defaults[0]]));});
