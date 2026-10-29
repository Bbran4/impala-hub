// Pure helpers for Reporting controls and media objects (tested in tests/biControlLogic.test.mjs).
import {type FieldValue} from './biApps.ts'
import {type ExprNode} from './biExpression.ts'

const iso=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
export function quickRanges(today=new Date()):{label:string;from:string;to:string}[]{
  const y=today.getFullYear(),m=today.getMonth(),d=today.getDate()
  const day=(offset:number)=>iso(new Date(y,m,d+offset))
  const monday=new Date(y,m,d-((today.getDay()+6)%7))
  return [
    {label:'Today',from:day(0),to:day(0)},
    {label:'Yesterday',from:day(-1),to:day(-1)},
    {label:'This week',from:iso(monday),to:day(0)},
    {label:'Last 7 days',from:day(-6),to:day(0)},
    {label:'This month',from:iso(new Date(y,m,1)),to:day(0)},
    {label:'Last month',from:iso(new Date(y,m-1,1)),to:iso(new Date(y,m,0))},
    {label:'This year',from:iso(new Date(y,0,1)),to:day(0)},
  ]
}

export function buttonValue(text:string):FieldValue{const t=text.trim();return /^-?\d+(\.\d+)?$/.test(t)?Number(t):t}
export function safeUrl(text:string|undefined){
  try{const url=new URL((text||'').trim());return url.protocol==='https:'||url.protocol==='http:'?url.toString():null}catch{return null}
}

export function trellisCondition(node:ExprNode,value:FieldValue):ExprNode{
  if(value===null)return {t:'fn',name:'isnull',args:[node]}
  return {t:'bin',op:'=',l:node,r:typeof value==='number'?{t:'num',v:value}:{t:'str',v:String(value)}}
}

// YouTube and Vimeo links become privacy-friendly embeds; other https links must be video files.
export function videoSource(text:string|undefined):{kind:'embed'|'file';src:string}|null{
  const safe=safeUrl(text);if(!safe)return null
  const url=new URL(safe)
  const host=url.hostname.replace(/^www\.|^m\./,'')
  const id=/^[A-Za-z0-9_-]{6,20}$/
  if(host==='youtube.com'||host==='youtube-nocookie.com'){
    const v=url.searchParams.get('v')||(url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)||[])[1]
    return v&&id.test(v)?{kind:'embed',src:`https://www.youtube-nocookie.com/embed/${v}`}:null
  }
  if(host==='youtu.be'){const v=url.pathname.slice(1);return id.test(v)?{kind:'embed',src:`https://www.youtube-nocookie.com/embed/${v}`}:null}
  if(host==='vimeo.com'||host==='player.vimeo.com'){const v=(url.pathname.match(/(\d{5,12})/)||[])[1];return v?{kind:'embed',src:`https://player.vimeo.com/video/${v}`}:null}
  if(url.protocol==='https:'&&/\.(mp4|webm|ogg|mov)$/i.test(url.pathname))return {kind:'file',src:safe}
  return null
}
