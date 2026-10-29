// Reporting objects, batch 3: P&L pivot, variance waterfall, Sankey, network, org chart, map,
// animator and insights. The write table is in biWriteTable.tsx.
import {useEffect,useMemo,useRef,useState} from 'react'
import {Pause,Play,SkipBack,SkipForward,Sparkles} from 'lucide-react'
import {
  SERIES_COLORS,buildSpec,compactNumber,compareValues,defaultSort,displayValue,formatNumber,niceTicks,sameValue,toNumber,
  type CompiledObject,type FieldValue,type NumberFormat,
} from './biApps'
import {fitMap,forceLayout,insights,orgTree,parseRowStyles,project,sankeyLayout,visibleTiles,type OrgNode} from './biChartMath'
import {Message,Tooltip,selectedValues,truncate,useQuery,useSize,type Compiled,type ObjectProps,type Tip} from './biChartKit'

type Props=ObjectProps&Compiled
type Dim=CompiledObject['dimensions'][number]

function useRows(props:Props,options:{sort?:{index:number;desc:boolean}[];limit?:number;measures?:unknown[];ignoreKey?:string}={}){
  const {compiled,selections,object,app,dataVersion}=props
  const spec=useMemo(()=>{
    const base=buildSpec(compiled,selections,{sort:options.sort??defaultSort(object,compiled),limit:options.limit??1000,ignoreKey:options.ignoreKey})
    return options.measures?{...base,measures:options.measures}:base
  },[compiled,selections,object,JSON.stringify(options)])// eslint-disable-line react-hooks/exhaustive-deps
  return useQuery(app.id,spec,dataVersion)
}
function selector(props:Props,dim:Dim){
  const selected=selectedValues(props.selections,dim.selectKey)
  return {
    select:(value:FieldValue,additive:boolean)=>props.onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,additive),
    dimmed:(value:FieldValue)=>selected.length>0&&!selected.some(item=>sameValue(item,value)),
    isSelected:(value:FieldValue)=>selected.some(item=>sameValue(item,value)),
  }
}
function tipAt(event:{clientX:number;clientY:number;currentTarget:Element},title:string,lines:Tip['lines']):Tip{
  const host=(event.currentTarget as SVGElement).ownerSVGElement?.closest('.bi-plot')||event.currentTarget.closest('.bi-plot')
  const r=(host as Element).getBoundingClientRect()
  return {x:event.clientX-r.left,y:event.clientY-r.top,title,lines}
}
function guard(result:{error:string;loading:boolean;rows:FieldValue[][]}){
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!result.loading&&!result.rows.length)return <Message kind="empty">No data for the current selections</Message>
  return null
}
const fmt=(value:number|null,format?:NumberFormat)=>formatNumber(value,format)
const num=(value:FieldValue)=>toNumber(value)

