import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate,validateFormula,defaults,seriesColors} from '../shared/formula';
import {validateSet} from './formulas';
const candles=[1,2,3,4,3,2,1,4,5].map((close,time)=>({time:time*60,open:close,high:close,low:close,close}));
test('이동평균, 참조, 산술, 논리 및 교차를 확정 시점까지 계산',()=>{assert.deepEqual(evaluate('SMA(CLOSE, 3)',candles),[null,null,2,3,10/3,3,2,7/3,10/3]);assert.deepEqual(evaluate('REF(CLOSE, 1)',candles),[null,1,2,3,4,3,2,1,4]);assert.deepEqual(evaluate('CROSSUP(CLOSE, SMA(CLOSE, 3))',candles),[null,null,null,0,0,0,0,1,0]);assert.equal(evaluate('CLOSE > 3 && OPEN == CLOSE',candles)[3],1);assert.equal(evaluate('CLOSE / 0',candles)[0],null);});
test('EMA 초기화와 데이터 부족',()=>{assert.deepEqual(evaluate('EMA(CLOSE, 3)',candles).slice(0,4),[null,null,2,3]);assert.deepEqual(evaluate('SMA(CLOSE, 20)',candles),Array(9).fill(null));});
test('임의 코드 실행 및 범위 밖 기간 거부',()=>{for(const expression of ['globalThis.process','constructor(1)','SMA(CLOSE, 0)','SMA(CLOSE, CLOSE)','CLOSE[0]'])assert.throws(()=>evaluate(expression,candles),expression);});
test('수식 세트 유효성 및 중복 시스템 방지',()=>{defaults.forEach(f=>validateFormula(f));assert.equal(validateSet(defaults).length,defaults.length);assert.throws(()=>validateSet([...defaults,{...defaults[2],id:'another'}]));assert.throws(()=>validateSet([...defaults,defaults[0]]));});

