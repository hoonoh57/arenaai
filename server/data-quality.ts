import type {Candle} from './core';

// A signal is only eligible if the latest fully closed minute is recent.
// An absent or old candle is not evidence that a market is open or liquid.
export function signalDataStatus(candles:Candle[], nowSeconds:number, maxAgeSeconds=120):{ok:boolean; reason:string; closed:Candle[]} {
 if(!Number.isFinite(nowSeconds)||!Number.isFinite(maxAgeSeconds)||maxAgeSeconds<0) throw new Error('유효하지 않은 데이터 검사 시간');
 if(candles.some(c=>!Number.isInteger(c.time)||c.time>nowSeconds+60)) return {ok:false,reason:'미래 또는 유효하지 않은 봉 시각',closed:[]};
 const closed=candles.filter(c=>c.time+60<=nowSeconds);
 const last=closed.at(-1);
 if(!last)return {ok:false,reason:'확정 1분봉 없음',closed};
 if(nowSeconds-(last.time+60)>maxAgeSeconds)return {ok:false,reason:'확정 1분봉 지연',closed};
 const tail=closed.slice(-20);
 let holes=0;
 for(let i=1;i<tail.length;i++){
  const dt=tail[i].time-tail[i-1].time;
  if(dt<=120) continue;
  const hour=new Date((tail[i-1].time+9*3600)*1000).getUTCHours();
  if(dt<=5400 && hour>=11 && hour<=13) continue;
  holes+=1;
 }
 if(holes>0) return {ok:false,reason:'분봉 공백(재시작 갭). 신호 없음',closed};
 return {ok:true,reason:'',closed};
}