// ---------------------------------------------------------------------------
// P&L pivot: rows in a chosen order with styles (bold, header, line, indent, highlight, hidden),
// an optional second dimension as columns with a Total column
// ---------------------------------------------------------------------------
export function PnlPivot(props:Props){
  const {object,compiled,onSelect}=props
  const result=useRows(props,{sort:compiled.dimensions.map((_,index)=>({index,desc:false})),limit:5000})
  const blocked=guard(result);if(blocked)return blocked
  const [rowDim,colDim]=compiled.dimensions,measures=compiled.measures,nd=compiled.dimensions.length
  const rules=parseRowStyles(object.options.rowStyles)
  const rowKeys:FieldValue[]=[],colKeys:FieldValue[]=[],cells=new Map<string,FieldValue[]>()
  for(const row of result.rows){
    if(!rowKeys.some(v=>sameValue(v,row[0])))rowKeys.push(row[0])
    if(colDim&&!colKeys.some(v=>sameValue(v,row[1])))colKeys.push(row[1])
    cells.set(JSON.stringify([row[0],colDim?row[1]:null]),row.slice(nd))
  }
  colKeys.sort(compareValues)
  const label=(v:FieldValue)=>displayValue(v,rowDim.format)
  const ruleFor=(v:FieldValue)=>rules.find(r=>r.label.toLowerCase()===label(v).toLowerCase())
  const ordered=[...rules.map(r=>rowKeys.find(v=>label(v).toLowerCase()===r.label.toLowerCase())).filter((v):v is FieldValue=>v!==undefined),
    ...rowKeys.filter(v=>!ruleFor(v))].filter(v=>!ruleFor(v)?.style.hidden)
  const cols:(FieldValue|'__total')[]=colDim?[...colKeys.slice(0,40),'__total']:['__total']
  const value=(r:FieldValue,c:FieldValue|'__total',m:number)=>{
    if(c!=='__total'||!colDim)return num(cells.get(JSON.stringify([r,c==='__total'?null:c]))?.[m]??null)
    let sum:number|null=null;for(const k of colKeys){const v=num(cells.get(JSON.stringify([r,k]))?.[m]??null);if(v!==null)sum=(sum??0)+v}return sum
  }
  const header=(c:FieldValue|'__total')=>c==='__total'?(colDim?'Total':''):displayValue(c,colDim.format)
  return <div className={`bi-table-wrap ${result.loading?'is-loading':''}`}><div className="bi-table-scroll"><table className="bi-table bi-pnl">
    <thead>{colDim&&<tr><th rowSpan={measures.length>1?2:1}>{rowDim.label}</th>{cols.map((c,i)=><th key={i} colSpan={measures.length} className={`num ${c==='__total'?'bi-pnl-total':'bi-selectable'}`}
      onClick={event=>c!=='__total'&&onSelect({key:colDim.selectKey,label:colDim.label,node:colDim.node},c,event.ctrlKey||event.metaKey)}>{header(c)}</th>)}</tr>}
      {(!colDim||measures.length>1)&&<tr>{!colDim&&<th>{rowDim.label}</th>}{cols.flatMap((c,i)=>measures.map((m,j)=><th key={`${i}-${j}`} className={`num ${c==='__total'&&colDim?'bi-pnl-total':''}`}>{m.label}</th>))}</tr>}</thead>
    <tbody>{ordered.map((r,i)=>{const style=ruleFor(r)?.style||{}
      const cls=[style.bold&&'bold',style.italic&&'italic',style.header&&'header',style.highlight&&'highlight',style.line&&'line'].filter(Boolean).join(' ')
      return <tr key={i} className={cls}><td className="bi-selectable" style={style.indent?{paddingLeft:28}:undefined}
          onClick={event=>onSelect({key:rowDim.selectKey,label:rowDim.label,node:rowDim.node},r,event.ctrlKey||event.metaKey)}>{label(r)}</td>
        {cols.flatMap((c,ci)=>measures.map((m,j)=><td key={`${ci}-${j}`} className={`num ${c==='__total'&&colDim?'bi-pnl-total':''}`}>{style.header?'':fmt(value(r,c,j),m.format)}</td>))}</tr>})}</tbody>
  </table></div>{colKeys.length>40&&<small className="bi-note">Showing the first 40 columns</small>}</div>
}