test('키움 형식 변수, 주석, 과거 봉 및 기본 함수',()=>{const f='// 교차 신호\nA=avg(C, 단기); B=avg(C, 장기); if(Crossup(A,B),1,0)';const values=evaluate(f,candles,{단기:2,장기:3});assert.deepEqual(values,evaluate('CROSSUP(SMA(CLOSE,2),SMA(CLOSE,3))',candles));assert.deepEqual(evaluate('종가(1)',candles),evaluate('REF(CLOSE,1)',candles));assert.deepEqual(evaluate('V',candles),Array(candles.length).fill(null));assert.deepEqual(evaluate('V',candles.map(c=>({...c,volume:42}))),Array(candles.length).fill(42));assert.throws(()=>evaluate('avg(C, 기간)',candles,{기간:0}));});
test('Supertrend·JMA·VWAP 등 확장 지표',()=>{
 const bars=Array.from({length:30},(_,i)=>({time:1_700_000_000+i*60,open:100+i,high:101+i,low:99+i,close:100+i,volume:1000+i}));
 assert.ok(evaluate('JMA(7, 50, 2)',bars).at(-1));
 assert.ok(evaluate('ST(7, 3)',bars).at(-1));
 assert.ok(evaluate('ADX(5)',bars).at(-1)!>=0);
 assert.ok(evaluate('VWAP()',bars).at(-1));
 assert.ok(evaluate('HMA(CLOSE, 8)',bars).at(-1));
 assert.ok(evaluate('PLOT(SMA(CLOSE, 3))',bars).at(-1));
 assert.ok(evaluate('DCHIGH(5)',bars).at(-1)!>=evaluate('DCLOW(5)',bars).at(-1)!);
});
test('JMA는 kiwoom-desk 워밍업·재귀 값과 같다',()=>{
 const bars=[10,20,30,40].map((close,i)=>({time:i+1,open:close,high:close,low:close,close}));
 assert.deepEqual(evaluate('JMA(3, 50, 2)',bars),[10,15,20,37.2569]);
 const up=seriesColors([10,15,20,37.2569],'#AB47BC',{colorMode:'previous',alternateColor:'#00C853'});
 assert.ok(up.every(c=>c==='#AB47BC'));
});
test('체결강도 0은 직전 값을 쓰고 이평에 넣는다',()=>{
 const bars=[80,0,90,0,100].map((strength,i)=>({time:i*60,open:1,high:1,low:1,close:1,strength}));
 assert.deepEqual(evaluate('STRENGTH',bars),[80,80,90,90,100]);
 assert.equal(evaluate('SMA(STRENGTH, 3)',bars)[4], (90+90+100)/3);
 const long=[80,0,0,0,0].map((strength,i)=>({time:i*60,open:1,high:1,low:1,close:1,strength}));
 assert.deepEqual(evaluate('STRENGTH',long),[80,80,80,null,null]);
});
test('RSI·ATR 등 기본 기술적 지표',()=>{
 const up=Array.from({length:20},(_,i)=>({time:i*60,open:i+1,high:i+1.5,low:i+0.5,close:i+1,volume:10}));
 const rsi=evaluate('RSI(CLOSE, 14)',up);
 assert.ok(rsi.slice(0,13).every((v)=>v===null));
 assert.ok(rsi.at(-1)!>50);
 assert.ok(evaluate('ATR(5)',up).at(-1)!>0);
 assert.ok(evaluate('STOCHK(5)',up).every((v,i)=>i<4?v===null:v!==null&&v>=0&&v<=100));
 assert.ok(evaluate('BBUPPER(CLOSE, 5, 2)',up).at(-1)!>=evaluate('BBMID(CLOSE, 5)',up).at(-1)!);
});
test('조건·누적·고저·이벤트 함수',()=>{assert.equal(evaluate('IF(C>3, 10, 20)',candles)[3],10);assert.deepEqual(evaluate('HIGHEST(C,3)',candles).slice(2,5),[3,4,4]);assert.deepEqual(evaluate('LOWEST(C,3)',candles).slice(2,5),[1,2,3]);assert.deepEqual(evaluate('SUM(C,3)',candles).slice(2,4),[6,9]);assert.deepEqual(evaluate('BARSSINCE(C==4)',candles).slice(3,7),[0,1,2,3]);assert.deepEqual(evaluate('VALUEWHEN(1,C==4,C)',candles).slice(2,5),[null,4,4]);});
test('다중 지표 설정을 검증하고 기존 단일 수식과 함께 저장',()=>{
 const indicator={...defaults[0],pane:'separate' as const,variables:{기간:3},extraLines:[{name:'평균',expression:'avg(C,기간)',color:'#123456',visible:true},{name:'전봉',expression:'C(1)',color:'#654321',visible:false}],baselines:[{value:0,color:'#999999'}]};
 const saved=validateSet([indicator,defaults[1]]);assert.deepEqual(saved[0].extraLines,indicator.extraLines);assert.deepEqual(saved[0].baselines,indicator.baselines);assert.equal(saved[0].pane,'separate');assert.equal(saved[1].extraLines,undefined);
 assert.throws(()=>validateSet([{...indicator,extraLines:[...indicator.extraLines,...indicator.extraLines,...indicator.extraLines]}]));
 assert.throws(()=>validateSet([{...indicator,extraLines:[{...indicator.extraLines[0],expression:'unknown(C)'}]}]));
 assert.throws(()=>validateSet([{...indicator,baselines:[{value:NaN,color:'#999999'}]}]));
 assert.throws(()=>validateSet([{...defaults[2],extraLines:indicator.extraLines}]));
});
test('사용자 함수 선언, 중첩 호출, 변수 및 과거봉',()=>{
 const fn={...defaults[0],id:'fn',kind:'function' as const,name:'MAO(단기,장기)',expression:'A=avg(C,단기); B=avg(C,장기); A-B',enabled:false};
 const fn2={...fn,id:'fn2',name:'변화(기간)',expression:'A=MAO(기간, 3); A-A(1)'};
 const indicator={...defaults[0],id:'using',expression:'변화(2)',variables:{}};
 assert.doesNotThrow(()=>validateSet([fn,fn2,indicator]));
 const expected=evaluate('X=avg(C,2)-avg(C,3); X-X(1)',candles);
 assert.deepEqual(evaluate(indicator.expression,candles,{},[fn,fn2,indicator]),expected);
});
test('사용자 함수 중복과 순환 호출, 의존 함수 삭제 방지',()=>{
 const fn={...defaults[0],id:'fn',kind:'function' as const,name:'FIRST(기간)',expression:'SECOND(기간)',enabled:false};
 const second={...fn,id:'fn2',name:'SECOND(기간)',expression:'FIRST(기간)'};
 assert.throws(()=>validateSet([fn,second]),/순환/);
 assert.throws(()=>validateSet([fn]),/지원하지 않는 함수/);
 assert.throws(()=>validateSet([fn,{...second,name:'first(N)'}]),/중복/);
});
test('사용자 함수와 지표변수 충돌 및 호출 폭발을 방지',()=>{
 const fn={...defaults[0],id:'f',kind:'function' as const,name:'Fn(x)',expression:'x+1',enabled:false};
 assert.throws(()=>validateSet([fn,{...defaults[0],expression:'Fn(1)',variables:{Fn:1}}]),/중복/);
 const nested=Array.from({length:10},(_,i)=>({...fn,id:`f${i}`,name:`Fn${i}(x)`,expression:i===0?'x':`Fn${i-1}(x)+Fn${i-1}(x)`}));
 assert.throws(()=>validateSet(nested),/호출 횟수/);
});
test('키움 통계 함수의 과거 봉 인자와 한글 표기',()=>{
 for(const name of ['AVG','SMA','EAVG','EMA','WAVG','STDEV','HIGHEST','LOWEST','SUM','평균','지수평균','가중평균','표준편차','최고값','최저값','합계']){
  assert.deepEqual(evaluate(`${name}(C,3,2)`,candles),evaluate(`REF(${name}(C,3),2)`,candles),name);
 }
 assert.equal(evaluate('WAVG(C,3)',candles)[2],14/6);
 assert.ok(Math.abs(evaluate('STDEV(C,3)',candles)[2]!-Math.sqrt(2/3))<1e-12);
 assert.throws(()=>evaluate('avg(C,3,-1)',candles));
 assert.throws(()=>evaluate('avg(C,3,501)',candles));
});
test('수학 함수 및 거듭제곱 도메인',()=>{
 assert.equal(evaluate('2^3^2',candles)[0],512);
 assert.equal(evaluate('최대값(C,3)',candles)[0],3);
 assert.equal(evaluate('pow(C,2)',candles)[2],9);
 assert.equal(evaluate('sqrt(-1)',candles)[0],null);
 assert.equal(evaluate('log10(100)',candles)[0],2);
 assert.equal(evaluate('sin(0)',candles)[0],0);
});
test('라인 스타일 저장 및 유효성 검사',()=>{
 const f={...defaults[0],primaryLine:{visible:false,width:3 as const,style:'dotted' as const},extraLines:[{name:'추가',expression:'C',color:'#ffffff',visible:true,width:2 as const,style:'dashed' as const}],baselines:[{value:100,color:'#ff0000',width:4 as const,style:'solid' as const}]};
 const out=validateSet([f])[0];assert.deepEqual(out.primaryLine,f.primaryLine);assert.equal(out.extraLines?.[0].width,2);assert.equal(out.baselines?.[0].style,'solid');
 assert.throws(()=>validateSet([{...f,primaryLine:{width:5}}]));assert.throws(()=>validateSet([{...f,baselines:[{value:0,color:'#ff0000',style:'bad'}]}]));
});
test('조건 이후 누적 함수',()=>{const c=[0,1,2,3,4,5].map((close,i)=>({time:i,open:close,high:close,low:close,close}));assert.deepEqual(evaluate('COUNTSINCE(C==2,C>2)',c),[null,null,0,1,2,3]);assert.deepEqual(evaluate('HIGHESTSINCE(C==2,C)',c),[null,null,2,3,4,5]);assert.deepEqual(evaluate('LOWESTSINCE(C==2,C)',c),[null,null,2,2,2,2]);});
test('막대 표시 및 자동 색상 설정',()=>{const f={...defaults[0],primaryLine:{type:'histogram' as const,colorMode:'previous' as const,alternateColor:'#123456'}};assert.deepEqual(validateSet([f])[0].primaryLine,f.primaryLine);assert.throws(()=>validateSet([{...f,primaryLine:{...f.primaryLine,threshold:NaN}}]));});

