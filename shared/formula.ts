import jsep, {type Expression} from 'jsep';
import type {Candle} from '../server/core';
export type Kind='indicator'|'signal'|'highlight'|'system';
export type Formula={id:string;name:string;kind:Kind;expression:string;exitExpression:string;enabled:boolean;color:string};
export const kinds:Record<Kind,string>={indicator:'지표',signal:'신호',highlight:'강세',system:'시스템트레이딩'};
export const defaults:Formula[]=[
 {id:'ma5',name:'이동평균 5',kind:'indicator',expression:'SMA(CLOSE, 5)',exitExpression:'',enabled:true,color:'#e8bd64'},
 {id:'ma20',name:'이동평균 20',kind:'indicator',expression:'SMA(CLOSE, 20)',exitExpression:'',enabled:true,color:'#8c83ec'},
 {id:'cross',name:'이동평균 교차',kind:'system',expression:'CROSSUP(SMA(CLOSE, 5), SMA(CLOSE, 20))',exitExpression:'CROSSDOWN(SMA(CLOSE, 5), SMA(CLOSE, 20))',enabled:true,color:'#a8ec6a'}
];
type Val=number|null;
const fields=['OPEN','HIGH','LOW','CLOSE'];
const operations=['+','-','*','/','>','>=','<','<=','==','!=','&&','||'];
const fnArgs:Record<string,number>={SMA:2,EMA:2,REF:2,CROSSUP:2,CROSSDOWN:2};
function parse(text:string):Expression{
 if(!text.trim()||text.length>500)throw new Error('수식은 1~500자여야 합니다.');
 let ast:Expression;try{ast=jsep(text)}catch{throw new Error('수식 문법을 확인하세요.');}
 let count=0;
 function check(node:any,depth:number){if(++count>100||depth>20)throw new Error('수식이 너무 복잡합니다.');switch(node.type){
 case 'Literal':if(typeof node.value!=='number'||!Number.isFinite(node.value))throw new Error('숫자만 사용할 수 있습니다.');break;
 case 'Identifier':if(!fields.includes(node.name.toUpperCase()))throw new Error(`알 수 없는 필드: ${node.name}`);break;
 case 'UnaryExpression':if(!['-','+','!'].includes(node.operator))throw new Error('지원하지 않는 연산자입니다.');check(node.argument,depth+1);break;
 case 'BinaryExpression':case 'LogicalExpression':if(!operations.includes(node.operator))throw new Error('지원하지 않는 연산자입니다.');check(node.left,depth+1);check(node.right,depth+1);break;
 case 'CallExpression':{if(node.callee.type!=='Identifier')throw new Error('함수 이름이 올바르지 않습니다.');const name=node.callee.name.toUpperCase();if(!(name in fnArgs)||node.arguments.length!==fnArgs[name])throw new Error('지원하지 않는 함수 또는 인자 개수입니다.');node.arguments.forEach((n:any)=>check(n,depth+1));if(['SMA','EMA','REF'].includes(name)){const n=node.arguments[1];if(n.type!=='Literal'||!Number.isInteger(n.value)||n.value<1||n.value>500)throw new Error('기간은 1~500 사이의 정수여야 합니다.');}break;}
 default:throw new Error('지원하지 않는 수식 구문입니다.');}}
 check(ast,0);return ast;
}
export function validateFormula(f:Formula){if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(f.id)||typeof f.name!=='string'||!f.name.trim()||f.name.length>60||!Object.keys(kinds).includes(f.kind)||typeof f.enabled!=='boolean'||typeof f.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(f.color)||typeof f.expression!=='string'||typeof f.exitExpression!=='string')throw new Error('수식 설정이 올바르지 않습니다.');parse(f.expression);if(f.kind==='system')parse(f.exitExpression);}
export function evaluate(text:string,candles:Candle[]):Val[]{
 const ast=parse(text),size=candles.length;
 function calc(node:any):Val[]{switch(node.type){
 case 'Literal':return Array(size).fill(node.value);
 case 'Identifier':return candles.map(c=>c[node.name.toLowerCase() as 'open'|'high'|'low'|'close']);
 case 'UnaryExpression':return calc(node.argument).map(a=>a===null?null:node.operator==='-'?-a:node.operator==='!'?(a?0:1):a);
 case 'BinaryExpression':case 'LogicalExpression':{const left=calc(node.left),right=calc(node.right);return left.map((a,i)=>{const b=right[i];if(a===null||b===null)return null;let v:number;switch(node.operator){case '+':v=a+b;break;case '-':v=a-b;break;case '*':v=a*b;break;case '/':v=b===0?NaN:a/b;break;case '>':v=Number(a>b);break;case '>=':v=Number(a>=b);break;case '<':v=Number(a<b);break;case '<=':v=Number(a<=b);break;case '==':v=Number(a===b);break;case '!=':v=Number(a!==b);break;case '&&':v=Number(Boolean(a)&&Boolean(b));break;default:v=Number(Boolean(a)||Boolean(b));}return Number.isFinite(v)?v:null;});}
 case 'CallExpression':{const name=node.callee.name.toUpperCase(),a=calc(node.arguments[0]);if(name==='CROSSUP'||name==='CROSSDOWN'){const b=calc(node.arguments[1]);return a.map((x,i)=>{if(i===0||x===null||b[i]===null||a[i-1]===null||b[i-1]===null)return null;return Number(name==='CROSSUP'?a[i-1]!<=b[i-1]!&&x>b[i]!:a[i-1]!>=b[i-1]!&&x<b[i]!);});}const n=node.arguments[1].value as number;if(name==='REF')return a.map((_,i)=>i>=n?a[i-n]:null);if(name==='SMA')return a.map((_,i)=>{if(i<n-1)return null;const values=a.slice(i-n+1,i+1);return values.some(x=>x===null)?null:values.reduce<number>((s,x)=>s+x!,0)/n;});let previous:Val=null;return a.map((x,i)=>{if(x===null){previous=null;return null;}if(previous===null){if(i<n-1)return null;const values=a.slice(i-n+1,i+1);if(values.some(v=>v===null))return null;previous=values.reduce<number>((s,v)=>s+v!,0)/n;}else previous=x*2/(n+1)+previous*(1-2/(n+1));return previous;});}
 default:throw new Error('수식 오류');}}
 return calc(ast);
}