// ---------------------------------------------------------------------------
// Variance waterfall: from the comparison total (second measure) to the actual total (first),
// one step per dimension value
// ---------------------------------------------------------------------------
export function VarianceWaterfall(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:object.options.sortBy!=null?defaultSort(object,compiled):[{index:0,desc:false}],limit:60})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],[actual,base]=compiled.measures;const {select,dimmed}=selector(props,dim)
  const blocked=guard(result);if(blocked)return blocked
  const rows=result.rows.map(row=>({value:row[0],a:num(row[1])??0,b:num(row[2])??0}))
  const start=rows.reduce((s,r)=>s+r.b,0),end=rows.reduce((s,r)=>s+r.a,0)
  let run=start
  const steps=[{label:base.label,value:null as FieldValue,from:0,to:start,kind:'total'},
    ...rows.map(r=>{const from=run;run+=r.a-r.b;return {label:displayValue(r.value,dim.format),value:r.value,from,to:run,kind:r.a-r.b>=0?'up':'down'}}),
    {label:actual.label,value:null,from:0,to:end,kind:'total'}]
  const W=size.width,H=size.height,format=actual.format
  const ticks=niceTicks(Math.min(0,...steps.map(s=>Math.min(s.from,s.to))),Math.max(1e-9,...steps.map(s=>Math.max(s.from,s.to))),5)
  const left=Math.max(34,...ticks.map(t=>compactNumber(t,format).length*7+8)),right=W-10,top=10,bottom=H-(steps.length>6?44:28)
  const y=(v:number)=>bottom-(v-ticks[0])/((ticks[ticks.length-1]-ticks[0])||1)*(bottom-top)
  const band=(right-left)/steps.length,bw=Math.min(40,band*0.7),rotate=steps.length>6
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot" ref={ref}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Variance waterfall'} onMouseLeave={()=>setTip(null)}>
      {ticks.map(t=><g key={t}><line x1={left} x2={right} y1={y(t)} y2={y(t)} className="bi-grid"/><text x={left-6} y={y(t)+4} textAnchor="end" className="bi-axis">{compactNumber(t,format)}</text></g>)}
      {steps.map((s,i)=>{const cx=left+band*i+band/2,a=y(Math.max(s.from,s.to)),b=y(Math.min(s.from,s.to))
        const color=s.kind==='total'?(i===0?'#9aa5ae':'#2a78d6'):s.kind==='up'?'#1baf7a':'#e34948'
        return <g key={i} className={`bi-hit ${s.kind!=='total'&&dimmed(s.value)?'dimmed':''}`} onClick={event=>s.kind!=='total'&&select(s.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,s.label,s.kind==='total'?[{label:s.label,value:fmt(s.to,format)}]:[{label:'Difference',value:(s.to-s.from>=0?'+':'')+fmt(s.to-s.from,format)},{label:'Running total',value:fmt(s.to,format)}]))}>
          <rect x={cx-bw/2} y={a} width={bw} height={Math.max(1,b-a)} rx={2} fill={color}/>
          {i<steps.length-1&&<line x1={cx+bw/2} x2={cx+band-bw/2} y1={y(s.to)} y2={y(s.to)} stroke="#9aa7b2" strokeDasharray="3 2"/>}
          <text transform={rotate?`translate(${cx},${bottom+12}) rotate(-35)`:undefined} x={rotate?0:cx} y={rotate?0:bottom+18} textAnchor={rotate?'end':'middle'} className="bi-axis bi-cat">{truncate(s.label,16)}</text>
        </g>})}
    </svg>}<Tooltip tip={tip} width={W}/></div></div>
}

