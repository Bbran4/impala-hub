// Pure layout and statistics helpers for Reporting charts (tested in tests/biChartMath.test.mjs).

export type Rect={x:number;y:number;w:number;h:number}
export function squarify<T extends {v:number}>(items:T[],rect:Rect):(T&Rect)[]{
  const out:(T&Rect)[]=[];const list=items.filter(i=>i.v>0).sort((a,b)=>b.v-a.v)
  let {x,y,w,h}=rect;let rest=list.reduce((s,i)=>s+i.v,0);let i=0
  while(i<list.length&&w>0&&h>0){
    const short=Math.min(w,h),scale=(w*h)/rest
    let row=[list[i]],best=worst(row,short,scale);let j=i+1
    while(j<list.length){const next=[...row,list[j]],score=worst(next,short,scale);if(score>best)break;row=next;best=score;j++}
    const sum=row.reduce((s,r)=>s+r.v,0)*scale,thick=sum/short;let offset=0
    for(const item of row){const len=item.v*scale/thick
      out.push(w>=h?{...item,x,y:y+offset,w:thick,h:len}:{...item,x:x+offset,y,w:len,h:thick});offset+=len}
    if(w>=h){x+=thick;w-=thick}else{y+=thick;h-=thick}
    rest-=row.reduce((s,r)=>s+r.v,0);i=j
  }
  return out
}
function worst(row:{v:number}[],short:number,scale:number){const areas=row.map(r=>r.v*scale),sum=areas.reduce((a,b)=>a+b,0);return Math.max(...areas.map(a=>Math.max(short*short*a/(sum*sum),(sum*sum)/(short*short*a))))}


export function histogramBins(values:{v:number;n:number}[],bins?:number){
  if(!values.length)return []
  const total=values.reduce((s,p)=>s+p.n,0)
  const lo=Math.min(...values.map(p=>p.v)),hi=Math.max(...values.map(p=>p.v))
  const count=Math.max(1,Math.min(60,bins||Math.ceil(Math.log2(Math.max(2,total))+1)))
  if(lo===hi)return [{from:lo,to:hi,n:total,values:values.map(p=>p.v)}]
  const raw=(hi-lo)/count,mag=10**Math.floor(Math.log10(raw)),width=[1,2,2.5,5,10].map(s=>s*mag).find(s=>s>=raw)||raw
  const start=Math.floor(lo/width)*width,n=Math.max(1,Math.ceil((hi-start)/width+1e-9))
  const out=Array.from({length:n},(_,i)=>({from:start+i*width,to:start+(i+1)*width,n:0,values:[] as number[]}))
  for(const p of values){const i=Math.min(n-1,Math.floor((p.v-start)/width+1e-9));out[i].n+=p.n;out[i].values.push(p.v)}
  return out
}

export function quartiles(values:number[]){
  const s=[...values].sort((a,b)=>a-b),q=(p:number)=>{const i=(s.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo)}
  const q1=q(0.25),median=q(0.5),q3=q(0.75),iqr=q3-q1
  const inside=s.filter(v=>v>=q1-1.5*iqr&&v<=q3+1.5*iqr)
  return {q1,median,q3,low:inside[0]??s[0],high:inside[inside.length-1]??s[s.length-1],outliers:s.filter(v=>v<q1-1.5*iqr||v>q3+1.5*iqr),count:s.length}
}
