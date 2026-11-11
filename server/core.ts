export type PreviousDay = {date:string;open?:number;high?:number;low?:number;close?:number};
export type Candle = {time:number; open:number; high:number; low:number; close:number; volume?:number; turnover?:number; previousDay?:PreviousDay};
export type Stock = {code:string; name:string; price:number; change:number; strength:number; value:number; score:number};
export type Weights = {change:number; strength:number; value:number};

// A single serial queue shared by every REST request. A rejected task never poisons the queue.
export class RateQueue {
 private tail:Promise<void> = Promise.resolve(); private last=0;
 constructor(private interval:number) {}
 run<T>(task:()=>Promise<T>):Promise<T> {
  const result=this.tail.then(async()=>{const wait=Math.max(0,this.last+this.interval-Date.now()); if(wait) await new Promise(r=>setTimeout(r,wait)); this.last=Date.now(); return task();});
  this.tail=result.then(()=>{},()=>{}); return result;
 }
}
export function rank(items: Omit<Stock,'score'>[], weights:Weights):Stock[] {
 const sum=weights.change+weights.strength+weights.value;
 if(!Number.isFinite(sum)||sum<=0||Object.values(weights).some(x=>!Number.isFinite(x)||x<0)) throw new Error('가중치는 0 이상이며 합계는 0보다 커야 합니다.');
 // Percentile ranks avoid mixing incompatible units. Ties receive the same percentile.
 const percentile=(value:number, values:number[])=>values.length<=1?1:values.filter(x=>x<value).length/(values.length-1);
 return items.map(s=>({...s,score:100*(weights.change*percentile(s.change,items.map(x=>x.change))+weights.strength*percentile(s.strength,items.map(x=>x.strength))+weights.value*percentile(s.value,items.map(x=>x.value)))/sum})).sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code)).slice(0,10);
}
export function sma(candles:Candle[], period:number):{time:number;value:number}[] {
 const out:{time:number;value:number}[]=[]; let sum=0;
 candles.forEach((c,i)=>{sum+=c.close;if(i>=period) sum-=candles[i-period].close;if(i>=period-1) out.push({time:c.time,value:sum/period});}); return out;
}
export function crossover(candles:Candle[]):'BUY'|'SELL'|null {
 if(candles.length<21)return null;
 const fast=sma(candles,5),slow=sma(candles,20); const f=fast.slice(-2),s=slow.slice(-2);
 if(f[0].value<=s[0].value&&f[1].value>s[1].value)return 'BUY';
 if(f[0].value>=s[0].value&&f[1].value<s[1].value)return 'SELL'; return null;
}