// ---------------------------------------------------------------------------
// Sankey: flows from the first dimension to the next (2 to 4 dimensions)
// ---------------------------------------------------------------------------
export function SankeyChart(props:Props){
  const {object,compiled}=props
  const nd=compiled.dimensions.length
  const result=useRows(props,{sort:[{index:nd,desc:true}],limit:2000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const m=compiled.measures[0]
  const sel=compiled.dimensions.map(d=>selector(props,d))
  const layout=useMemo(()=>sankeyLayout(result.rows.map(row=>({path:compiled.dimensions.map((d,i)=>({value:row[i],label:displayValue(row[i],d.format)})),v:num(row[nd])??0})),Math.max(40,size.height-12)),[result.rows,compiled,nd,size.height])
  const blocked=guard(result);if(blocked)return blocked
  const W=size.width,colW=12,labelSpace=110,x=(c:number)=>c===0?labelSpace:labelSpace+(W-2*labelSpace-colW)*c/Math.max(1,layout.columns-1)
  const node=new Map(layout.nodes.map(n=>[n.id,n]))
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot" ref={ref}>
    {W>200&&size.height>60&&<svg width={W} height={size.height} role="img" aria-label={object.title||'Sankey chart'} onMouseLeave={()=>setTip(null)}>
      <g transform="translate(0,6)">
      {layout.links.map((l,i)=>{const s=node.get(l.source)!,t=node.get(l.target)!,x0=x(s.column)+colW,x1=x(t.column),mx=(x0+x1)/2
        return <path key={i} d={`M${x0},${l.sy+l.w/2}C${mx},${l.sy+l.w/2} ${mx},${l.ty+l.w/2} ${x1},${l.ty+l.w/2}`} fill="none" stroke={SERIES_COLORS[layout.nodes.filter(n=>n.column===0).indexOf(s)%SERIES_COLORS.length]||'#9aa5ae'}
          strokeOpacity={0.35} strokeWidth={l.w} className="bi-hit" onMouseMove={event=>setTip(tipAt(event,`${s.label} → ${t.label}`,[{label:m.label,value:fmt(l.v,m.format)}]))}/>})}
      {layout.nodes.map(n=>{const d=compiled.dimensions[n.column]
        return <g key={n.id} className={`bi-hit ${sel[n.column].dimmed(n.value as FieldValue)?'dimmed':''}`} onClick={event=>sel[n.column].select(n.value as FieldValue,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,`${d.label}: ${n.label}`,[{label:m.label,value:fmt(n.total,m.format)}]))}>
          <rect x={x(n.column)} y={n.y} width={colW} height={n.h} rx={2} fill={n.column===0?SERIES_COLORS[layout.nodes.filter(k=>k.column===0).indexOf(n)%SERIES_COLORS.length]:'#526170'}/>
          {n.h>9&&<text x={n.column===layout.columns-1?x(n.column)-6:x(n.column)+colW+6} y={n.y+n.h/2+4} textAnchor={n.column===layout.columns-1?'end':'start'} className="bi-axis bi-cat">{truncate(n.label,16)}</text>}
        </g>})}
      </g>
    </svg>}<Tooltip tip={tip} width={W}/></div></div>
}

// ---------------------------------------------------------------------------
// Network: nodes from two dimensions (from → to), optional measure as link weight
// ---------------------------------------------------------------------------
export function NetworkChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:compiled.measures.length?[{index:2,desc:true}]:[{index:0,desc:false}],limit:600})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const [from,to]=compiled.dimensions,m=compiled.measures[0];const s1=selector(props,from),s2=selector(props,to)
  const graph=useMemo(()=>{
    const edges=result.rows.filter(r=>r[0]!==null&&r[1]!==null).map(r=>({a:displayValue(r[0],from.format),b:displayValue(r[1],to.format),va:r[0],vb:r[1],w:m?num(r[2])??0:1}))
    const ids=[...new Set(edges.flatMap(e=>[e.a,e.b]))].slice(0,150)
    const keep=edges.filter(e=>ids.includes(e.a)&&ids.includes(e.b))
    const degree=new Map(ids.map(id=>[id,0]));for(const e of keep){degree.set(e.a,(degree.get(e.a)||0)+e.w);degree.set(e.b,(degree.get(e.b)||0)+e.w)}
    return {ids,edges:keep,degree,raw:new Map(keep.flatMap(e=>[[e.a,{value:e.va,from:true}],[e.b,{value:e.vb,from:false}]] as [string,{value:FieldValue;from:boolean}][]))}
  },[result.rows,from.format,to.format,m])
  const pos=useMemo(()=>size.width>60?forceLayout(graph.ids,graph.edges,size.width,size.height):new Map(),[graph,size.width,size.height])
  const blocked=guard(result);if(blocked)return blocked
  const maxW=Math.max(1e-9,...graph.edges.map(e=>e.w)),maxD=Math.max(1e-9,...graph.degree.values())
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot" ref={ref}>
    {size.width>60&&<svg width={size.width} height={size.height} role="img" aria-label={object.title||'Network chart'} onMouseLeave={()=>setTip(null)}>
      {graph.edges.map((e,i)=>{const p=pos.get(e.a),q=pos.get(e.b);if(!p||!q)return null
        return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#9aa7b2" strokeOpacity={0.7} strokeWidth={1+3*e.w/maxW}
          onMouseMove={event=>setTip(tipAt(event,`${e.a} → ${e.b}`,m?[{label:m.label,value:fmt(e.w,m.format)}]:[]))}/>})}
      {graph.ids.map(id=>{const p=pos.get(id);if(!p)return null;const raw=graph.raw.get(id)!,sel=raw.from?s1:s2,r=5+9*Math.sqrt((graph.degree.get(id)||0)/maxD)
        return <g key={id} className={`bi-hit ${sel.dimmed(raw.value)?'dimmed':''}`} onClick={event=>sel.select(raw.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,id,m?[{label:m.label,value:fmt(graph.degree.get(id)||0,m.format)}]:[{label:'Links',value:String(graph.edges.filter(e=>e.a===id||e.b===id).length)}]))}>
          <circle cx={p.x} cy={p.y} r={r} fill={raw.from?SERIES_COLORS[0]:SERIES_COLORS[1]} stroke="#fff" strokeWidth={2}/>
          {graph.ids.length<=60&&<text x={p.x+r+3} y={p.y+4} className="bi-axis bi-point-label">{truncate(id,16)}</text>}
        </g>})}
    </svg>}<Tooltip tip={tip} width={size.width}/></div></div>
}

