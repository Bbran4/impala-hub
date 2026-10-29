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

// ---------------------------------------------------------------------------
// Sankey: columns of nodes (one column per dimension) joined by flows sized by value
// ---------------------------------------------------------------------------
export type SankeyNode={id:string;column:number;value:unknown;label:string;total:number;y:number;h:number}
export type SankeyLink={source:string;target:string;v:number;sy:number;ty:number;w:number}
export function sankeyLayout(rows:{path:{value:unknown;label:string}[];v:number}[],height:number,gap=8){
  const columns=Math.max(0,...rows.map(r=>r.path.length))
  const nodes=new Map<string,SankeyNode>(),links=new Map<string,SankeyLink>()
  const id=(c:number,label:string)=>`${c}\u0001${label}`
  for(const row of rows){if(!(row.v>0))continue
    row.path.forEach((step,c)=>{const key=id(c,step.label);const node=nodes.get(key)||{id:key,column:c,value:step.value,label:step.label,total:0,y:0,h:0};node.total+=row.v;nodes.set(key,node)})
    for(let c=0;c+1<row.path.length;c++){const s=id(c,row.path[c].label),t=id(c+1,row.path[c+1].label),k=s+'\u0002'+t
      const link=links.get(k)||{source:s,target:t,v:0,sy:0,ty:0,w:0};link.v+=row.v;links.set(k,link)}
  }
  const all=[...nodes.values()]
  const maxTotal=Math.max(1e-9,...Array.from({length:columns},(_,c)=>all.filter(n=>n.column===c).reduce((s,n)=>s+n.total,0)))
  const maxCount=Math.max(1,...Array.from({length:columns},(_,c)=>all.filter(n=>n.column===c).length))
  const scale=Math.max(0,(height-gap*(maxCount-1)))/maxTotal
  for(let c=0;c<columns;c++){let y=0
    for(const node of all.filter(n=>n.column===c).sort((a,b)=>b.total-a.total)){node.y=y;node.h=Math.max(1,node.total*scale);y+=node.h+gap}}
  const out=new Map<string,number>(),inn=new Map<string,number>()
  const list=[...links.values()].sort((a,b)=>nodes.get(a.target)!.y-nodes.get(b.target)!.y||nodes.get(a.source)!.y-nodes.get(b.source)!.y)
  for(const link of list){const s=nodes.get(link.source)!,t=nodes.get(link.target)!;link.w=Math.max(1,link.v*scale)
    link.sy=s.y+(out.get(s.id)||0);out.set(s.id,(out.get(s.id)||0)+link.v*scale)
    link.ty=t.y+(inn.get(t.id)||0);inn.set(t.id,(inn.get(t.id)||0)+link.v*scale)}
  return {nodes:all,links:list,columns}
}

// ---------------------------------------------------------------------------
// Network: a simple, repeatable force layout
// ---------------------------------------------------------------------------
export function forceLayout(nodeIds:string[],edges:{a:string;b:string}[],width:number,height:number,iterations=300){
  const n=nodeIds.length;const pos=new Map<string,{x:number;y:number}>()
  nodeIds.forEach((id,i)=>{const a=2*Math.PI*i/Math.max(1,n);pos.set(id,{x:width/2+Math.cos(a)*width/3,y:height/2+Math.sin(a)*height/3})})
  const k=Math.sqrt((width*height)/Math.max(1,n))*0.4
  for(let it=0;it<iterations;it++){
    const t=(1-it/iterations)*Math.min(width,height)/10
    const disp=new Map(nodeIds.map(id=>[id,{x:0,y:0}]))
    for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){const p=pos.get(nodeIds[i])!,q=pos.get(nodeIds[j])!
      let dx=p.x-q.x,dy=p.y-q.y;let d=Math.hypot(dx,dy);if(d<0.01){dx=0.01*(i-j);dy=0.01;d=Math.hypot(dx,dy)}
      const f=k*k/d;disp.get(nodeIds[i])!.x+=dx/d*f;disp.get(nodeIds[i])!.y+=dy/d*f;disp.get(nodeIds[j])!.x-=dx/d*f;disp.get(nodeIds[j])!.y-=dy/d*f}
    for(const e of edges){const p=pos.get(e.a),q=pos.get(e.b);if(!p||!q||e.a===e.b)continue
      const dx=p.x-q.x,dy=p.y-q.y,d=Math.max(0.01,Math.hypot(dx,dy)),f=d*d/k
      disp.get(e.a)!.x-=dx/d*f;disp.get(e.a)!.y-=dy/d*f;disp.get(e.b)!.x+=dx/d*f;disp.get(e.b)!.y+=dy/d*f}
    // gravity keeps separate groups near the middle instead of pushed against the edges
    for(const id of nodeIds){const p=pos.get(id)!,d=disp.get(id)!;d.x-=(p.x-width/2)*0.8;d.y-=(p.y-height/2)*0.8}
    for(const id of nodeIds){const p=pos.get(id)!,d=disp.get(id)!,len=Math.max(0.01,Math.hypot(d.x,d.y))
      p.x=Math.min(width-20,Math.max(20,p.x+d.x/len*Math.min(len,t)));p.y=Math.min(height-20,Math.max(20,p.y+d.y/len*Math.min(len,t)))}
  }
  return pos
}

