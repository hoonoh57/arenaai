import 'dotenv/config';
import express from 'express';
import {createServer} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {Kiwoom} from './kiwoom';
import {rank,crossover,type Candle,type Stock,type Weights} from './core';

const mode=process.env.KIWOOM_MODE||'demo';
if(!['demo','mock','real'].includes(mode))throw new Error('Invalid KIWOOM_MODE');
const interval=Number(process.env.KIWOOM_REQUEST_INTERVAL_MS||300);if(!Number.isFinite(interval)||interval<200)throw new Error('KIWOOM_REQUEST_INTERVAL_MS must be >= 200');
const api=mode==='demo'?null:new Kiwoom(mode as 'mock'|'real',interval);
const names=[['005930','삼성전자'],['000660','SK하이닉스'],['042700','한미반도체'],['373220','LG에너지솔루션'],['005380','현대차'],['035420','NAVER'],['068270','셀트리온'],['012450','한화에어로스페이스'],['035720','카카오'],['000270','기아'],['105560','KB금융'],['051910','LG화학']];
const demoCandles=(index:number):Candle[]=>{const now=Math.floor(Date.now()/60000)*60;let price=40000+index*11700;return Array.from({length:100},(_,i)=>{const open=price;price=Math.max(100,Math.round(price*(1+Math.sin(i*.33+index)*.002+Math.cos(i*.13+index)*.001)));return {time:now-(99-i)*60,open,high:Math.max(open,price)+90,low:Math.min(open,price)-90,close:price};});};
let config={condition:'demo',count:4,weights:{change:40,strength:35,value:25} as Weights, running:false};
let conditions:{seq:string;name:string}[]=mode==='demo'?[{seq:'demo',name:'모멘텀 포착 (데모)'}]:[];
let ranking:Stock[]=[];let candles:Record<string,Candle[]>={};let updatedAt:number|null=null;let error='';let busy=false;let pending=false;let revision=0;const positions:Record<string,number>={};let events:{time:number;code:string;side:string;price:number}[]=[];const evaluated:Record<string,number>={};
async function refresh(){if(busy){pending=true;return;}busy=true;const startedRevision=revision;const snapshot={...config,weights:{...config.weights}};try{let raw:Omit<Stock,'score'>[];if(api){if(!snapshot.condition||snapshot.condition==='demo')throw new Error('조건식을 선택하세요.');raw=await api.search(snapshot.condition);}else raw=names.map(([code,name],i)=>({code,name,price:demoCandles(i).at(-1)!.close,change:Number((7.8-i*.48+Math.sin(Date.now()/60000+i)*.2).toFixed(2)),strength:Math.round(185-i*6+Math.sin(i)*12),value:Math.round((96-i*6)*100000000)}));
 const next=rank(raw,snapshot.weights);const selected=next.slice(0,snapshot.count);const nextCandles:Record<string,Candle[]>={};for(const stock of selected){const i=names.findIndex(x=>x[0]===stock.code);nextCandles[stock.code]=api?await api.candles(stock.code):demoCandles(Math.max(0,i));}
 if(startedRevision!==revision)return;ranking=next;candles=nextCandles;updatedAt=Date.now();error='';
 // Signals are based only on closed candles; no broker order is ever submitted.
 if(snapshot.running)for(const stock of selected){const closed=nextCandles[stock.code].filter(c=>c.time+60<=Math.floor(Date.now()/1000));const last=closed.at(-1);if(!last||evaluated[stock.code]===last.time)continue;evaluated[stock.code]=last.time;const signal=crossover(closed);if(signal==='BUY'&&!positions[stock.code]){positions[stock.code]=1;events.unshift({time:Date.now(),code:stock.code,side:'모의 매수',price:last.close});}else if(signal==='SELL'&&positions[stock.code]){delete positions[stock.code];events.unshift({time:Date.now(),code:stock.code,side:'모의 매도',price:last.close});}}events=events.slice(0,50);
 }catch(e){if(startedRevision===revision)error=e instanceof Error?e.message:'데이터 조회 오류';}finally{busy=false;if(pending){pending=false;void refresh();}}}
const app=express();app.use(express.json({limit:'16kb'}));
app.get('/api/state',(_req,res)=>res.json({mode,config,conditions,ranking,candles,updatedAt,error,busy,positions,events,orderMode:'paper'}));
app.post('/api/conditions',async(_req,res)=>{try{conditions=api?await api.conditions():conditions;res.json({conditions});}catch(e){res.status(502).json({error:e instanceof Error?e.message:'조회 실패'});}});
app.post('/api/config',(req,res)=>{const {condition,count,weights,running}=req.body; if(typeof condition!=='string'||!conditions.some(c=>c.seq===condition)||!Number.isInteger(count)||count<1||count>10||typeof running!=='boolean'||!weights||!['change','strength','value'].every(k=>typeof weights[k]==='number'&&Number.isFinite(weights[k])&&weights[k]>=0&&weights[k]<=100)||weights.change+weights.strength+weights.value<=0){res.status(400).json({error:'설정값을 확인하세요.'});return;}config={condition,count,weights:{change:weights.change,strength:weights.strength,value:weights.value},running};revision++;void refresh();res.json({ok:true});});
app.post('/api/refresh',(_req,res)=>{void refresh();res.json({ok:true});});
const server=createServer(app);const vite=await createViteServer({server:{middlewareMode:true,allowedHosts:true},appType:'spa'});app.use(vite.middlewares);server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Dashboard listening on ${process.env.PORT||3000} (${mode})`));void refresh();setInterval(()=>void refresh(),60000);