test('자동 색상은 기준값 및 이전 유효 봉과 비교',()=>{assert.deepEqual(seriesColors([null,1,2,1], '#ff0000',{colorMode:'previous',alternateColor:'#0000ff'}),['#ff0000','#ff0000','#ff0000','#0000ff']);assert.deepEqual(seriesColors([-1,0,1],'#ff0000',{colorMode:'threshold',threshold:0,alternateColor:'#0000ff'}),['#0000ff','#ff0000','#ff0000']);});
test('MA 선택자와 과거 봉 인자를 단순·지수·가중 평균에 연결',()=>{for(const [mode,func] of [['단순','AVG'],['지수','EAVG'],['가중','WAVG'],['SIMPLE','AVG']]){assert.deepEqual(evaluate(`MA(C,3,${mode})`,candles),evaluate(`${func}(C,3)`,candles));assert.deepEqual(evaluate(`MA(C,3,${mode},2)`,candles),evaluate(`${func}(C,3,2)`,candles));}assert.throws(()=>evaluate('MA(C,3,잘못됨)',candles));assert.throws(()=>evaluate('MA(C,3,1)',candles));});
test('한국 시간 날짜·시간 및 안전한 과거 방향 이동',()=>{const t=Date.parse('2025-03-04T00:00:00Z')/1000;const c=[0,1].map(i=>({time:t+i*60,open:1,high:2,low:1,close:2}));assert.deepEqual(evaluate('DATE',c),[20250304,20250304]);assert.deepEqual(evaluate('TIME',c),[90000,90100]);assert.deepEqual(evaluate('일자(1)',c),[null,20250304]);assert.deepEqual(evaluate('SHIFT(C,1)',c),[null,2]);assert.throws(()=>evaluate('SHIFT(C,-1)',c));});
test('장중 데이터는 정규장 시작과 빈틈없는 봉에서만 계산',()=>{const t=Date.parse('2025-03-04T00:00:00Z')/1000;const row=(i:number,high:number)=>({time:t+i*60,open:10,high,low:8,close:10});const c=[row(0,11),row(1,12),row(3,15)];assert.deepEqual(evaluate('DAYOPEN()',c),[10,10,null]);assert.deepEqual(evaluate('DAYHIGH()',c),[11,12,null]);assert.deepEqual(evaluate('DAYLOW()',c),[8,8,null]);assert.deepEqual(evaluate('DAYOPEN()',c.slice(1)),[null,null]);});
test('전일 시세와 실제 제공된 봉별 거래대금만 사용',()=>{const c=[{time:0,open:100,high:120,low:90,close:110,turnover:15000,previousDay:{date:'20250101',open:90,high:115,low:85,close:100}},{time:60,open:110,high:120,low:100,close:115}];assert.deepEqual(evaluate('PREDAYOPEN()',c),[90,null]);assert.deepEqual(evaluate('PredayHigh()+PredayLow()',c),[200,null]);assert.deepEqual(evaluate('PredayClose()',c),[100,null]);assert.deepEqual(evaluate('ACCOUNT',c),[15000,null]);assert.deepEqual(evaluate('거래대금(1)',c),[null,15000]);});