// ---------------------------------------------------------------------------
// Org chart: a tree from (node, parent) pairs; leaves side by side, parents centred above
// ---------------------------------------------------------------------------
export type OrgNode<T>={id:string;data:T;children:OrgNode<T>[];x:number;depth:number}
export function orgTree<T>(items:{id:string;parent:string|null;data:T}[],missingParent?:(id:string)=>T){
  const byId=new Map(items.map(item=>[item.id,{id:item.id,data:item.data,children:[] as OrgNode<T>[],x:0,depth:0}]))
  // parents that are not rows themselves (e.g. a top level that only appears as a parent) become nodes too
  if(missingParent)for(const item of [...items])if(item.parent!==null&&!byId.has(item.parent)){
    byId.set(item.parent,{id:item.parent,data:missingParent(item.parent),children:[],x:0,depth:0});items=[...items,{id:item.parent,parent:null,data:missingParent(item.parent)}]}
  const roots:OrgNode<T>[]=[]
  for(const item of items){const node=byId.get(item.id)!
    const parent=item.parent!==null&&item.parent!==item.id?byId.get(item.parent):undefined
    if(parent&&!isAncestor(node,parent))parent.children.push(node);else roots.push(node)}
  let leaf=0;let depth=0
  const place=(node:OrgNode<T>,d:number)=>{node.depth=d;depth=Math.max(depth,d)
    if(!node.children.length){node.x=leaf++;return}
    node.children.forEach(child=>place(child,d+1));node.x=(node.children[0].x+node.children[node.children.length-1].x)/2}
  roots.forEach(root=>place(root,0))
  return {roots,width:leaf,depth:depth+1}
}
function isAncestor<T>(node:OrgNode<T>,candidate:OrgNode<T>):boolean{
  // true when `candidate` is inside `node`'s subtree (linking them would make a loop)
  const stack=[...node.children];while(stack.length){const n=stack.pop()!;if(n===candidate)return true;stack.push(...n.children)}
  return node===candidate
}

// ---------------------------------------------------------------------------
// Map: Web Mercator maths for placing points and choosing OpenStreetMap tiles
// ---------------------------------------------------------------------------
export function project(lat:number,lon:number,zoom:number){
  const s=256*2**zoom,phi=Math.max(-85.0511,Math.min(85.0511,lat))*Math.PI/180
  return {x:(lon+180)/360*s,y:(1-Math.log(Math.tan(phi)+1/Math.cos(phi))/Math.PI)/2*s}
}
export function fitMap(points:{lat:number;lon:number}[],width:number,height:number,pad=30){
  if(!points.length)return {zoom:5,cx:0,cy:0}
  for(let zoom=16;zoom>=1;zoom--){
    const ps=points.map(p=>project(p.lat,p.lon,zoom))
    const minX=Math.min(...ps.map(p=>p.x)),maxX=Math.max(...ps.map(p=>p.x)),minY=Math.min(...ps.map(p=>p.y)),maxY=Math.max(...ps.map(p=>p.y))
    if(maxX-minX<=width-2*pad&&maxY-minY<=height-2*pad||zoom===1)return {zoom:points.length===1?Math.min(zoom,12):zoom,cx:(minX+maxX)/2,cy:(minY+maxY)/2}
  }
  return {zoom:1,cx:0,cy:0}
}
export function visibleTiles(zoom:number,cx:number,cy:number,width:number,height:number){
  const n=2**zoom,tiles:{x:number;y:number;left:number;top:number;url:string}[]=[]
  const x0=Math.floor((cx-width/2)/256),x1=Math.floor((cx+width/2)/256),y0=Math.max(0,Math.floor((cy-height/2)/256)),y1=Math.min(n-1,Math.floor((cy+height/2)/256))
  for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const wx=((x%n)+n)%n
    tiles.push({x:wx,y,left:x*256-(cx-width/2),top:y*256-(cy-height/2),url:`https://tile.openstreetmap.org/${zoom}/${wx}/${y}.png`})}
  return tiles
}

