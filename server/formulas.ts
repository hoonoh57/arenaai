import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {defaults,validateFormulaSet,type Formula} from '../shared/formula';
const path=process.env.FORMULAS_PATH || 'data/formulas.json';
export function validateSet(value:unknown):Formula[]{
 if(!Array.isArray(value)||value.length>50)throw new Error('수식은 최대 50개까지 저장할 수 있습니다.');
 const ids=new Set<string>();let systems=0;
 validateFormulaSet(value as Formula[]);
 for(const f of value){if(ids.has(f.id))throw new Error('중복된 수식 ID입니다.');ids.add(f.id);if(f.kind==='system'&&f.enabled)systems++;}
 if(systems>1)throw new Error('시스템트레이딩은 하나만 활성화할 수 있습니다.');
 return (value as Formula[]).map(({id,name,kind,expression,exitExpression,shortEntry,shortExit,enabled,color,variables,description,extraLines,primaryLine,pane,baselines})=>({id,name,kind,expression,exitExpression,shortEntry,shortExit,enabled,color,variables,description,extraLines:extraLines?.map(({name,expression,color,visible,width,style,type,colorMode,threshold,alternateColor})=>({name,expression,color,visible,...(type!==undefined?{type}:{}),...(colorMode!==undefined?{colorMode}:{}),...(threshold!==undefined?{threshold}:{}),...(alternateColor!==undefined?{alternateColor}:{}),...(width!==undefined?{width}:{}),...(style!==undefined?{style}:{})})),primaryLine:primaryLine&&Object.fromEntries(Object.entries(primaryLine).filter(([key,value])=>['width','style','visible','type','colorMode','threshold','alternateColor'].includes(key)&&value!==undefined)),pane,baselines:baselines?.map(({value,color,width,style})=>({value,color,...(width!==undefined?{width}:{}),...(style!==undefined?{style}:{})}))}));
}
export function loadFormulas():Formula[]{try{return validateSet(JSON.parse(readFileSync(path,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return defaults.map(f=>({...f}));throw new Error(`저장된 수식을 불러올 수 없습니다: ${e instanceof Error?e.message:'오류'}`);}}
export function saveFormulas(value:unknown):Formula[]{const formulas=validateSet(value);mkdirSync(dirname(path),{recursive:true});const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(formulas,null,2),{mode:0o600});renameSync(tmp,path);return formulas;}
