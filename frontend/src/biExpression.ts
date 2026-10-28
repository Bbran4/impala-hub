// Qlik-style expression parser for Reporting apps.
//
// Text such as  Sum(qty * unit_price)  or  Count(DISTINCT [Invoice No])  is parsed in the
// browser into a JSON syntax tree. The database (bi.compile_expr, migration 0047) turns the
// tree into SQL using only whitelisted functions and operators, so nothing typed here is
// ever executed as SQL text.

export type ExprNode =
  | {t:'num';v:number}
  | {t:'str';v:string}
  | {t:'null'}
  | {t:'star'}
  | {t:'field';name:string;table?:string}
  | {t:'bin';op:string;l:ExprNode;r:ExprNode}
  | {t:'neg';e:ExprNode}
  | {t:'not';e:ExprNode}
  | {t:'fn';name:string;args:ExprNode[];distinct?:boolean}

import {AGGREGATION_NAMES,findFunction} from './biFunctions.ts'

export type MasterMeasure={name:string;expression:string;format?:string}

export class ExpressionError extends Error{
  position:number
  constructor(message:string,position:number){super(message);this.position=position}
}

export const AGGREGATIONS=AGGREGATION_NAMES

// Same rule the sync agent uses to name columns: "Cost Price" -> cost_price
export function fieldKey(name:string){
  let s=name.replace(/[^0-9a-zA-Z]+/g,'_').replace(/^_+|_+$/g,'').toLowerCase()
  if(!s)s='col'
  if(/^[0-9]/.test(s))s='c_'+s
  return s.slice(0,63)
}

type Token={k:'num'|'str'|'id'|'br'|'op'|'('|')'|','|'eof';v:string;p:number}

function tokenize(src:string):Token[]{
  const out:Token[]=[];let i=0
  while(i<src.length){
    const c=src[i]
    if(/\s/.test(c)){i++;continue}
    if(c==='/'&&src[i+1]==='/'){const end=src.indexOf('\n',i);i=end<0?src.length:end+1;continue}
    if(c==='/'&&src[i+1]==='*'){const end=src.indexOf('*/',i+2);if(end<0)throw new ExpressionError('Comment is missing its closing */',i);i=end+2;continue}
    if(/[0-9.]/.test(c)&&/[0-9]/.test(src[i]===`.`?src[i+1]||'':c)){
      const m=/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!;out.push({k:'num',v:m[0],p:i});i+=m[0].length;continue
    }
    if(c==="'"){
      let j=i+1,v=''
      for(;;){
        if(j>=src.length)throw new ExpressionError('Text is missing its closing quote',i)
        if(src[j]==="'"){if(src[j+1]==="'"){v+="'";j+=2;continue}break}
        v+=src[j++]
      }
      out.push({k:'str',v,p:i});i=j+1;continue
    }
    if(c==='['){
      const j=src.indexOf(']',i)
      if(j<0)throw new ExpressionError('Field name is missing its closing ]',i)
      out.push({k:'br',v:src.slice(i+1,j),p:i});i=j+1;continue
    }
    if(/[A-Za-z_]/.test(c)){
      const m=/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i))!;out.push({k:'id',v:m[0],p:i});i+=m[0].length;continue
    }
    const two=src.slice(i,i+2)
    if(two==='<='||two==='>='||two==='<>'||two==='!='){out.push({k:'op',v:two==='!='?'<>':two,p:i});i+=2;continue}
    if('+-*/&=<>'.includes(c)){out.push({k:'op',v:c,p:i});i++;continue}
    if(c==='('||c===')'||c===','){out.push({k:c,v:c,p:i});i++;continue}
    throw new ExpressionError(`Unexpected "${c}"`,i)
  }
  out.push({k:'eof',v:'',p:src.length})
  return out
}

const BINARY:Record<string,number>={or:1,and:2,'=':3,'<>':3,'<':3,'<=':3,'>':3,'>=':3,'&':4,'+':5,'-':5,'*':6,'/':6}

