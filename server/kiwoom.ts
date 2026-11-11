import WebSocket from 'ws';
import {RateQueue, type Candle, type Stock} from './core';

type ObjectRow = Record<string, unknown>;
function numeric(value: unknown, field: string): number {
 const text=String(value ?? '').trim().replace(/,/g,'');
 if (!text || !/^[+-]?\d+(\.\d+)?$/.test(text)) throw new Error(`키움 응답의 ${field} 값이 없습니다.`);
 const n=Number(text); if(!Number.isFinite(n))throw new Error(`키움 응답의 ${field} 값이 유효하지 않습니다.`);return n;
}
function kstTimestamp(value: unknown):number {
 const t=String(value ?? ''); if(!/^\d{14}$/.test(t))return NaN;
 return Date.parse(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}+09:00`);
}
export function parseConditionRow(row: ObjectRow): {code:string;name:string;price:number;change:number}|null {
 const raw=String(row['9001'] ?? '');
 // Only common stock codes (A prefix or bare code); exclude ELW/ETN.
 if(!/^(A?\d{6})$/.test(raw))return null;
 const rate=String(row['12'] ?? '').trim();
 // ka10172 documents fixed-width integer 000001500 as +1.50%.
 const change=numeric(rate,'등락률')/(rate.includes('.')?1:1000);
 return {code:raw.replace(/^A/,''),name:String(row['302']||raw),price:Math.abs(numeric(row['10'],'현재가')),change};
}
export function parseCandles(rows:unknown):Candle[] {
 if(!Array.isArray(rows))throw new Error('분봉 응답 형식이 올바르지 않습니다.');
 const result:Candle[]=[];
 for(const x of rows){try{const time=kstTimestamp(x.cntr_tm)/1000;const open=Math.abs(numeric(x.open_pric,'시가')),high=Math.abs(numeric(x.high_pric,'고가')),low=Math.abs(numeric(x.low_pric,'저가')),close=Math.abs(numeric(x.cur_prc,'종가'));if(Number.isFinite(time)&&open>0&&low>0&&high>=Math.max(open,close,low)&&low<=Math.min(open,close))result.push({time,open,high,low,close});}catch{/* invalid rows must not become fabricated candles */}}
 return result.sort((a,b)=>a.time-b.time).filter((x,i,a)=>i===0||x.time!==a[i-1].time);
}
function checkResult(data:any, label:string){if(data.return_code!==undefined&&Number(data.return_code)!==0)throw new Error(`키움 ${label}: ${String(data.return_msg||'요청 실패')}`);}
export class Kiwoom {
 private token=''; private expires=0; private queue:RateQueue;
 private base:string; private wsBase:string;
 constructor(mode:'mock'|'real',interval:number){this.queue=new RateQueue(interval);this.base=mode==='real'?'https://api.kiwoom.com':'https://mockapi.kiwoom.com';this.wsBase=mode==='real'?'wss://api.kiwoom.com:10000':'wss://mockapi.kiwoom.com:10000';}
 private async auth(){
  if(this.token&&Date.now()<this.expires)return this.token;
  const key=process.env.KIWOOM_APP_KEY,secret=process.env.KIWOOM_SECRET_KEY;if(!key||!secret)throw new Error('.env에 키움 API 키를 설정하고 서버를 재시작하세요.');
  const r=await fetch(this.base+'/oauth2/token',{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8'},body:JSON.stringify({grant_type:'client_credentials',appkey:key,secretkey:secret}),signal:AbortSignal.timeout(15000)});
  const d=await r.json() as any;if(!r.ok)throw new Error(`키움 인증 HTTP 오류: ${r.status}`);checkResult(d,'인증');
  const expiry=kstTimestamp(d.expires_dt);if(!d.token||!Number.isFinite(expiry)||expiry<=Date.now())throw new Error('키움 토큰 또는 만료일이 유효하지 않습니다.');
  this.token=d.token;this.expires=expiry-60000;return this.token;
 }
 async rest(path:string,id:string,body:object):Promise<any>{return this.queue.run(async()=>{const token=await this.auth();const r=await fetch(this.base+path,{method:'POST',headers:{'Content-Type':'application/json;charset=UTF-8',authorization:`Bearer ${token}`,'api-id':id},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const d=await r.json() as any;if(!r.ok)throw new Error(`키움 ${id}: HTTP ${r.status}`);checkResult(d,id);return d;});}
 async wsRequest(body:Record<string,string>):Promise<any>{return this.queue.run(async()=>{const token=await this.auth();return new Promise((resolve,reject)=>{const ws=new WebSocket(this.wsBase+'/api/dostk/websocket');let done=false;const timer=setTimeout(()=>finish(new Error('조건검색 시간 초과')),15000);const finish=(err?:Error,data?:any)=>{if(done)return;done=true;clearTimeout(timer);ws.terminate();err?reject(err):resolve(data);};ws.on('open',()=>ws.send(JSON.stringify({trnm:'LOGIN',token})));ws.on('error',()=>finish(new Error('키움 조건검색 WebSocket 연결 오류')));ws.on('close',()=>finish(new Error('조건검색 연결 종료')));ws.on('message',raw=>{try{const d=JSON.parse(raw.toString());if(d.trnm==='PING'){ws.send(raw.toString());return;}if(d.trnm==='LOGIN'){checkResult(d,'WebSocket 로그인');ws.send(JSON.stringify(body));return;}if(d.trnm===body.trnm){checkResult(d,'조건검색');finish(undefined,d);}}catch(e){finish(e instanceof Error?e:new Error('조건검색 응답 오류'));}});});});}
 async conditions():Promise<{seq:string;name:string}[]>{const d=await this.wsRequest({trnm:'CNSRLST'});if(!Array.isArray(d.data))throw new Error('조건식 목록 응답 형식이 올바르지 않습니다.');return d.data.map((x:any)=>Array.isArray(x)?{seq:String(x[0]??''),name:String(x[1]??'')}:{seq:String(x.seq??''),name:String(x.name??'')}).filter((x:{seq:string;name:string})=>x.seq&&x.name);}
 async search(seq:string):Promise<Omit<Stock,'score'>[]>{
  let next='',more='N';const rows:ObjectRow[]=[];let pages=0;const keys=new Set<string>();
  do{const d=await this.wsRequest({trnm:'CNSRREQ',seq,search_type:'0',stex_tp:'K',cont_yn:more,next_key:next});if(!Array.isArray(d.data))throw new Error('조건검색 응답 형식이 올바르지 않습니다.');rows.push(...d.data);more=String(d.cont_yn||'N');next=String(d.next_key||'');if(++pages>100||more==='Y'&&(!next||keys.has(next)))throw new Error('조건검색 연속조회 키 오류');if(more==='Y')keys.add(next);}while(more==='Y');
  const unique=new Map<string,NonNullable<ReturnType<typeof parseConditionRow>>>();for(const row of rows){const stock=parseConditionRow(row);if(stock)unique.set(stock.code,stock);}
  const stocks:Omit<Stock,'score'>[]=[];for(const stock of unique.values()){const d=await this.rest('/api/dostk/mrkcond','ka10046',{stk_cd:stock.code});const q=d.cntr_str_tm?.[0];if(!q)throw new Error(`${stock.code} 체결강도 데이터 없음`);stocks.push({...stock,strength:numeric(q.cntr_str,'체결강도'),value:Math.abs(numeric(q.acc_trde_prica,'누적거래대금'))});}return stocks;
 }
 async candles(code:string):Promise<Candle[]>{const d=await this.rest('/api/dostk/chart','ka10080',{stk_cd:code,tic_scope:'1',upd_stkpc_tp:'1'});return parseCandles(d.stk_min_pole_chart_qry);}
}