// ---------------------------------------------------------------------------
// Insights: plain-language findings from a dimension and a measure
// ---------------------------------------------------------------------------
export function insights(rows:{label:string;v:number}[],options:{measure:string;dimension:string;format:(v:number)=>string;ordered?:boolean}){
  const out:string[]=[]
  const list=rows.filter(r=>Number.isFinite(r.v))
  if(!list.length)return out
  const total=list.reduce((s,r)=>s+r.v,0)
  const ranked=[...list].sort((a,b)=>b.v-a.v)
  const pct=(v:number)=>`${(v*100).toFixed(v>=0.1?0:1)}%`
  out.push(`${options.measure} is ${options.format(total)} in total across ${list.length} ${list.length===1?'value':'values'} of ${options.dimension}.`)
  if(list.length>1&&total>0){
    out.push(`${ranked[0].label} is the highest with ${options.format(ranked[0].v)} (${pct(ranked[0].v/total)} of the total).`)
    out.push(`${ranked[ranked.length-1].label} is the lowest with ${options.format(ranked[ranked.length-1].v)}.`)
    if(list.length>3){const top=ranked.slice(0,3).reduce((s,r)=>s+r.v,0);out.push(`The top 3 (${ranked.slice(0,3).map(r=>r.label).join(', ')}) make up ${pct(top/total)}.`)}
    const avg=total/list.length;const above=list.filter(r=>r.v>avg).length
    out.push(`${above} of ${list.length} are above the average of ${options.format(avg)}.`)
  }
  if(options.ordered&&list.length>2){
    const last=list[list.length-1],prev=list[list.length-2]
    if(prev.v!==0)out.push(`From ${prev.label} to ${last.label}, ${options.measure} ${last.v>=prev.v?'rose':'fell'} ${pct(Math.abs(last.v-prev.v)/Math.abs(prev.v))} (${options.format(prev.v)} → ${options.format(last.v)}).`)
    let best=1;for(let i=2;i<list.length;i++)if(Math.abs(list[i].v-list[i-1].v)>Math.abs(list[best].v-list[best-1].v))best=i
    if(best!==list.length-1)out.push(`The biggest change was from ${list[best-1].label} to ${list[best].label} (${list[best].v>=list[best-1].v?'+':'−'}${options.format(Math.abs(list[best].v-list[best-1].v))}).`)
  }
  return out
}

// ---------------------------------------------------------------------------
// P&L pivot row styles: one rule per line, "Gross profit: bold, line"
// ---------------------------------------------------------------------------
export type RowStyle={bold?:boolean;italic?:boolean;header?:boolean;highlight?:boolean;line?:boolean;indent?:boolean;hidden?:boolean}
export function parseRowStyles(text:string|undefined){
  const rules:{label:string;style:RowStyle}[]=[]
  for(const raw of (text||'').split('\n')){const line=raw.trim();if(!line)continue
    const at=line.lastIndexOf(':');const label=(at>0?line.slice(0,at):line).trim();const words=at>0?line.slice(at+1).toLowerCase().split(/[\s,]+/):[]
    const style:RowStyle={};for(const w of words){if(w==='bold'||w==='italic'||w==='header'||w==='highlight'||w==='line'||w==='indent'||w==='hidden')style[w]=true}
    if(label)rules.push({label,style})}
  return rules
}