export function parseExpression(src:string,options:{measures?:MasterMeasure[];stack?:string[]}={}):ExprNode{
  if(!src.trim())throw new ExpressionError('The expression is empty',0)
  const tokens=tokenize(src);let pos=0
  const measures=new Map((options.measures||[]).map(m=>[m.name.trim().toLowerCase(),m]))
  const stack=options.stack||[]
  const peek=()=>tokens[pos]
  const next=()=>tokens[pos++]
  const expect=(k:Token['k'],what:string)=>{const t=next();if(t.k!==k)throw new ExpressionError(`Expected ${what}`,t.p);return t}
  const keyword=(t:Token)=>t.k==='id'?t.v.toLowerCase():''

  function binaryOp(t:Token){
    if(t.k==='op')return t.v
    const k=keyword(t);return k==='and'||k==='or'?k:''
  }
  function parse(minPrec:number):ExprNode{
    let left=unary()
    for(;;){
      const op=binaryOp(peek());const prec=BINARY[op]
      if(!op||prec===undefined||prec<minPrec)return left
      next()
      const right=parse(prec+1)
      left={t:'bin',op,l:left,r:right}
    }
  }
  function unary():ExprNode{
    const t=peek()
    if(t.k==='op'&&t.v==='-'){next();const e=unary();return e.t==='num'?{t:'num',v:-e.v}:{t:'neg',e}}
    if(t.k==='op'&&t.v==='+'){next();return unary()}
    if(keyword(t)==='not'){next();return {t:'not',e:parse(3)}}
    return primary()
  }
  function fieldOrMeasure(name:string,p:number,bracketed:boolean):ExprNode{
    const measure=measures.get(name.trim().toLowerCase())
    if(measure&&bracketed){
      if(stack.includes(measure.name))throw new ExpressionError(`Master measure "${measure.name}" refers to itself`,p)
      try{return parseExpression(measure.expression,{measures:options.measures,stack:[...stack,measure.name]})}
      catch(error){
        const message=(error as Error).message
        throw new ExpressionError(message.startsWith('In master measure')||message.includes('refers to itself')?message:`In master measure "${measure.name}": ${message}`,p)
      }
    }
    const dot=bracketed?-1:name.indexOf('.')
    if(dot>0)return {t:'field',table:fieldKey(name.slice(0,dot)),name:fieldKey(name.slice(dot+1))}
    return {t:'field',name:fieldKey(name)}
  }
  function primary():ExprNode{
    const t=next()
    if(t.k==='num')return {t:'num',v:Number(t.v)}
    if(t.k==='str')return {t:'str',v:t.v}
    if(t.k==='br')return fieldOrMeasure(t.v,t.p,true)
    if(t.k==='('){const e=parse(1);expect(')','a closing )');return e}
    if(t.k==='op'&&t.v==='*')throw new ExpressionError('* is only allowed in Count(*)',t.p)
    if(t.k==='id'){
      const lower=t.v.toLowerCase()
      if(lower==='null'&&peek().k!=='(')return {t:'null'}
      if(lower==='true')return {t:'bin',op:'=',l:{t:'num',v:1},r:{t:'num',v:1}}
      if(lower==='false')return {t:'bin',op:'=',l:{t:'num',v:1},r:{t:'num',v:0}}
      if(peek().k==='('){
        next()
        const spec=findFunction(lower)
        if(!spec)throw new ExpressionError(`Unknown function ${t.v}(). See the Function reference for the list.`,t.p)
        const name=spec.name.toLowerCase()
        const args:ExprNode[]=[];let distinct=false
        if(name==='count'&&peek().k==='op'&&peek().v==='*'){next();args.push({t:'star'});expect(')','a closing )');return {t:'fn',name,args}}
        if(keyword(peek())==='distinct'){
          if(!spec.distinct)throw new ExpressionError(`${spec.name}() does not take DISTINCT`,peek().p)
          next();distinct=true
        }
        if(peek().k!==')'){
          args.push(parse(1))
          while(peek().k===','){next();args.push(parse(1))}
        }
        expect(')','a closing ) or a comma')
        const [min,max]=spec.args
        if(args.length<min||args.length>max)throw new ExpressionError(`${spec.name}() takes ${min===max?min:max===Infinity?`at least ${min}`:`${min} to ${max}`} argument${max===1&&min===1?'':'s'}: ${spec.signature}`,t.p)
        return distinct?{t:'fn',name,args,distinct}:{t:'fn',name,args}
      }
      return fieldOrMeasure(t.v,t.p,false)
    }
    if(t.k==='eof')throw new ExpressionError('The expression ends too early',t.p)
    throw new ExpressionError(`Unexpected "${t.v}"`,t.p)
  }
  const result=parse(1)
  if(peek().k!=='eof')throw new ExpressionError(`Unexpected "${peek().v}"`,peek().p)
  return result
}

export function hasAggregation(node:ExprNode):boolean{
  switch(node.t){
    case 'fn':return AGGREGATIONS.includes(node.name)||node.args.some(hasAggregation)
    case 'bin':return hasAggregation(node.l)||hasAggregation(node.r)
    case 'neg':case 'not':return hasAggregation(node.e)
    default:return false
  }
}

// Fields an expression refers to (for validation against the data model).
export function referencedFields(node:ExprNode,out:{table?:string;name:string}[]=[]){
  switch(node.t){
    case 'field':out.push({table:node.table,name:node.name});break
    case 'fn':node.args.forEach(arg=>referencedFields(arg,out));break
    case 'bin':referencedFields(node.l,out);referencedFields(node.r,out);break
    case 'neg':case 'not':referencedFields(node.e,out);break
  }
  return out
}

// A dimension that is a plain field can be clicked to make a selection on that field.
export function plainField(node:ExprNode):{table?:string;name:string}|null{
  return node.t==='field'?{table:node.table,name:node.name}:null
}

// Checks that every referenced field exists in the model; returns a message or null.
export function checkFields(node:ExprNode,model:{alias:string;columns:{name:string}[]}[]){
  for(const ref of referencedFields(node)){
    const tables=ref.table?model.filter(table=>table.alias===ref.table):model
    if(ref.table&&!tables.length)return `Unknown table "${ref.table}"`
    if(!tables.some(table=>table.columns.some(column=>column.name===ref.name)))return `Unknown field "${ref.table?ref.table+'.':''}${ref.name}"`
  }
  return null
}
