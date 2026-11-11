import 'dotenv/config';
import express from 'express';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {Kiwoom,attachPreviousDays} from './kiwoom';
import {rank,type Candle,type Stock,type Weights} from './core';
import {evaluate} from '../shared/formula';
import {loadFormulas,saveFormulas} from './formulas';
import {backtest} from '../shared/backtest';

const mode=process.env.KIWOOM_MODE||'real';
if(!['mock','real'].includes(mode))throw new Error('Invalid KIWOOM_MODE');
const interval=Number(process.env.KIWOOM_REQUEST_INTERVAL_MS||300);if(!Number.isFinite(interval)||interval<200)throw new Error('KIWOOM_REQUEST_INTERVAL_MS must be >= 200');
const api=new Kiwoom(mode as 'mock'|'real',interval);
let config={condition:'',count:4,weights:{change:40,strength:35,value:25} as Weights, running:false};
let conditions:{seq:string;name:string}[]=[];
let formulas=loadFormulas();
let ranking:Stock[]=[];let candles:Record<string,Candle[]>={};let updatedAt:number|null=null;let error='';let busy=false;let pending=false;let revision=0;const positions:Record<string,number>={};let events:{time:number;code:string;side:string;price:number}[]=[];const evaluated:Record<string,number>={};
async function refresh(){if(busy){pending=true;return;}busy=true;const startedRevision=revision;const snapshot={...config,weights:{...config.weights}};const system=formulas.find(f=>f.enabled&&f.kind==='system');try{if(!snapshot.condition)throw new Error('조건식 목록을 불러온 후 조건식을 선택하세요.');const raw=await api.search(snapshot.condition);
 const next=rank(raw,snapshot.weights);const selected=next.slice(0,snapshot.count);const nextCandles:Record<string,Candle[]>={};for(const stock of selected){const minute=await api.candles(stock.code);const kst=new Date(Date.now()+9*3600000);const today=kst.toISOString().slice(0,10).replace(/-/g,'');const daily=await api.daily(stock.code,today);nextCandles[stock.code]=attachPreviousDays(minute,daily);}
 if(startedRevision!==revision)return;ranking=next;candles=nextCandles;updatedAt=Date.now();error='';
 // Signals are based only on closed candles; no broker order is ever submitted.
 if(snapshot.running&&system)for(const stock of selected){const closed=nextCandles[stock.code].filter(c=>c.time+60<=Math.floor(Date.now()/1000));const last=closed.at(-1);if(!last||evaluated[stock.code]===last.time)continue;evaluated[stock.code]=last.time;const buy=evaluate(system.expression,closed,system.variables,formulas).at(-1);const sell=evaluate(system.exitExpression,closed,system.variables,formulas).at(-1);if(buy&&sell)continue;if(buy&&!positions[stock.code]){positions[stock.code]=1;events.unshift({time:Date.now(),code:stock.code,side:'모의 매수',price:last.close});}else if(sell&&positions[stock.code]){delete positions[stock.code];events.unshift({time:Date.now(),code:stock.code,side:'모의 매도',price:last.close});}}events=events.slice(0,50);
 }catch(e){if(startedRevision===revision)error=e instanceof Error?e.message:'데이터 조회 오류';}finally{busy=false;if(pending){pending=false;void refresh();}}}
const app=express();app.use(express.json({limit:'16kb'}));
app.get('/api/state',(_req,res)=>res.json({mode,config,conditions,ranking,candles,updatedAt,error,busy,positions,events,formulas,orderMode:'paper'}));
app.put('/api/formulas',(req,res)=>{try{const updated=saveFormulas(req.body.formulas);formulas=updated;revision++;res.json({formulas});}catch(e){res.status(400).json({error:e instanceof Error?e.message:'수식 저장 실패'});}});
app.post('/api/backtest',(req,res)=>{try{const {code,feeBps,slippageBps,positionMode,stopLossPct,takeProfitPct,startDate,endDate}=req.body;const system=formulas.find(f=>f.enabled&&f.kind==='system');if(typeof code!=='string'||!candles[code])throw new Error('현재 차트에 표시된 종목만 테스트할 수 있습니다.');if(!system)throw new Error('활성 시스템 전략이 없습니다.');const parseDate=(v:unknown,end:boolean):number|undefined=>{if(v===undefined||v==='')return undefined;if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))throw new Error('날짜 형식을 확인하세요.');const ms=Date.parse(`${v}T00:00:00+09:00`);if(!Number.isFinite(ms)||new Date(ms+9*3600000).toISOString().slice(0,10)!==v)throw new Error('유효한 날짜를 입력하세요.');return Math.floor(ms/1000)+(end?86399:0);};const startTime=parseDate(startDate,false),endTime=parseDate(endDate,true);const closed=candles[code].filter(c=>c.time+60<=Math.floor(Date.now()/1000));if(closed.length<2)throw new Error('확정 1분봉이 부족합니다.');res.json({code,strategy:system.name,updatedAt,...backtest(closed,system,formulas,feeBps,{slippageBps,positionMode,stopLossPct,takeProfitPct,startTime,endTime})});}catch(e){res.status(400).json({error:e instanceof Error?e.message:'백테스트 실패'});}});
app.post('/api/conditions',async(_req,res)=>{try{conditions=await api.conditions();res.json({conditions});}catch(e){res.status(502).json({error:e instanceof Error?e.message:'조회 실패'});}});
app.post('/api/config',(req,res)=>{const {condition,count,weights,running}=req.body; if(typeof condition!=='string'||!conditions.some(c=>c.seq===condition)||!Number.isInteger(count)||count<1||count>10||typeof running!=='boolean'||!weights||!['change','strength','value'].every(k=>typeof weights[k]==='number'&&Number.isFinite(weights[k])&&weights[k]>=0&&weights[k]<=100)||weights.change+weights.strength+weights.value<=0){res.status(400).json({error:'설정값을 확인하세요.'});return;}if(condition!==config.condition){ranking=[];candles={};updatedAt=null;error='';}config={condition,count,weights:{change:weights.change,strength:weights.strength,value:weights.value},running};revision++;void refresh();res.json({ok:true});});
app.post('/api/refresh',(_req,res)=>{void refresh();res.json({ok:true});});
const server=createServer(app);const vite=await createViteServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares);server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Dashboard listening on ${process.env.PORT||3000} (${mode})`));void refresh();setInterval(()=>void refresh(),60000);
