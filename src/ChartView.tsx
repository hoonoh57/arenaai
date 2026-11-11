import React,{useEffect,useRef} from 'react';
import {createChart,CandlestickSeries,LineSeries,HistogramSeries,ColorType,LineStyle,PriceScaleMode,createSeriesMarkers,type UTCTimestamp,type SeriesMarker} from 'lightweight-charts';
import type {Candle} from '../server/core';
import {evaluate,seriesColors,type Formula} from '../shared/formula';
export function Chart({data,formulas,chartHeight,grid,logScale}:{data:Candle[];formulas:Formula[];chartHeight:number;grid:boolean;logScale:boolean}){
 const ref=useRef<HTMLDivElement>(null);
 const separateCount=formulas.filter(f=>f.enabled&&f.kind==='indicator'&&f.pane==='separate').length;
 const height=chartHeight+separateCount*120;
 useEffect(()=>{
  if(!ref.current)return;
  const chart=createChart(ref.current,{autoSize:true,height,layout:{background:{type:ColorType.Solid,color:'#111923'},textColor:'#718395'},localization:{timeFormatter:(t: number | string | object)=>new Date(Number(t)*1000).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})},grid:{vertLines:{color:'#1a2733',visible:grid},horzLines:{color:'#1a2733',visible:grid}},rightPriceScale:{borderVisible:false},timeScale:{borderVisible:false,timeVisible:true,secondsVisible:false,tickMarkFormatter:(t: number | string | object)=>new Date(Number(t)*1000).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false})},crosshair:{vertLine:{color:'#516576'},horzLine:{color:'#516576'}}});
  const series=chart.addSeries(CandlestickSeries,{upColor:'#ed6b72',downColor:'#5d96e8',borderVisible:false,wickUpColor:'#ed6b72',wickDownColor:'#5d96e8'});
  chart.priceScale('right',0).applyOptions({mode:logScale?PriceScaleMode.Logarithmic:PriceScaleMode.Normal});
  const highlights=formulas.filter(f=>f.enabled&&f.kind==='highlight').map(f=>({formula:f,values:evaluate(f.expression,data,f.variables,formulas)}));
  series.setData(data.map((c,i)=>{const h=highlights.find(h=>h.values[i]);return {...c,time:c.time as UTCTimestamp,...(h?{color:h.formula.color,wickColor:h.formula.color}: {})};}));
  const markers:SeriesMarker<UTCTimestamp>[]=[];
  for(const f of formulas.filter(f=>f.enabled&&f.kind!=='function')){
   const values=evaluate(f.expression,data,f.variables,formulas);
   if(f.kind==='indicator'){
    const paneIndex=f.pane==='separate'?chart.addPane().paneIndex():0;
    const lines=[{name:f.name,expression:f.expression,color:f.color,...f.primaryLine,visible:f.primaryLine?.visible!==false},...(f.extraLines||[])];
    const styles={solid:LineStyle.Solid,dashed:LineStyle.Dashed,dotted:LineStyle.Dotted};let baselineAdded=false;
    for(const lineSpec of lines.filter(l=>l.visible)){
     const common={title:lineSpec.name,color:lineSpec.color,priceLineVisible:false,lastValueVisible:false};const line=lineSpec.type==='histogram'?chart.addSeries(HistogramSeries,common,paneIndex):chart.addSeries(LineSeries,{...common,lineWidth:lineSpec.width||1,lineStyle:styles[lineSpec.style||'solid']},paneIndex);
     const vals=lineSpec.expression===f.expression?values:evaluate(lineSpec.expression,data,f.variables,formulas);
     const colors=seriesColors(vals,lineSpec.color,lineSpec);line.setData(vals.map((value,i)=>value===null?{time:data[i].time as UTCTimestamp}:{time:data[i].time as UTCTimestamp,value,color:colors[i]}));
     if(!baselineAdded){for(const base of f.baselines||[])line.createPriceLine({price:base.value,color:base.color,lineWidth:base.width||1,lineStyle:styles[base.style||'dashed'],axisLabelVisible:true,title:'기준선'});baselineAdded=true;}
    }
   }
   if(f.kind==='signal'||f.kind==='system'){
    const exits=f.kind==='system'?evaluate(f.exitExpression,data,f.variables,formulas):[];
    data.forEach((c,i)=>{if(c.time+60>Math.floor(Date.now()/1000))return;if(values[i]&&exits[i])return;if(values[i])markers.push({time:c.time as UTCTimestamp,position:'belowBar',shape:'arrowUp',color:f.color,text:f.kind==='system'?'매수':f.name});if(exits[i])markers.push({time:c.time as UTCTimestamp,position:'aboveBar',shape:'arrowDown',color:'#ed6b72',text:'매도'});});
   }
  }
  createSeriesMarkers(series,markers.sort((a,b)=>Number(a.time)-Number(b.time)));chart.timeScale().fitContent();return()=>chart.remove();
 },[data,formulas,height,grid,logScale]);return <div ref={ref} className="chart" style={{height}}/>;
}
