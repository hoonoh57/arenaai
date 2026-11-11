import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseConditionRow,parseCandles} from './kiwoom';
test('조건검색 고정소수점과 종목 접두어 처리',()=>{assert.deepEqual(parseConditionRow({'9001':'A005930','302':'삼성전자','10':'-000070000','12':'000001500'}),{code:'005930',name:'삼성전자',price:70000,change:1.5});assert.equal(parseConditionRow({'9001':'J123456'}),null);assert.equal(parseConditionRow({'9001':'005930','10':'123','12':'-1.23'})?.change,-1.23);assert.throws(()=>parseConditionRow({'9001':'A005930','10':'100','12':''}));});
test('분봉을 KST에서 UTC로 변환하고 정렬 및 중복 제거',()=>{const row=(t:string)=>({cntr_tm:t,open_pric:'-100',high_pric:'+110',low_pric:'90',cur_prc:'105'});const candles=parseCandles([row('20260102090100'),row('20260102090000'),row('20260102090000'),row('invalid')]);assert.equal(candles.length,2);assert.equal(new Date(candles[0].time*1000).toISOString(),'2026-01-02T00:00:00.000Z');assert.equal(candles[0].open,100);assert.throws(()=>parseCandles(null));});
