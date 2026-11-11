import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signalDataStatus} from './data-quality';
import {parseCandles} from './kiwoom';
const candle=(time:number)=>({time,open:1,high:1,low:1,close:1});
test('stale and future candles cannot generate signals',()=>{
 assert.equal(signalDataStatus([candle(900)],1000).ok,true);
 assert.equal(signalDataStatus([candle(800)],1000).ok,false);
 assert.equal(signalDataStatus([candle(1080)],1000).ok,false);
 assert.equal(signalDataStatus([candle(990)],1000).ok,false);
});
test('invalid calendar dates are not silently normalized',()=>{
 const row={cntr_tm:'20260230090000',open_pric:'100',high_pric:'110',low_pric:'90',cur_prc:'105'};
 assert.deepEqual(parseCandles([row]),[]);
});