// ---------------------------------------------------------------------------
// Org chart: node and parent dimensions, optional third dimension as a subtitle and a measure
// ---------------------------------------------------------------------------
type OrgData={value:FieldValue;label:string;subtitle:string;measure:number|null}
export function OrgChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:1000})
  const dims=compiled.dimensions,m=compiled.measures[0];const sel=selector(props,dims[0])
  const [ref,size]=useSize<HTMLDivElement>()
  const tree=useMemo(()=>orgTree<OrgData>(result.rows.filter(r=>r[0]!==null).map(r=>({
    id:displayValue(r[0],dims[0].format),parent:r[1]===null?null:displayValue(r[1],dims[1].format),
    data:{value:r[0],label:displayValue(r[0],dims[0].format),subtitle:dims[2]&&r[2]!==null?displayValue(r[2],dims[2].format):'',measure:m?num(r[dims.length]):null}})),
    id=>({value:null,label:id,subtitle:'',measure:null})),[result.rows,dims,m])
  const blocked=guard(result);if(blocked)return blocked
  const cardW=150,cardH=m||dims[2]?58:38,gapX=16,gapY=34
  const all:OrgNode<OrgData>[]=[];const walk=(n:OrgNode<OrgData>)=>{all.push(n);n.children.forEach(walk)};tree.roots.forEach(walk)
  const X=(n:OrgNode<OrgData>)=>8+n.x*(cardW+gapX),Y=(n:OrgNode<OrgData>)=>8+n.depth*(cardH+gapY)
  const fullW=16+tree.width*(cardW+gapX),fullH=16+tree.depth*(cardH+gapY)
  // shrink wide trees to fit (down to 75%), otherwise scroll; centre narrow ones
  const scale=size.width>0?Math.max(0.75,Math.min(1,size.width/fullW)):1
  return <div className={`bi-org ${result.loading?'is-loading':''}`} ref={ref}><svg width={fullW*scale} height={fullH*scale} viewBox={`0 0 ${fullW} ${fullH}`} role="img" aria-label={object.title||'Org chart'} style={{margin:fullW*scale<size.width?'0 auto':undefined,display:'block'}}>
    {all.flatMap(n=>n.children.map(c=><path key={`${n.id}>${c.id}`} d={`M${X(n)+cardW/2},${Y(n)+cardH}V${Y(n)+cardH+gapY/2}H${X(c)+cardW/2}V${Y(c)}`} fill="none" stroke="#b7c3cc"/>))}
    {all.map(n=><g key={n.id} className={`bi-hit ${n.data.value!==null&&sel.dimmed(n.data.value)?'dimmed':''}`} onClick={event=>n.data.value!==null&&sel.select(n.data.value,event.ctrlKey||event.metaKey)}>
      <rect x={X(n)} y={Y(n)} width={cardW} height={cardH} rx={8} fill={sel.isSelected(n.data.value)?'#e7f6ef':'#fff'} stroke={n.depth===0?'#1d4668':'#d5dfe6'} strokeWidth={n.depth===0?2:1}/>
      <text x={X(n)+10} y={Y(n)+20} className="bi-org-name">{truncate(n.data.label,19)}</text>
      {n.data.subtitle&&<text x={X(n)+10} y={Y(n)+36} className="bi-axis">{truncate(n.data.subtitle,22)}</text>}
      {m&&n.data.value!==null&&<text x={X(n)+10} y={Y(n)+(n.data.subtitle?51:38)} className="bi-axis bi-org-measure">{m.label}: {fmt(n.data.measure,m.format)}</text>}
    </g>)}
  </svg>{result.has_more&&<small className="bi-note">Showing the first 1,000 rows</small>}</div>
}

