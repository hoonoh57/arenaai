import jsep, {type Expression} from 'jsep';
import type {Candle} from '../server/core';
// Kiwoom documents ^ as exponentiation, not JavaScript's bitwise XOR.
jsep.addBinaryOp('^', 11, true);
export type Kind='indicator'|'signal'|'highlight'|'system'|'function';
export type LineStyleName='solid'|'dashed'|'dotted';
export type LineOptions={width?:1|2|3|4;style?:LineStyleName;visible?:boolean;type?:'line'|'histogram';colorMode?:'fixed'|'threshold'|'previous'|'st';threshold?:number;alternateColor?:string};
export type IndicatorLine=LineOptions & {name:string;expression:string;color:string;visible:boolean};
export type Baseline={value:number;color:string;width?:1|2|3|4;style?:LineStyleName};
export type Formula={id:string;name:string;kind:Kind;expression:string;exitExpression:string;shortEntry?:string;shortExit?:string;enabled:boolean;color:string;alternateColor?:string;variables?:Record<string,number>;description?:string; extraLines?:IndicatorLine[]; primaryLine?:LineOptions; pane?:'price'|'separate'; baselines?:Baseline[]};
export const kinds:Record<Kind,string>={indicator:'지표',signal:'신호',highlight:'강세약세',system:'시스템트레이딩',function:'일반함수'};
export const defaults:Formula[]=[
 {id:'ma5',name:'이동평균 5',kind:'indicator',expression:'SMA(CLOSE, 5)',exitExpression:'',enabled:true,color:'#e8bd64'},
 {id:'ma20',name:'이동평균 20',kind:'indicator',expression:'SMA(CLOSE, 20)',exitExpression:'',enabled:true,color:'#8c83ec'},
 {id:'cross',name:'이동평균 교차',kind:'system',expression:'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))',enabled:true,color:'#a8ec6a',exitExpression:'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))'},
 {id:'ma60',name:'이동평균 60',kind:'indicator',expression:'SMA(CLOSE, 60)',exitExpression:'',enabled:false,color:'#6ab0c8'},
 {id:'rsi14',name:'RSI 14',kind:'indicator',expression:'RSI(CLOSE, 14)',exitExpression:'',enabled:false,color:'#d48ad4',pane:'separate',baselines:[{value:70,color:'#ed6b72',style:'dashed'},{value:30,color:'#5d96e8',style:'dashed'}]},
 {id:'vol',name:'거래량',kind:'indicator',expression:'VOLUME',exitExpression:'',enabled:false,color:'#718395',pane:'separate',primaryLine:{type:'histogram'}},
 {id:'disparity',name:'이격도 20',kind:'indicator',expression:'CLOSE / SMA(CLOSE, 20) * 100',exitExpression:'',enabled:false,color:'#e8bd64',pane:'separate'},
 {id:'golden',name:'골든크로스',kind:'signal',expression:'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))',exitExpression:'',enabled:false,color:'#a8ec6a'},
 {id:'dead',name:'데드크로스',kind:'signal',expression:'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))',exitExpression:'',enabled:false,color:'#ed6b72'},
 {id:'upbar',name:'양봉',kind:'highlight',expression:'CLOSE > OPEN',exitExpression:'',enabled:false,color:'#ed6b72'},
 {id:'dnbar',name:'음봉',kind:'highlight',expression:'CLOSE < OPEN',exitExpression:'',enabled:false,color:'#5d96e8'},
 {id:'jma',name:'JMA',kind:'indicator',expression:'JMA(기간, phase, power)',exitExpression:'',enabled:false,color:'#AB47BC',alternateColor:'#00C853',variables:{기간:14,phase:50,power:2},description:'키움-desk JMA. JMA(기간, phase, power). 종가. 상승 보라·하락 초록.',primaryLine:{colorMode:'previous',alternateColor:'#00C853',width:2}},
 {id:'st',name:'Supertrend',kind:'indicator',expression:'ST(atr기간, 배수)',exitExpression:'',enabled:false,color:'#e34a4a',variables:{atr기간:14,배수:2},description:'키움-desk SuperTrend. ST(ATR기간, 배수). 상승 빨강·하락 파랑.',primaryLine:{colorMode:'st',alternateColor:'#3f7fd6',width:2}},
 {id:'adx',name:'ADX',kind:'indicator',expression:'ADX(14)',exitExpression:'',enabled:false,color:'#d48ad4',pane:'separate'},
 {id:'plusdi',name:'+DI',kind:'indicator',expression:'PLUSDI(14)',exitExpression:'',enabled:false,color:'#ed6b72',pane:'separate'},
 {id:'minusdi',name:'-DI',kind:'indicator',expression:'MINUSDI(14)',exitExpression:'',enabled:false,color:'#5d96e8',pane:'separate'},
 {id:'vwap',name:'VWAP',kind:'indicator',expression:'VWAP()',exitExpression:'',enabled:false,color:'#e8bd64'},
 {id:'hma',name:'Hull MA',kind:'indicator',expression:'HMA(CLOSE, 16)',exitExpression:'',enabled:false,color:'#a8ec6a'},
 {id:'alma',name:'ALMA',kind:'indicator',expression:'ALMA(CLOSE, 9)',exitExpression:'',enabled:false,color:'#8c83ec'},
 {id:'keltner',name:'켈트너 상단',kind:'indicator',expression:'KCUPPER(CLOSE, 20, 1.5)',exitExpression:'',enabled:false,color:'#ed6b72',extraLines:[{name:'하단',expression:'KCLOWER(CLOSE, 20, 1.5)',color:'#5d96e8',visible:true},{name:'중심',expression:'KCMID(CLOSE, 20)',color:'#e8bd64',visible:true}]},
 {id:'donchian',name:'돈치안 고가',kind:'indicator',expression:'DCHIGH(20)',exitExpression:'',enabled:false,color:'#ed6b72',extraLines:[{name:'저가',expression:'DCLOW(20)',color:'#5d96e8',visible:true}]},
 {id:'tsi',name:'TSI',kind:'indicator',expression:'TSI(25, 13)',exitExpression:'',enabled:false,color:'#7ec8e3',pane:'separate'},
 {id:'mfi',name:'MFI',kind:'indicator',expression:'MFI(14)',exitExpression:'',enabled:false,color:'#d48ad4',pane:'separate'},
 {id:'cntrstr',name:'체결강도',kind:'indicator',expression:'STRENGTH',exitExpression:'',enabled:false,color:'#e8bd64',pane:'separate',primaryLine:{type:'line',width:2},baselines:[{value:100,color:'#718395',style:'dashed'},{value:50,color:'#5d96e8',style:'dotted'}],extraLines:[{name:'5이평',expression:'SMA(STRENGTH, 5)',color:'#8c83ec',visible:true,width:1},{name:'20이평',expression:'SMA(STRENGTH, 20)',color:'#6ab0c8',visible:true,width:1},{name:'60이평',expression:'SMA(STRENGTH, 60)',color:'#ed6b72',visible:true,width:1}],description:'체결강도와 5·20·60 이평. 빈 봉은 최대 2봉만 직전 값으로 잇고, 그 이상은 그리지 않는다.'}
];
type Val=number|null;
const aliases:Record<string,string>=Object.assign(Object.create(null),{O:'open',OPEN:'open','시가':'open',H:'high',HIGH:'high','고가':'high',L:'low',LOW:'low','저가':'low',C:'close',CLOSE:'close','종가':'close',V:'volume',VOLUME:'volume','거래량':'volume',DATE:'date','일자':'date',TIME:'clock','시간':'clock',ACCOUNT:'turnover','거래대금':'turnover',STRENGTH:'strength','체결강도':'strength',MARKETCAP:'marketCap','시가총액':'marketCap'});
const functions:Record<string,[number,number]>=Object.assign(Object.create(null),{PREDAYOPEN:[0,0],PREDAYHIGH:[0,0],PREDAYLOW:[0,0],PREDAYCLOSE:[0,0],DAYOPEN:[0,0],DAYHIGH:[0,0],DAYLOW:[0,0],SHIFT:[2,2],'이동':[2,2],MA:[3,4],SMA:[2,3],AVG:[2,3],'평균':[2,3],EMA:[2,3],EAVG:[2,3],'지수평균':[2,3],WAVG:[2,3],'가중평균':[2,3],STDEV:[2,3],'표준편차':[2,3],REF:[2,2],CROSSUP:[2,2],'상향돌파':[2,2],CROSSDOWN:[2,2],'하향돌파':[2,2],IF:[3,3],'만일':[3,3],ABS:[1,1],'절대값':[1,1],MAX:[2,2],'최대값':[2,2],MIN:[2,2],'최소값':[2,2],POW:[2,2],'누승':[2,2],LOG:[1,1],'로그':[1,1],LOG10:[1,1],'상용로그':[1,1],SQRT:[1,1],'제곱근':[1,1],SIN:[1,1],'사인':[1,1],COS:[1,1],'코사인':[1,1],TAN:[1,1],'탄젠트':[1,1],ASIN:[1,1],'아크사인':[1,1],ACOS:[1,1],'아크코사인':[1,1],ATAN:[1,1],'아크탄젠트':[1,1],HIGHEST:[2,3],'최고값':[2,3],LOWEST:[2,3],'최저값':[2,3],SUM:[1,3],'합계':[1,3],COUNT:[2,2],COUNTSINCE:[2,2],HIGHESTSINCE:[2,2],LOWESTSINCE:[2,2],BARSSINCE:[1,1],VALUEWHEN:[3,3],ROC:[2,2],RSI:[2,2],RMA:[2,2],ATR:[1,1],TR:[0,0],STOCHK:[1,1],STOCHD:[2,2],BBMID:[2,2],BBUPPER:[3,3],BBLOWER:[3,3],CCI:[1,1],MOM:[2,2],WILLR:[1,1],OBV:[0,0],JMA:[3,3],HMA:[2,2],VWMA:[2,2],ALMA:[2,4],ADX:[1,1],PLUSDI:[1,1],MINUSDI:[1,1],ST:[2,2],STDIR:[2,2],VWAP:[0,0],KCMID:[2,2],KCUPPER:[3,3],KCLOWER:[3,3],DCHIGH:[1,1],DCLOW:[1,1],TSI:[2,2],MFI:[1,1],PLOT:[1,1],HLRATE:[1,1],NEARHIGH:[2,3],INRANGE:[3,3],UPBARS:[1,1],DOWNBARS:[1,1],DISPARITY:[2,2]});
const ops=['+','-','*','/','%','^','>','>=','<','<=','==','!=','&&','||'];
const key=(s:string)=>s.toUpperCase();
const functionAliases:Record<string,string>=Object.assign(Object.create(null),{'이동':'SHIFT','평균':'AVG','지수평균':'EAVG','가중평균':'WAVG','표준편차':'STDEV','최고값':'HIGHEST','최저값':'LOWEST','합계':'SUM','만일':'IF','절대값':'ABS','최대값':'MAX','최소값':'MIN','누승':'POW','로그':'LOG','상용로그':'LOG10','제곱근':'SQRT','사인':'SIN','코사인':'COS','탄젠트':'TAN','아크사인':'ASIN','아크코사인':'ACOS','아크탄젠트':'ATAN'});
const canonical=(s:string)=>functionAliases[s]||s;
const shifted=new Set(['SMA','AVG','EMA','EAVG','WAVG','STDEV','HIGHEST','LOWEST','SUM']);
type Statement={name?:string;ast:Expression};
type Definition={name:string;params:string[];expression:string};
type Catalog=Map<string,Definition>;
function functionCatalog(all:Formula[]):Catalog{
 const result:Catalog=new Map();
 for(const f of all.filter(x=>x.kind==='function')){const match=f.name.trim().match(/^([a-zA-Z_\uAC00-\uD7A3][\w\uAC00-\uD7A3]*)\s*\(([^()]*)\)$/);if(!match)throw new Error(`함수명은 이름(인자1,인자2) 형식이어야 합니다: ${f.name}`);const name=key(match[1]);const params=match[2].trim()?match[2].split(',').map(p=>p.trim()):[];if(name in aliases||name in functions||result.has(name)||['AND','OR','NOT'].includes(name)||params.length>10)throw new Error(`중복 또는 예약 함수명: ${match[1]}`);const check:Record<string,number>=Object.create(null);for(const p of params){if(Object.hasOwn(check,key(p)))throw new Error(`함수 인자 중복: ${p}`);check[key(p)]=1;}variableMap(check);result.set(name,{name,params:params.map(key),expression:f.expression});}
 return result;
}

