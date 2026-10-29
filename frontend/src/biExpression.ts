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
  | {t:'fn';name:string;args:ExprNode[];distinct?:boolean;total?:boolean;set?:SetExpr}

// Set analysis (Qlik): Sum({<year={2025}, branch=>} sales). base: '$' current selections, '1' all
// data, or an alternate state's name. Each modifier replaces (=), adds to (+=), removes from (-=) or
// narrows (*=) the selection on a field; values: null clears the field.
export type SetValue={v:string|number}|{search:string}|{cmp:{op:string;e:ExprNode}[]}|{e:ExprNode}
export type SetModifier={field:ExprNode;op:'='|'+='|'-='|'*=';values:SetValue[]|null}
export type SetExpr={base:string;mods:SetModifier[]}

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

type Token={k:'num'|'str'|'id'|'br'|'op'|'('|')'|','|'{'|'}'|'$'|'dq'|'dexpr'|'eof';v:string;p:number}

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
    if(c==='"'){
      let j=i+1,v=''
      for(;;){
        if(j>=src.length)throw new ExpressionError('Search text is missing its closing "',i)
        if(src[j]==='"'){if(src[j+1]==='"'){v+='"';j+=2;continue}break}
        v+=src[j++]
      }
      out.push({k:'dq',v,p:i});i=j+1;continue
    }
    if(c==='$'&&src.startsWith('$(=',i)){
      let depth=0,j=i+1
      for(;j<src.length;j++){if(src[j]==='(')depth++;else if(src[j]===')'){depth--;if(depth===0)break}}
      if(j>=src.length)throw new ExpressionError('$(= is missing its closing )',i)
      out.push({k:'dexpr',v:src.slice(i+3,j),p:i});i=j+1;continue
    }
    if(c==='$'){out.push({k:'$',v:c,p:i});i++;continue}
    if(c==='{'||c==='}'){out.push({k:c,v:c,p:i});i++;continue}
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
    if(two==='+='||two==='-='||two==='*='){out.push({k:'op',v:two,p:i});i+=2;continue}
    if('+-*/&=<>'.includes(c)){out.push({k:'op',v:c,p:i});i++;continue}
    if(c==='('||c===')'||c===','){out.push({k:c,v:c,p:i});i++;continue}
    throw new ExpressionError(`Unexpected "${c}"`,i)
  }
  out.push({k:'eof',v:'',p:src.length})
  return out
}

const BINARY:Record<string,number>={or:1,and:2,'=':3,'<>':3,'<':3,'<=':3,'>':3,'>=':3,'&':4,'+':5,'-':5,'*':6,'/':6}

export type AppVariable={name:string;value:string;description?:string}

// Qlik dollar expansion: $(vName) is replaced by the variable's text before parsing, so a variable
// can hold a number (Sum(qty) > $(vMin)), a text in quotes ('$(vBranch)') or part of an expression.
export function expandVariables(src:string,variables:Record<string,string>|undefined,depth=0):string{
  if(!src.includes('$('))return src
  if(depth>5)throw new ExpressionError('Variables refer to each other too deeply',0)
  const lookup=new Map(Object.entries(variables||{}).map(([name,value])=>[name.toLowerCase(),value]))
  return src.replace(/\$\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,(_,name:string,offset:number)=>{
    if(!lookup.has(name.toLowerCase()))throw new ExpressionError(`Unknown variable "${name}"`,offset)
    return expandVariables(lookup.get(name.toLowerCase())??'',variables,depth+1)
  })
}