// ---------------------------------------------------------------------------
// Map: points by latitude and longitude (measures 1 and 2), optional bubble size (measure 3)
// ---------------------------------------------------------------------------
export function MapChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:compiled.measures.length>2?3:0,desc:compiled.measures.length>2}],limit:2000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],[mlat,mlon,msize]=compiled.measures;const {select,dimmed}=selector(props,dim)
  const blocked=guard(result);if(blocked)return blocked
  const points=result.rows.map(row=>({value:row[0],lat:num(row[1]),lon:num(row[2]),s:msize?num(row[3]):null}))
    .filter(p=>p.lat!==null&&p.lon!==null&&Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180) as {value:FieldValue;lat:number;lon:number;s:number|null}[]
  if(!points.length)return <Message kind="empty">No rows with a latitude and longitude</Message>
  const W=size.width,H=size.height,view=fitMap(points,W,H)
  const tiles=object.options.tiles===false?[]:visibleTiles(view.zoom,view.cx,view.cy,W,H)
  const smax=Math.max(1e-9,...points.map(p=>Math.abs(p.s??0)))
  const at=(p:{lat:number;lon:number})=>{const q=project(p.lat,p.lon,view.zoom);return {x:q.x-(view.cx-W/2),y:q.y-(view.cy-H/2)}}
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot bi-map" ref={ref}>
    {W>60&&H>60&&<>
      {tiles.map(t=><img key={`${t.x}-${t.y}-${t.left}`} src={t.url} alt="" className="bi-map-tile" style={{left:t.left,top:t.top}} referrerPolicy="strict-origin-when-cross-origin" loading="lazy" draggable={false}/>)}
      <svg width={W} height={H} role="img" aria-label={object.title||'Map'} onMouseLeave={()=>setTip(null)}>
        {[...points].sort((a,b)=>(b.s??0)-(a.s??0)).map((p,i)=>{const {x,y}=at(p),r=msize?4+Math.sqrt(Math.abs(p.s??0)/smax)*18:6
          return <circle key={i} cx={x} cy={y} r={r} fill={SERIES_COLORS[0]} fillOpacity={0.6} stroke="#fff" strokeWidth={1.5} className={`bi-hit ${dimmed(p.value)?'dimmed':''}`}
            onClick={event=>select(p.value,event.ctrlKey||event.metaKey)}
            onMouseMove={event=>setTip(tipAt(event,displayValue(p.value,dim.format),msize?[{label:msize.label,value:fmt(p.s,msize.format)}]:[{label:`${mlat.label}, ${mlon.label}`,value:`${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`}]))}/>})}
      </svg>
      {tiles.length>0&&<small className="bi-map-credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</small>}
    </>}<Tooltip tip={tip} width={W}/></div></div>
}