function variableMap(variables:Record<string,number>={}):Map<string,number>{const map=new Map<string,number>();if(!variables||typeof variables!=='object'||Array.isArray(variables)||Object.keys(variables).length>50)throw new Error('지표변수는 최대 50개까지 사용할 수 있습니다.');for(const [name,value] of Object.entries(variables)){if(!/^[a-zA-Z_\uAC00-\uD7A3][\w\uAC00-\uD7A3]*$/.test(name)||key(name) in aliases||key(name) in functions||['AND','OR','NOT'].includes(key(name))||!Number.isFinite(value)||map.has(key(name)))throw new Error(`지표변수 오류: ${name}`);map.set(key(name),value);}return map;}
function parse(text:string,variables:Record<string,number>={},catalog:Catalog=new Map(),called?:Map<string,number>):Statement[]{
 if(typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('수식은 1~4000자여야 합니다.');
 const known=new Set(variableMap(variables).keys());for(const k of known)if(catalog.has(k))throw new Error(`변수와 함수명이 중복됩니다: ${k}`);const statements:Statement[]=[];let nodes=0;
 const normalized=text.replace(/\/\/[^\r\n]*/g,'').replace(/\bAND\b/gi,'&&').replace(/\bOR\b/gi,'||').replace(/\bNOT\b/gi,'!');
 const parts=normalized.split(';').map(x=>x.trim()).filter(Boolean);if(!parts.length||parts.length>30)throw new Error('수식은 최대 30개 문장까지 허용됩니다.');
 for(const part of parts){const assign=part.match(/^([a-zA-Z_\uAC00-\uD7A3][\w\uAC00-\uD7A3]*)\s*=(?!=)\s*([\s\S]+)$/);const name=assign?.[1];if(name&&(key(name) in aliases||key(name) in functions||catalog.has(key(name))||variableMap(variables).has(key(name))))throw new Error(`예약어 또는 지표변수에 대입할 수 없습니다: ${name}`);
 let ast:Expression;try{ast=jsep(assign?assign[2]:part);}catch{throw new Error('수식 문법을 확인하세요.');}
 function check(node:any,depth:number){if(++nodes>300||depth>30)throw new Error('수식이 너무 복잡합니다.');switch(node.type){
 case 'Literal':if(typeof node.value!=='number'||!Number.isFinite(node.value))throw new Error('숫자만 사용할 수 있습니다.');break;
 case 'Identifier':if(!(key(node.name) in aliases)&&!known.has(key(node.name)))throw new Error(`알 수 없는 필드 또는 변수: ${node.name}`);break;
 case 'UnaryExpression':if(!['-','+','!'].includes(node.operator))throw new Error('지원하지 않는 연산자입니다.');check(node.argument,depth+1);break;
 case 'BinaryExpression':case 'LogicalExpression':if(!ops.includes(node.operator))throw new Error('지원하지 않는 연산자입니다.');check(node.left,depth+1);check(node.right,depth+1);break;
 case 'CallExpression':{if(node.callee.type!=='Identifier')throw new Error('함수 이름이 올바르지 않습니다.');let n=key(node.callee.name);
 if(n==='MA'){if(node.arguments.length<3||node.arguments.length>4)throw new Error('MA는 MA(값, 기간, 단순|지수|가중[, 과거봉]) 형식입니다.');const mode=node.arguments[2];if(mode.type!=='Identifier')throw new Error('MA의 이평방법은 단순, 지수, 가중이어야 합니다.');const target:Record<string,string>={단순:'AVG',지수:'EAVG',가중:'WAVG',SIMPLE:'AVG',EXPONENTIAL:'EAVG',WEIGHTED:'WAVG'};const mapped=target[key(mode.name)];if(!mapped)throw new Error('지원하지 않는 MA 이평방법입니다.');node.callee.name=mapped;node.arguments.splice(2,1);n=mapped;}
 const spec=functions[n];if(catalog.has(n)){if(node.arguments.length!==catalog.get(n)!.params.length)throw new Error(`함수 인자 개수 오류: ${node.callee.name}`);if(called)called.set(n,(called.get(n)||0)+1);}else if(n in aliases||known.has(n)){if(node.arguments.length!==1)throw new Error('과거 봉 참조에는 인자가 하나 필요합니다.');}else if(!spec||node.arguments.length<spec[0]||node.arguments.length>spec[1])throw new Error(`지원하지 않는 함수 또는 인자 개수: ${node.callee.name}`);node.arguments.forEach((x:any)=>check(x,depth+1));
 const seriesRef=n in aliases||known.has(n);const periodIndex=seriesRef?0: ['SMA','AVG','EMA','EAVG','WAVG','STDEV','REF','SHIFT','HIGHEST','LOWEST','SUM','COUNT','ROC','RSI','RMA','MOM','BBMID','BBUPPER','BBLOWER','HMA','VWMA','ALMA','KCMID','KCUPPER','KCLOWER'].includes(canonical(n))&&node.arguments.length>1?1:['ATR','STOCHK','STOCHD','CCI','WILLR','ADX','PLUSDI','MINUSDI','ST','STDIR','JMA','DCHIGH','DCLOW','TSI','MFI','HLRATE','NEARHIGH','UPBARS','DOWNBARS'].includes(canonical(n))?0:n==='VALUEWHEN'?0:-1;
 if(periodIndex>=0){const p=node.arguments[periodIndex];const min=seriesRef||n==='REF'||canonical(n)==='SHIFT'?0:1;if(p.type==='Literal'){if(!Number.isInteger(p.value)||p.value<min||p.value>500)throw new Error(`기간은 ${min}~500의 정수여야 합니다.`);}else if(p.type==='Identifier'&&variableMap(variables).has(key(p.name))){const v=variableMap(variables).get(key(p.name))!;if(!Number.isInteger(v)||v<min||v>500)throw new Error(`기간은 ${min}~500의 정수여야 합니다.`);}else throw new Error('기간은 정수 또는 지표변수여야 합니다.');}
 if(shifted.has(canonical(n))&&node.arguments.length===3){const p=node.arguments[2];const v=p.type==='Literal'?p.value:p.type==='Identifier'?variableMap(variables).get(key(p.name)):undefined;if(typeof v!=='number'||!Number.isInteger(v)||v<0||v>500)throw new Error('과거 봉은 0~500의 정수 또는 지표변수여야 합니다.');}break;}
 default:throw new Error('지원하지 않는 수식 구문입니다.');}}
 check(ast,0);statements.push({name:name&&key(name),ast});if(name)known.add(key(name));
 }
 return statements;
}
export function validateFormula(f:Formula,all:Formula[]=[]){const catalog=functionCatalog(all);if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(f.id)||typeof f.name!=='string'||!f.name.trim()||f.name.length>60||!Object.keys(kinds).includes(f.kind)||typeof f.enabled!=='boolean'||typeof f.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(f.color)||typeof f.expression!=='string'||typeof f.exitExpression!=='string'||(f.description!==undefined&&(typeof f.description!=='string'||f.description.length>2000)))throw new Error('수식 설정이 올바르지 않습니다.');if(f.kind==='function'){const match=functionCatalog([f]).values().next().value as Definition;parse(f.expression,Object.fromEntries(match.params.map(p=>[p,1])),catalog);}else parse(f.expression,f.variables,catalog);if(f.kind==='system'){parse(f.exitExpression,f.variables,catalog);if((f.shortEntry||f.shortExit)){if(!f.shortEntry||!f.shortExit)throw new Error('매도 진입과 매도 청산 수식을 모두 입력하세요.');parse(f.shortEntry,f.variables,catalog);parse(f.shortExit,f.variables,catalog);}}else if(f.shortEntry||f.shortExit)throw new Error('매도 포지션 수식은 시스템 전략만 지원합니다.');
 if(f.pane!==undefined&&(!['price','separate'].includes(f.pane)||f.kind!=='indicator'))throw new Error('지표 스케일 설정이 올바르지 않습니다.');
 const validStyle=(x:LineOptions)=>x&&typeof x==='object'&&!Array.isArray(x)&&(x.width===undefined||[1,2,3,4].includes(x.width))&&(x.style===undefined||['solid','dashed','dotted'].includes(x.style))&&(x.visible===undefined||typeof x.visible==='boolean')&&(x.type===undefined||['line','histogram'].includes(x.type))&&(x.colorMode===undefined||['fixed','threshold','previous','st'].includes(x.colorMode))&&(x.threshold===undefined||(typeof x.threshold==='number'&&Number.isFinite(x.threshold)))&&(x.alternateColor===undefined||(typeof x.alternateColor==='string'&&/^#[0-9a-fA-F]{6}$/.test(x.alternateColor)));
 if(f.primaryLine!==undefined&&(f.kind!=='indicator'||!validStyle(f.primaryLine)))throw new Error('기본 라인 설정이 올바르지 않습니다.');
 if(f.extraLines!==undefined){if(f.kind!=='indicator'||!Array.isArray(f.extraLines)||f.extraLines.length>4)throw new Error('추가 지표 수식은 최대 4개까지 허용됩니다.');for(const line of f.extraLines){if(!line||typeof line.name!=='string'||!line.name.trim()||line.name.length>60||typeof line.expression!=='string'||typeof line.visible!=='boolean'||typeof line.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(line.color)||!validStyle(line))throw new Error('추가 지표 수식 설정을 확인하세요.');parse(line.expression,f.variables,catalog);}}
 if(f.baselines!==undefined){if(f.kind!=='indicator'||!Array.isArray(f.baselines)||f.baselines.length>8)throw new Error('기준선은 최대 8개까지 허용됩니다.');for(const line of f.baselines){if(!line||typeof line.value!=='number'||!Number.isFinite(line.value)||typeof line.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(line.color)||!validStyle(line))throw new Error('기준선 설정을 확인하세요.');}}
}
export function validateFormulaSet(all:Formula[]):void {
 const catalog=functionCatalog(all);const graph=new Map<string,Map<string,number>>();
 for(const d of catalog.values()){const calls=new Map<string,number>();parse(d.expression,Object.fromEntries(d.params.map(p=>[p,1])),catalog,calls);graph.set(d.name,calls);}
 const visiting=new Set<string>(),costs=new Map<string,number>(),heights=new Map<string,number>();
 function cost(name:string,depth:number):number{if(depth>16)throw new Error('사용자 함수 호출 깊이가 16을 초과합니다.');if(visiting.has(name))throw new Error(`사용자 함수 순환 호출: ${name}`);const cached=costs.get(name);if(cached!==undefined)return cached;visiting.add(name);let total=1,height=1;for(const [dep,count] of graph.get(name)||[]){total+=count*cost(dep,depth+1);height=Math.max(height,1+heights.get(dep)!);}visiting.delete(name);if(height>16)throw new Error('사용자 함수 호출 깊이가 16을 초과합니다.');heights.set(name,height);if(total>256)throw new Error('사용자 함수 호출 횟수가 너무 많습니다.');costs.set(name,total);return total;}
 for(const n of graph.keys())cost(n,1);
 for(const f of all){validateFormula(f,all);if(f.kind==='function')continue;for(const expression of [f.expression,...(f.kind==='system'?[f.exitExpression,...(f.shortEntry?[f.shortEntry]:[]),...(f.shortExit?[f.shortExit]:[])]:[]),...(f.extraLines||[]).map(l=>l.expression)]){const calls=new Map<string,number>();parse(expression,f.variables,catalog,calls);let total=0;for(const [name,count] of calls)total+=count*cost(name,1);if(total>256)throw new Error('사용자 함수 호출 횟수가 너무 많습니다.');}}
}
export function evaluate(text:string,candles:Candle[],variables:Record<string,number>={},all:Formula[]=[]):Val[]{
 const catalog=functionCatalog(all),size=candles.length;let budget=257;
 const run=(text:string,values:Map<string,Val[]>,validationValues:Record<string,number>,depth:number):Val[]=>{
 if(depth>16||--budget<0)throw new Error('사용자 함수 호출 한도를 초과합니다.');
 const stmts=parse(text,validationValues,catalog),vars=values;
 const validPeriod=(v:Val,min=1)=>v!==null&&Number.isInteger(v)&&v>=min&&v<=500;
 function calc(node:any):Val[]{switch(node.type){
 case 'Literal':return Array(size).fill(node.value);
 case 'Identifier':{const name=key(node.name);if(name in aliases){const field=aliases[name];if(field==='date'||field==='clock')return candles.map(c=>{if(!Number.isFinite(c.time))return null;const t=new Date((c.time+9*3600)*1000);if(!Number.isFinite(t.getTime()))return null;return field==='date'?t.getUTCFullYear()*10000+(t.getUTCMonth()+1)*100+t.getUTCDate():t.getUTCHours()*10000+t.getUTCMinutes()*100+t.getUTCSeconds();});if(field==='strength'){let last:Val=null;let gap=0;return candles.map(c=>{const v=typeof c.strength==='number'&&Number.isFinite(c.strength)&&c.strength>0?c.strength:null;if(v!==null){last=v;gap=0;return v;}gap+=1;return last!==null&&gap<=2?last:null;});}if(field==='turnover')return candles.map(c=>{if(typeof c.turnover==='number'&&Number.isFinite(c.turnover)&&c.turnover>0)return c.turnover;return typeof c.volume==='number'?c.volume*c.close:null;});return candles.map(c=>typeof c[field as keyof Candle]==='number'&&Number.isFinite(c[field as keyof Candle])?c[field as keyof Candle] as number:null);}return vars.get(name)!;}
 case 'UnaryExpression':return calc(node.argument).map(a=>a===null?null:node.operator==='-'?-a:node.operator==='!'?(a?0:1):a);
 case 'BinaryExpression':case 'LogicalExpression':{const left=calc(node.left),right=calc(node.right);return left.map((a,i)=>{const b=right[i];if(node.operator==='&&'||node.operator==='||'){const x=a?1:0,y=b?1:0;return node.operator==='&&'?Number(Boolean(x)&&Boolean(y)):Number(Boolean(x)||Boolean(y));}if(a===null||b===null)return null;let v:number;switch(node.operator){case '+':v=a+b;break;case '-':v=a-b;break;case '*':v=a*b;break;case '/':v=b===0?NaN:a/b;break;case '%':v=b===0?NaN:a%b;break;case '^':v=a**b;break;case '>':v=Number(a>b);break;case '>=':v=Number(a>=b);break;case '<':v=Number(a<b);break;case '<=':v=Number(a<=b);break;case '==':v=Number(a===b);break;case '!=':v=Number(a!==b);break;default:v=Number(Boolean(a)||Boolean(b));}return Number.isFinite(v)?v:null;});}
 case 'CallExpression':{const raw=key(node.callee.name),name=canonical(raw);
 if(shifted.has(name)&&node.arguments.length===3){const base=calc({...node,arguments:node.arguments.slice(0,2)});const offsets=calc(node.arguments[2]);return base.map((_,i)=>validPeriod(offsets[i],0)&&i>=offsets[i]!?base[i-offsets[i]!]:null);}
 const args:Val[][]=node.arguments.map(calc);if(catalog.has(name)){const d=catalog.get(name)!;return run(d.expression,new Map(d.params.map((p,i)=>[p,args[i]])),Object.fromEntries(d.params.map(p=>[p,1])),depth+1);}if(name in aliases||vars.has(name)){const base=name in aliases?calc({type:'Identifier',name}):vars.get(name)!;return base.map((_,i)=>validPeriod(args[0][i],0)&&i>=args[0][i]!?base[i-args[0][i]!]:null);}
 if(['PREDAYOPEN','PREDAYHIGH','PREDAYLOW','PREDAYCLOSE'].includes(name)){const field={PREDAYOPEN:'open',PREDAYHIGH:'high',PREDAYLOW:'low',PREDAYCLOSE:'close'}[name] as 'open'|'high'|'low'|'close';return candles.map(c=>{const v=c.previousDay?.[field];return typeof v==='number'&&Number.isFinite(v)&&v>0?v:null;});}
 if(['DAYOPEN','DAYHIGH','DAYLOW'].includes(name)){
  let lastTime:number|null=null,day=-1,valid=false,open=0,high=0,low=0;
  return candles.map(c=>{const d=new Date((c.time+9*3600)*1000);const dayKey=d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();const minute=d.getUTCHours()*60+d.getUTCMinutes();if(dayKey!==day||minute===540){day=dayKey;valid=minute===540;open=c.open;high=c.high;low=c.low;lastTime=null;}else if(lastTime===null||c.time-lastTime!==60)valid=false;if(minute<540||minute>929)valid=false;lastTime=c.time;if(!valid)return null;high=Math.max(high,c.high);low=Math.min(low,c.low);return name==='DAYOPEN'?open:name==='DAYHIGH'?high:low;});
 }
 const a=args[0];if(name==='IF')return a.map((v,i)=>v===null?null:v?args[1][i]:args[2][i]);if(['ABS','LOG','LOG10','SQRT','SIN','COS','TAN','ASIN','ACOS','ATAN'].includes(name)){const fn:Record<string,(v:number)=>number>={ABS:Math.abs,LOG:Math.log,LOG10:Math.log10,SQRT:Math.sqrt,SIN:Math.sin,COS:Math.cos,TAN:Math.tan,ASIN:Math.asin,ACOS:Math.acos,ATAN:Math.atan};return a.map(v=>{if(v===null)return null;const out=fn[name](v);return Number.isFinite(out)?out:null;});}if(['MAX','MIN','POW'].includes(name))return a.map((v,i)=>{const b=args[1][i];if(v===null||b===null)return null;const out=name==='MAX'?Math.max(v,b):name==='MIN'?Math.min(v,b):Math.pow(v,b);return Number.isFinite(out)?out:null;});
 if(['CROSSUP','CROSSDOWN','상향돌파','하향돌파'].includes(name)){const b=args[1];return a.map((x,i)=>{if(i===0||x===null||b[i]===null||a[i-1]===null||b[i-1]===null)return null;return Number(name==='CROSSUP'||name==='상향돌파'?a[i-1]!<=b[i-1]!&&x>b[i]!:a[i-1]!>=b[i-1]!&&x<b[i]!);});}
 if(name==='REF'||name==='SHIFT')return a.map((_,i)=>validPeriod(args[1][i],0)&&i>=args[1][i]!?a[i-args[1][i]!]:null);
 if(name==='BARSSINCE'){let last=-1;return a.map((v,i)=>{if(v===null)return null;if(v)last=i;return last<0?null:i-last;});}
 if(['COUNTSINCE','HIGHESTSINCE','LOWESTSINCE'].includes(name)){let active=false;let aggregate:number|null=null;return a.map((condition,i)=>{const value=args[1][i];if(condition===null)return null;if(condition){active=true;aggregate=name==='COUNTSINCE'?0:null;}if(!active||value===null)return null;if(name==='COUNTSINCE')aggregate=(aggregate??0)+(value?1:0);else aggregate=aggregate===null?value:name==='HIGHESTSINCE'?Math.max(aggregate,value):Math.min(aggregate,value);return aggregate;});}
 if(name==='VALUEWHEN'){const hits:number[]=[];return a.map((nth,i)=>{if(args[1][i])hits.push(i);if(!validPeriod(nth)||hits.length<nth!)return null;return args[2][hits[hits.length-nth!]];});}
 if(name==='SUM'&&args.length===1){let sum=0;return a.map(v=>{if(v===null)return null;sum+=v;return sum;});}
 const rma=(src:Val[],period:Val[]):Val[]=>{let prev:Val=null,prior:Val=null;return src.map((x,i)=>{const n=period[i];if(x===null||!validPeriod(n)){prev=null;prior=null;return null;}if(prev===null||prior!==n){if(i<n!-1)return null;const vals=src.slice(i-n!+1,i+1);if(vals.some(v=>v===null))return null;prev=vals.reduce<number>((s,v)=>s+v!,0)/n!;}else prev=(prev*(n!-1)+x)/n!;prior=n;return prev;});};
 const trueRange=():Val[]=>candles.map((c,i)=>{if(i===0)return c.high-c.low;const prev=candles[i-1].close;return Math.max(c.high-c.low,Math.abs(c.high-prev),Math.abs(c.low-prev));});
 if(name==='TR')return trueRange();
 if(name==='RMA')return rma(a,args[1]);
 if(name==='RSI'){const n=args[1];const gain:Val[]=[];const loss:Val[]=[];a.forEach((x,i)=>{if(i===0){gain.push(0);loss.push(0);return;}if(x===null||a[i-1]===null){gain.push(null);loss.push(null);return;}const ch=x-a[i-1]!;gain.push(Math.max(ch,0));loss.push(Math.max(-ch,0));});const ag=rma(gain,n),al=rma(loss,n);return ag.map((g,i)=>{const l=al[i];if(g===null||l===null)return null;if(l===0)return g===0?50:100;return 100-100/(1+g/l);});}
 if(name==='ATR')return rma(trueRange(),a);
 if(name==='STOCHK'||name==='WILLR'){return a.map((n,i)=>{if(!validPeriod(n))return null;if(i<n!-1)return null;const w=candles.slice(i-n!+1,i+1);const hh=Math.max(...w.map(c=>c.high)),ll=Math.min(...w.map(c=>c.low));if(hh===ll)return name==='WILLR'?-50:50;const c=candles[i].close;return name==='WILLR'?(hh-c)/(hh-ll)*-100:(c-ll)/(hh-ll)*100;});}
 if(name==='STOCHD'){const k=a.map((n,i)=>{if(!validPeriod(n))return null;if(i<n!-1)return null;const w=candles.slice(i-n!+1,i+1);const hh=Math.max(...w.map(c=>c.high)),ll=Math.min(...w.map(c=>c.low));if(hh===ll)return 50;return (candles[i].close-ll)/(hh-ll)*100;});return rma(k,args[1]);}
 if(name==='BBMID'||name==='BBUPPER'||name==='BBLOWER'){return a.map((x,i)=>{const n=args[1][i];const k=name==='BBMID'?2:args[2]?.[i];if(x===null||!validPeriod(n)||(name!=='BBMID'&&(k===null||!Number.isFinite(k as number))))return null;if(i<n!-1)return null;const values=a.slice(i-n!+1,i+1);if(values.some(v=>v===null))return null;const avg=values.reduce<number>((s,v)=>s+v!,0)/n!;if(name==='BBMID')return avg;const std=Math.sqrt(values.reduce<number>((s,v)=>s+(v!-avg)**2,0)/n!);return name==='BBUPPER'?avg+(k as number)*std:avg-(k as number)*std;});}
 if(name==='CCI'){return a.map((n,i)=>{if(!validPeriod(n)||i<n!-1)return null;const w=candles.slice(i-n!+1,i+1);const tp=w.map(c=>(c.high+c.low+c.close)/3);const avg=tp.reduce((s,v)=>s+v,0)/n!;const mad=tp.reduce((s,v)=>s+Math.abs(v-avg),0)/n!;if(mad===0)return 0;return (tp[tp.length-1]-avg)/(0.015*mad);});}
 if(name==='MOM')return a.map((x,i)=>{const n=args[1][i];if(x===null||!validPeriod(n)||i<n!)return null;const prev=a[i-n!];return prev===null?null:x-prev;});
 if(name==='INRANGE')return a.map((x,i)=>{const lo=args[1][i],hi=args[2][i];if(x===null||lo===null||hi===null)return null;return Number(x>=lo&&x<=hi);});
 if(name==='HLRATE')return a.map((n,i)=>{if(!validPeriod(n)||i<n!-1)return null;const w=candles.slice(i-n!+1,i+1);const hh=Math.max(...w.map(c=>c.high)),ll=Math.min(...w.map(c=>c.low));return ll===0?null:(hh-ll)/ll*100;});
 if(name==='NEARHIGH')return a.map((n,i)=>{const pct=args[1][i],ago=args[2]?args[2][i]:0;if(!validPeriod(n)||pct===null||ago===null||!Number.isInteger(ago)||ago<0||i<ago||i-ago<n!-1)return null;const end=i-ago;const w=candles.slice(end-n!+1,end+1);const hh=Math.max(...w.map(c=>c.high));const h=candles[end].high;if(hh<=0)return null;const near=Math.abs(pct)/100;return Number(h<=hh&&h>=hh*(1-near));});
 if(name==='UPBARS'||name==='DOWNBARS')return a.map((n,i)=>{if(!validPeriod(n)||i<n!-1)return null;let c=0;for(let j=i-n!+1;j<=i;j++){if(name==='UPBARS'?candles[j].close>candles[j].open:candles[j].close<candles[j].open)c++;}return c;});
 if(name==='DISPARITY')return a.map((x,i)=>{const n=args[1][i];if(x===null||!validPeriod(n)||i<n!-1)return null;const vals=a.slice(i-n!+1,i+1);if(vals.some(v=>v===null))return null;const avg=vals.reduce<number>((s,v)=>s+v!,0)/n!;return avg===0?null:x/avg*100;});
 if(name==='OBV'){let sum=0;return candles.map((c,i)=>{if(i===0||typeof c.volume!=='number')return i===0?0:null;const prev=candles[i-1].close;if(c.close>prev)sum+=c.volume;else if(c.close<prev)sum-=c.volume;return sum;});}
 if(name==='PLOT')return a;
 const emaOf=(src:Val[],period:Val[]):Val[]=>{let previous:Val=null,prior:Val=null;return src.map((x,i)=>{const n=period[i];if(x===null||!validPeriod(n)){previous=null;prior=null;return null;}if(previous===null||prior!==n){if(i<n!-1)return null;const vals=src.slice(i-n!+1,i+1);if(vals.some(v=>v===null))return null;previous=vals.reduce<number>((s,v)=>s+v!,0)/n!;}else previous=x*2/(n!+1)+previous*(1-2/(n!+1));prior=n;return previous;});};
 const wmaOf=(src:Val[],n:number):Val[]=>src.map((x,i)=>{if(x===null||i<n-1)return null;const vals=src.slice(i-n+1,i+1);if(vals.some(v=>v===null))return null;return vals.reduce<number>((s,v,idx)=>s+v!*(idx+1),0)/(n*(n+1)/2);});
 if(name==='JMA'){
  const roundToEven=(value:number,digits:number)=>{const factor=10**digits;const scaled=value*factor;const floor=Math.floor(scaled);const fraction=scaled-floor;const epsilon=Number.EPSILON*Math.max(1,Math.abs(scaled))*4;const rounded=Math.abs(fraction-0.5)<=epsilon?(floor%2===0?floor:floor+1):Math.round(scaled);return rounded/factor;};
  let e0=0,e1=0,e2=0,last=0,warm=0,count=0,init=false;
  return candles.map((c,i)=>{
   const period=a[i],phase=args[1][i],power=args[2][i];
   if(!validPeriod(period)||phase===null||!Number.isFinite(phase)||phase<-100||phase>100||power===null||power<1||!Number.isInteger(power))return null;
   const source=c.close;
   if(!init){e0=source;e1=0;e2=0;last=source;init=true;}
   const beta=0.45*(period!-1)/(0.45*(period!-1)+2);
   const alpha=beta**power;
   e0=(1-alpha)*source+alpha*e0;
   e1=(source-e0)*(1-beta)+beta*e1;
   e2=(e0+(phase/100+1.5)*e1-last)*((1-alpha)**2)+(alpha**2)*e2;
   count++;warm+=source;
   const current=count<=period!?roundToEven(warm/count,4):roundToEven(e2+last,4);
   last=current;return current;
  });
 }
 if(name==='HMA'){return a.map((x,i)=>{const n=args[1][i];if(x===null||!validPeriod(n)||n!<2)return null;const half=Math.max(1,Math.floor(n!/2));const sqrt=Math.max(1,Math.floor(Math.sqrt(n!)));const w1=wmaOf(a,half),w2=wmaOf(a,n!);const diff=w1.map((v,j)=>v===null||w2[j]===null?null:2*v-w2[j]!);return wmaOf(diff,sqrt)[i];});}
 if(name==='VWMA'){return a.map((x,i)=>{const n=args[1][i];if(x===null||!validPeriod(n)||i<n!-1)return null;let pv=0,vv=0;for(let j=i-n!+1;j<=i;j++){const vol=candles[j].volume;if(a[j]===null||typeof vol!=='number')return null;pv+=a[j]!*vol;vv+=vol;}return vv===0?null:pv/vv;});}
 if(name==='ALMA'){return a.map((x,i)=>{const n=args[1][i];const off=args[2]?.[i]??0.85;const sig=args[3]?.[i]??6;if(x===null||!validPeriod(n)||off===null||sig===null||sig===0||i<n!-1)return null;const m=off*(n!-1),s=n!/sig;let wsum=0,vsum=0;for(let k=0;k<n!;k++){const v=a[i-n!+1+k];if(v===null)return null;const w=Math.exp(-((k-m)**2)/(2*s*s));wsum+=w;vsum+=w*v;}return wsum===0?null:vsum/wsum;});}
 if(name==='ADX'||name==='PLUSDI'||name==='MINUSDI'){const plus:Val[]=[];const minus:Val[]=[];const trs=trueRange();candles.forEach((c,i)=>{if(i===0){plus.push(0);minus.push(0);return;}const up=c.high-candles[i-1].high,dn=candles[i-1].low-c.low;plus.push(up>dn&&up>0?up:0);minus.push(dn>up&&dn>0?dn:0);});const sp=rma(plus,a),sm=rma(minus,a),str=rma(trs,a);const pdi=sp.map((v,i)=>{const t=str[i];return v===null||t===null||t===0?null:100*v/t;});const mdi=sm.map((v,i)=>{const t=str[i];return v===null||t===null||t===0?null:100*v/t;});if(name==='PLUSDI')return pdi;if(name==='MINUSDI')return mdi;const dx=pdi.map((p,i)=>{const m=mdi[i];if(p===null||m===null||p+m===0)return null;return 100*Math.abs(p-m)/(p+m);});return rma(dx,a);}
 if(name==='ST'||name==='STDIR'){
  const trs=trueRange();
  type St={atr:number;fu:number;fl:number;value:number;up:boolean};
  const states:(St|null)[]=candles.map(()=>null);
  return candles.map((c,i)=>{
   const period=a[i],mult=args[1][i];
   if(!validPeriod(period)||mult===null||!Number.isFinite(mult)||mult<=0||i<period!-1)return null;
   const hl2=(c.high+c.low)/2;
   const prev=i>0?states[i-1]:null;
   let atr:number;
   if(i===period!-1){const slice=trs.slice(0,period!);if(slice.some(v=>v===null))return null;atr=slice.reduce<number>((s,v)=>s+v!,0)/period!;}
   else if(prev&&trs[i]!==null)atr=(prev.atr*(period!-1)+trs[i]!)/period!;
   else return null;
   const basicUpper=hl2+mult*atr,basicLower=hl2-mult*atr;
   let st:St;
   if(!prev){const up=c.close>=hl2;st={atr,fu:basicUpper,fl:basicLower,value:up?basicLower:basicUpper,up};}
   else{
    const prevClose=candles[i-1].close;
    const fu=basicUpper<prev.fu||prevClose>prev.fu?basicUpper:prev.fu;
    const fl=basicLower>prev.fl||prevClose<prev.fl?basicLower:prev.fl;
    const wasUpper=prev.value===prev.fu;
    const value=wasUpper?(c.close<=fu?fu:fl):(c.close>=fl?fl:fu);
    st={atr,fu,fl,value,up:value===fl};
   }
   states[i]=st;
   return name==='STDIR'?(st.up?1:-1):+st.value.toFixed(6);
  });
 }
 if(name==='VWAP'){let day=-1,pv=0,vv=0;return candles.map((c)=>{const d=new Date((c.time+9*3600)*1000);const dayKey=d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();const minute=d.getUTCHours()*60+d.getUTCMinutes();if(dayKey!==day||minute===540){day=dayKey;pv=0;vv=0;}const vol=typeof c.volume==='number'?c.volume:null;if(vol===null||vol<=0)return null;const tp=(c.high+c.low+c.close)/3;pv+=tp*vol;vv+=vol;return vv===0?null:pv/vv;});}
 if(name==='KCMID')return emaOf(a,args[1]);
 if(name==='KCUPPER'||name==='KCLOWER'){const mid=emaOf(a,args[1]);const atrs=rma(trueRange(),args[1]);return mid.map((m,i)=>{const atr=atrs[i],k=args[2][i];if(m===null||atr===null||k===null)return null;return name==='KCUPPER'?m+k*atr:m-k*atr;});}
 if(name==='DCHIGH')return a.map((n,i)=>{if(!validPeriod(n)||i<n!-1)return null;return Math.max(...candles.slice(i-n!+1,i+1).map(c=>c.high));});
 if(name==='DCLOW')return a.map((n,i)=>{if(!validPeriod(n)||i<n!-1)return null;return Math.min(...candles.slice(i-n!+1,i+1).map(c=>c.low));});
 if(name==='TSI'){const mom:Val[]=a.map((n,i)=>{void n;if(i===0||candles[i].close===null)return null;return candles[i].close-candles[i-1].close;});const abs=mom.map(v=>v===null?null:Math.abs(v));const long=a,short=args[1];const num=emaOf(emaOf(mom,long),short);const den=emaOf(emaOf(abs,long),short);return num.map((v,i)=>{const d=den[i];if(v===null||d===null||d===0)return null;return 100*v/d;});}
 if(name==='MFI'){return a.map((n,i)=>{if(!validPeriod(n)||i<n!)return null;let pos=0,neg=0;for(let j=i-n!+1;j<=i;j++){if(j===0)continue;const tp=(candles[j].high+candles[j].low+candles[j].close)/3;const prev=(candles[j-1].high+candles[j-1].low+candles[j-1].close)/3;const vol=candles[j].volume;if(typeof vol!=='number')return null;const mf=tp*vol;if(tp>prev)pos+=mf;else if(tp<prev)neg+=mf;}if(neg===0)return 100;const ratio=pos/neg;return 100-100/(1+ratio);});}
 if(name==='EMA'||name==='EAVG'){let previous:Val=null;let priorPeriod:Val=null;return a.map((x,i)=>{const n=args[1][i];if(x===null||!validPeriod(n)){previous=null;priorPeriod=null;return null;}if(previous===null||priorPeriod!==n){if(i<n!-1)return null;const vals=a.slice(i-n!+1,i+1);if(vals.some(v=>v===null))return null;previous=vals.reduce<number>((s,v)=>s+v!,0)/n!;}else previous=x*2/(n!+1)+previous*(1-2/(n!+1));priorPeriod=n;return previous;});}
 return a.map((x,i)=>{const n=args[1]?.[i];if(!validPeriod(n??null))return null;if(name==='ROC'){const prev=i>=n!?a[i-n!]:null;return x===null||prev===null||prev===0?null:(x-prev)/prev*100;}if(i<n!-1)return null;const values=a.slice(i-n!+1,i+1);if(values.some(v=>v===null))return null;switch(name){case 'SMA':case 'AVG':case '평균':return values.reduce<number>((s,v)=>s+v!,0)/n!;case 'WAVG':return values.reduce<number>((sum,v,index)=>sum+v!*(index+1),0)/(n!*(n!+1)/2);case 'STDEV':{const avg=values.reduce<number>((sum,v)=>sum+v!,0)/n!;return Math.sqrt(values.reduce<number>((sum,v)=>sum+(v!-avg)**2,0)/n!);}case 'HIGHEST':return Math.max(...values as number[]);case 'LOWEST':return Math.min(...values as number[]);case 'SUM':return values.reduce<number>((s,v)=>s+v!,0);case 'COUNT':return values.filter(Boolean).length;default:return null;}});}
 default:throw new Error('수식 오류');}}
 let result:Val[]=Array(size).fill(null);for(const stmt of stmts){result=calc(stmt.ast);if(stmt.name)vars.set(stmt.name,result);}return result;
 };
 const v=variableMap(variables);return run(text,new Map([...v].map(([k,n])=>[k,Array(size).fill(n)])),variables,0);
}

export function seriesColors(values:(number|null)[],base:string,options:LineOptions):string[]{
 const other=options.alternateColor||'#5d96e8';
 let last=base;
 return values.map((value,i)=>{
  if(value===null||!options.colorMode||options.colorMode==='fixed')return base;
  if(options.colorMode==='threshold')return value>=(options.threshold??0)?base:other;
  if(options.colorMode==='st')return value>=0?base:other;
  const previous=values[i-1];
  if(previous===null||previous===undefined){last=base;return last;}
  if(value>previous)last=base;
  else if(value<previous)last=other;
  return last;
 });
}