export function parseExpression(src:string,options:{measures?:MasterMeasure[];stack?:string[];variables?:Record<string,string>}={}):ExprNode{
  src=expandVariables(src,options.variables)
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
      try{return parseExpression(measure.expression,{measures:options.measures,stack:[...stack,measure.name],variables:options.variables})}
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
        const args:ExprNode[]=[];let distinct=false,total=false
        let set:SetExpr|undefined
        if(peek().k==='{'){
          if(!spec.aggregate)throw new ExpressionError(`${spec.name}() does not take a set expression; sets go in aggregations such as Sum({<year={2025}>} sales)`,peek().p)
          set=parseSet()
        }
        if(name==='count'&&peek().k==='op'&&peek().v==='*'){next();args.push({t:'star'});expect(')','a closing )');return set?{t:'fn',name,args,set}:{t:'fn',name,args}}
        if(keyword(peek())==='total'){
          if(!spec.total)throw new ExpressionError(`${spec.name}() does not take TOTAL`,peek().p)
          next();total=true
        }
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
        const node:ExprNode={t:'fn',name,args}
        if(distinct)node.distinct=true
        if(total)node.total=true
        if(set)node.set=set
        return node
      }
      return fieldOrMeasure(t.v,t.p,false)
    }
    if(t.k==='eof')throw new ExpressionError('The expression ends too early',t.p)
    throw new ExpressionError(`Unexpected "${t.v}"`,t.p)
  }
  // {<field={values}, field2=>} — see SetExpr
  function parseSet():SetExpr{
    expect('{','{')
    let base='$'
    const t=peek()
    if(t.k==='$'){next()}
    else if(t.k==='num'){if(t.v!=='1')throw new ExpressionError('A set starts with $ (current selections) or 1 (all data)',t.p);next();base='1'}
    else if(t.k==='id'){next();base=t.v}
    const mods:SetModifier[]=[]
    if(peek().k==='op'&&peek().v==='<'){
      next()
      while(!(peek().k==='op'&&peek().v==='>')){
        const ft=next()
        if(ft.k!=='id'&&ft.k!=='br')throw new ExpressionError('Expected a field name in the set',ft.p)
        const field:ExprNode=ft.k==='br'?{t:'field',name:fieldKey(ft.v)}:fieldOrMeasure(ft.v,ft.p,false)
        const ot=next()
        if(ot.k!=='op'||!['=','+=','-=','*='].includes(ot.v))throw new ExpressionError('Expected = after the field name, e.g. year={2025}',ot.p)
        let values:SetValue[]|null=null
        if(peek().k==='{'){
          next();values=[]
          while(peek().k!=='}'){
            values.push(setValue())
            if(peek().k===',')next();else if(peek().k!=='}')throw new ExpressionError('Expected , or } in the value list',peek().p)
          }
          next()
        }else if(ot.v!=='='){throw new ExpressionError(`${ot.v} needs a list of values, e.g. ${ot.v}{'x'}`,ot.p)}
        mods.push({field,op:ot.v as SetModifier['op'],values})
        if(peek().k===',')next();else if(!(peek().k==='op'&&peek().v==='>'))throw new ExpressionError('Expected , or > in the set',peek().p)
      }
      next()
    }
    expect('}','} to close the set')
    return {base,mods}
  }
  function inner(text:string,p:number):ExprNode{
    let node:ExprNode
    try{node=parseExpression(text,{measures:options.measures,variables:options.variables})}catch(error){throw new ExpressionError(`In $(=…): ${(error as Error).message}`,p)}
    if(hasAggregation(node))throw new ExpressionError('$(=…) in a set must work without aggregations, e.g. $(=Year(Today()) - 1)',p)
    return node
  }
  function setValue():SetValue{
    const t=next()
    if(t.k==='num')return {v:Number(t.v)}
    if(t.k==='op'&&t.v==='-'&&peek().k==='num')return {v:-Number(next().v)}
    if(t.k==='str')return {v:t.v}
    if(t.k==='dexpr')return {e:inner(t.v,t.p)}
    if(t.k==='dq')return searchValue(t.v.trim(),t.p)
    throw new ExpressionError('Expected a value: a number, \'text\', "search" or $(=expression)',t.p)
  }
  // "*brake*" (wildcards), ">=2025", ">=2025<=2026", ">=$(=AddMonths(Today(), -12))"
  function searchValue(text:string,p:number):SetValue{
    if(!/^(>=|<=|<>|>|<|=)/.test(text)){
      if(/^\$\(=.*\)$/.test(text))return {e:inner(text.slice(3,-1),p)}
      return {search:text}
    }
    const cmp:{op:string;e:ExprNode}[]=[]
    let rest=text
    while(rest){
      const m=/^(>=|<=|<>|>|<|=)\s*/.exec(rest)
      if(!m||cmp.length>=2)throw new ExpressionError(`Cannot read the search "${text}"`,p)
      rest=rest.slice(m[0].length)
      let value:string
      if(rest.startsWith('$(=')){
        let depth=0,j=1
        for(;j<rest.length;j++){if(rest[j]==='(')depth++;else if(rest[j]===')'){depth--;if(depth===0)break}}
        value=rest.slice(0,j+1);rest=rest.slice(j+1).trim()
        cmp.push({op:m[1],e:inner(value.slice(3,-1),p)});continue
      }
      const end=rest.search(/(>=|<=|<>|>|<|=)/)
      value=(end<0?rest:rest.slice(0,end)).trim();rest=end<0?'':rest.slice(end)
      if(!value)throw new ExpressionError(`Cannot read the search "${text}"`,p)
      cmp.push({op:m[1],e:/^-?\d+(\.\d+)?$/.test(value)?{t:'num',v:Number(value)}:{t:'str',v:value}})
    }
    return {cmp}
  }

  const result=parse(1)
  if(peek().k!=='eof')throw new ExpressionError(`Unexpected "${peek().v}"`,peek().p)
  return result
}

export function hasAggregation(node:ExprNode):boolean{
  switch(node.t){
    case 'fn':return AGGREGATIONS.includes(node.name)||node.name==='rowno'||node.name==='noofrows'||node.args.some(hasAggregation)
    case 'bin':return hasAggregation(node.l)||hasAggregation(node.r)
    case 'neg':case 'not':return hasAggregation(node.e)
    default:return false
  }
}

// Like Qlik, a field used in a measure outside any aggregation means Only(field): its value when
// every record in the chart row has the same value, otherwise empty. So  qty_on_hand - reorder_level
// in a table per item works without writing Sum().
export function asMeasure(node:ExprNode):ExprNode{
  switch(node.t){
    case 'field':return {t:'fn',name:'only',args:[node]}
    case 'fn':return AGGREGATIONS.includes(node.name)?node:{...node,args:node.args.map(asMeasure)}
    case 'bin':return {...node,l:asMeasure(node.l),r:asMeasure(node.r)}
    case 'neg':case 'not':return {...node,e:asMeasure(node.e)}
    default:return node
  }
}

// Colour expressions are calculated like measures; a constant such as 'red' is allowed too.
export function asColorMeasure(node:ExprNode):ExprNode{
  const measure=asMeasure(node)
  return hasAggregation(measure)?measure:{t:'fn',name:'only',args:[measure]}
}

// Fields an expression refers to (for validation against the data model).
export function referencedFields(node:ExprNode,out:{table?:string;name:string}[]=[]){
  switch(node.t){
    case 'field':out.push({table:node.table,name:node.name});break
    case 'fn':
      node.args.forEach(arg=>referencedFields(arg,out))
      node.set?.mods.forEach(mod=>{referencedFields(mod.field,out);mod.values?.forEach(value=>{
        if('e' in value)referencedFields(value.e,out)
        if('cmp' in value)value.cmp.forEach(c=>referencedFields(c.e,out))
      })})
      break
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