// ---------------------------------------------------------------------------
// Animator: steps a selection through the values of a dimension (e.g. month by month)
// ---------------------------------------------------------------------------
export function AnimatorObject(props:Props){
  const {object,compiled,runtime,selections}=props
  const dim=compiled.dimensions[0]
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:500,measures:[],ignoreKey:dim.selectKey})
  const values=useMemo(()=>result.rows.map(r=>r[0]).filter(v=>v!==null),[result.rows])
  const current=selectedValues(selections,dim.selectKey)
  const index=current.length===1?values.findIndex(v=>sameValue(v,current[0])):-1
  const [playing,setPlaying]=useState(false)
  const indexRef=useRef(index);indexRef.current=index
  const go=(i:number)=>{if(!runtime||!values.length)return;const n=(i+values.length)%values.length;runtime.setSelection({key:dim.selectKey,label:dim.label,node:dim.node},[values[n]])}
  useEffect(()=>{
    if(!playing||!values.length)return
    const timer=setInterval(()=>{const next=indexRef.current+1
      if(next>=values.length&&!object.options.loop){setPlaying(false);return}
      go(next)},Math.max(300,object.options.interval||1200))
    return()=>clearInterval(timer)
  },[playing,values,object.options.interval,object.options.loop])// eslint-disable-line react-hooks/exhaustive-deps
  if(!runtime)return <Message kind="empty">Available when the app is open</Message>
  if(result.error)return <Message kind="error">{result.error}</Message>
  return <div className="bi-control bi-animator">
    <div className="bi-control-row">
      <button type="button" className="icon-button" aria-label="Previous" disabled={runtime.editing} onClick={()=>{setPlaying(false);go(index<0?0:index-1)}}><SkipBack size={16}/></button>
      <button type="button" className="primary" aria-label={playing?'Pause':'Play'} disabled={runtime.editing||!values.length} onClick={()=>{if(!playing&&(index<0||index>=values.length-1))go(0);setPlaying(!playing)}}>{playing?<Pause size={15}/>:<Play size={15}/>}</button>
      <button type="button" className="icon-button" aria-label="Next" disabled={runtime.editing} onClick={()=>{setPlaying(false);go(index+1)}}><SkipForward size={16}/></button>
      <b className="bi-animator-value">{index>=0?displayValue(values[index],dim.format):'—'}</b>
    </div>
    <input type="range" min={0} max={Math.max(0,values.length-1)} value={Math.max(0,index)} disabled={runtime.editing||!values.length} aria-label={`${dim.label} step`} onChange={event=>{setPlaying(false);go(Number(event.target.value))}}/>
  </div>
}

// ---------------------------------------------------------------------------
// Insights: plain-language findings about one measure over one dimension (calculated, not AI)
// ---------------------------------------------------------------------------
export function InsightsObject(props:Props){
  const {compiled}=props
  const dim=compiled.dimensions[0],m=compiled.measures[0]
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:5000})
  const blocked=guard(result);if(blocked)return blocked
  const rows=result.rows.map(r=>({label:displayValue(r[0],dim.format),v:num(r[1])??NaN}))
  const ordered=result.rows.length>2&&result.rows.every(r=>r[0]===null||typeof r[0]==='number'||/^\d{4}(-\d{2}){0,2}/.test(String(r[0])))
  const list=insights(rows,{measure:m.label,dimension:dim.label,format:v=>formatNumber(v,m.format),ordered})
  return <div className={`bi-insights ${result.loading?'is-loading':''}`}>
    <ul>{list.map((line,i)=><li key={i}><Sparkles size={13}/><span>{line}</span></li>)}</ul>
    {result.has_more&&<small className="bi-note">Based on the first 5,000 values</small>}
  </div>
}

