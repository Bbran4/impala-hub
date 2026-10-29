// More Reporting chart objects (batch 1): combo, scatter, gauge, bullet, funnel, waterfall, treemap,
// histogram, box plot, distribution plot, radar, mekko, grid (heat map) and word cloud.
// All are drawn as SVG/HTML from bi_query results and support click-to-select like the other charts.
import {useMemo,useState,type ReactNode} from 'react'
import {
  SERIES_COLORS,buildSpec,compactNumber,compareValues,defaultSort,displayValue,formatNumber,niceTicks,sameValue,toNumber,toSeries,
  type CompiledObject,type FieldValue,type NumberFormat,type Selection,
} from './biApps'
import {histogramBins,quartiles,squarify} from './biChartMath'
import {Legend,Message,Tooltip,selectedValues,truncate,useQuery,useSize,type Compiled,type ObjectProps,type Tip} from './biChartKit'

type Props=ObjectProps&Compiled
type Dim=CompiledObject['dimensions'][number]

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function useRows(props:Props,options:{sort?:{index:number;desc:boolean}[];limit?:number;measures?:unknown[]}={}){
  const {compiled,selections,object,app,dataVersion}=props
  const spec=useMemo(()=>{
    const base=buildSpec(compiled,selections,{sort:options.sort??defaultSort(object,compiled),limit:options.limit??500})
    return options.measures?{...base,measures:options.measures}:base
  },[compiled,selections,object,JSON.stringify(options)])// eslint-disable-line react-hooks/exhaustive-deps
  return useQuery(app.id,spec,dataVersion)
}
function selector(props:Props,dim:Dim){
  const selected=selectedValues(props.selections,dim.selectKey)
  return {
    select:(value:FieldValue,additive:boolean)=>props.onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,additive),
    dimmed:(value:FieldValue)=>selected.length>0&&!selected.some(item=>sameValue(item,value)),
    selected,
  }
}
function tipAt(event:{clientX:number;clientY:number;currentTarget:Element},title:string,lines:Tip['lines']):Tip{
  const svg=(event.currentTarget as SVGElement).ownerSVGElement||event.currentTarget.closest('.bi-plot')
  const r=(svg as Element).getBoundingClientRect()
  return {x:event.clientX-r.left,y:event.clientY-r.top,title,lines}
}
function Frame({loading,plotRef,children,tip,width,footer}:{loading:boolean;plotRef:(node:HTMLDivElement|null)=>void;children:ReactNode;tip:Tip|null;width:number;footer?:ReactNode}){
  return <div className={`bi-chart ${loading?'is-loading':''}`}><div className="bi-plot" ref={plotRef}>{children}<Tooltip tip={tip} width={width}/></div>{footer}</div>
}
function guard(result:{error:string;loading:boolean;rows:FieldValue[][]}):ReactNode|null{
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!result.loading&&!result.rows.length)return <Message kind="empty">No data for the current selections</Message>
  return null
}
const fmt=(value:number|null,format?:NumberFormat)=>formatNumber(value,format)
const num=(value:FieldValue)=>toNumber(value)
function linear(d0:number,d1:number,r0:number,r1:number){return (v:number)=>r0+(v-d0)/((d1-d0)||1)*(r1-r0)}

// Left value axis with gridlines; returns the plot area.
function ValueAxis({ticks,y,left,right,format,side='left'}:{ticks:number[];y:(v:number)=>number;left:number;right:number;format?:NumberFormat;side?:'left'|'right'}){
  return <g>{ticks.map(t=><g key={t}>{side==='left'&&<line x1={left} x2={right} y1={y(t)} y2={y(t)} className="bi-grid"/>}
    <text x={side==='left'?left-6:right+6} y={y(t)+4} textAnchor={side==='left'?'end':'start'} className="bi-axis">{compactNumber(t,format)}</text></g>)}</g>
}
function axisWidth(ticks:number[],format?:NumberFormat){return Math.max(34,...ticks.map(t=>compactNumber(t,format).length*7+8))}

// ---------------------------------------------------------------------------
// Combo chart: the first measure(s) as bars, the rest as lines (optionally on a second axis)
// ---------------------------------------------------------------------------
export function ComboChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{limit:object.options.limit||100})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0];const {select,dimmed}=selector(props,dim)
  const bars=Math.max(0,Math.min(compiled.measures.length,object.options.comboBars??1))
  const blocked=guard(result);if(blocked)return blocked
  const rows=result.rows,W=size.width,H=size.height-28
  const barIdx=compiled.measures.map((_,i)=>i).filter(i=>i<bars),lineIdx=compiled.measures.map((_,i)=>i).filter(i=>i>=bars)
  const second=Boolean(object.options.secondaryAxis)&&barIdx.length>0&&lineIdx.length>0
  const vals=(idx:number[])=>rows.flatMap(row=>idx.map(i=>num(row[1+i]))).filter((v):v is number=>v!==null)
  const leftVals=second?vals(barIdx):vals([...barIdx,...lineIdx]),rightVals=second?vals(lineIdx):[]
  const ticks=niceTicks(Math.min(0,...leftVals),Math.max(0,...leftVals,1e-9),5),rticks=second?niceTicks(Math.min(0,...rightVals),Math.max(0,...rightVals,1e-9),5):[]
  const leftFormat=compiled.measures[barIdx[0]??0]?.format,rightFormat=compiled.measures[lineIdx[0]]?.format
  const left=axisWidth(ticks,leftFormat),right=W-(second?axisWidth(rticks,rightFormat):12),top=10,bottom=H-(rows.length>6?44:28)
  const y=linear(ticks[0],ticks[ticks.length-1],bottom,top),y2=second?linear(rticks[0],rticks[rticks.length-1],bottom,top):y
  const band=(right-left)/Math.max(1,rows.length),cx=(i:number)=>left+band*i+band/2
  const groupW=Math.min(24*barIdx.length+2*(barIdx.length-1),band*0.72),barW=barIdx.length?Math.max(2,(groupW-2*(barIdx.length-1))/barIdx.length):0
  const rotate=rows.length>6,step=Math.ceil(rows.length/Math.max(1,Math.floor((right-left)/70)))
  const color=(i:number)=>SERIES_COLORS[i%SERIES_COLORS.length]
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}
    footer={<Legend items={compiled.measures.map((m,i)=>({name:m.label+(second&&i>=bars?' (right axis)':''),color:color(i)}))}/>}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Combo chart'} onMouseLeave={()=>setTip(null)}>
      <ValueAxis ticks={ticks} y={y} left={left} right={right} format={leftFormat}/>
      {second&&<ValueAxis ticks={rticks} y={y2} left={left} right={right} format={rightFormat} side="right"/>}
      {rows.map((row,i)=>i%step===0&&<text key={i} transform={rotate?`translate(${cx(i)},${bottom+12}) rotate(-35)`:undefined} x={rotate?0:cx(i)} y={rotate?0:bottom+18} textAnchor={rotate?'end':'middle'} className="bi-axis bi-cat">{truncate(displayValue(row[0],dim.format),16)}</text>)}
      {rows.map((row,i)=><g key={i} className={`bi-hit ${dimmed(row[0])?'dimmed':''}`}>{barIdx.map((m,j)=>{const v=num(row[1+m])??0,a=y(Math.max(0,v)),b=y(Math.min(0,v))
        return <rect key={m} x={cx(i)-groupW/2+j*(barW+2)} y={a} width={barW} height={Math.max(0,b-a)} rx={3} fill={color(m)}/>})}</g>)}
      {lineIdx.map(m=>{const pts=rows.map((row,i)=>{const v=num(row[1+m]);return v===null?null:`${cx(i).toFixed(1)},${(second?y2:y)(v).toFixed(1)}`}).filter(Boolean)
        return <g key={m}><polyline points={pts.join(' ')} fill="none" stroke={color(m)} strokeWidth={2.5} strokeLinejoin="round"/>
          {rows.length<=40&&rows.map((row,i)=>{const v=num(row[1+m]);return v===null?null:<circle key={i} cx={cx(i)} cy={(second?y2:y)(v)} r={3.5} fill={color(m)} stroke="#fff" strokeWidth={1.5}/>})}</g>})}
      <line x1={left} x2={right} y1={y(Math.max(ticks[0],0))} y2={y(Math.max(ticks[0],0))} className="bi-baseline"/>
      {rows.map((row,i)=><rect key={i} x={left+band*i} y={top} width={band} height={bottom-top} fill="transparent" className="bi-hit-area"
        onClick={event=>select(row[0],event.ctrlKey||event.metaKey)}
        onMouseMove={event=>setTip(tipAt(event,displayValue(row[0],dim.format),compiled.measures.map((m,k)=>({color:color(k),label:m.label,value:fmt(num(row[1+k]),m.format)}))))}/>)}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Scatter plot: one point per dimension value; x, y and optional bubble size
// ---------------------------------------------------------------------------
export function ScatterChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:1,desc:true}],limit:object.options.limit||1000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0];const {select,dimmed}=selector(props,dim)
  const [mx,my,ms]=compiled.measures
  const blocked=guard(result);if(blocked)return blocked
  const points=result.rows.map(row=>({value:row[0],x:num(row[1]),y:num(row[2]),s:ms?num(row[3]):null})).filter(p=>p.x!==null&&p.y!==null) as {value:FieldValue;x:number;y:number;s:number|null}[]
  const W=size.width,H=size.height
  const xt=niceTicks(Math.min(...points.map(p=>p.x)),Math.max(...points.map(p=>p.x),1e-9),5),yt=niceTicks(Math.min(...points.map(p=>p.y)),Math.max(...points.map(p=>p.y),1e-9),5)
  const left=axisWidth(yt,my.format),bottom=H-40,top=10,right=W-14
  const x=linear(xt[0],xt[xt.length-1],left,right),y=linear(yt[0],yt[yt.length-1],bottom,top)
  const smax=Math.max(1e-9,...points.map(p=>Math.abs(p.s??0)))
  const radius=(s:number|null)=>ms?3+Math.sqrt(Math.abs(s??0)/smax)*17:5
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Scatter plot'} onMouseLeave={()=>setTip(null)}>
      <ValueAxis ticks={yt} y={y} left={left} right={right} format={my.format}/>
      {xt.map(t=><g key={t}><line x1={x(t)} x2={x(t)} y1={top} y2={bottom} className="bi-grid"/><text x={x(t)} y={bottom+16} textAnchor="middle" className="bi-axis">{compactNumber(t,mx.format)}</text></g>)}
      <text x={(left+right)/2} y={H-6} textAnchor="middle" className="bi-axis bi-axis-title">{mx.label}</text>
      <text transform={`translate(12,${(top+bottom)/2}) rotate(-90)`} textAnchor="middle" className="bi-axis bi-axis-title">{my.label}</text>
      {[...points].sort((a,b)=>radius(b.s)-radius(a.s)).map((p,i)=><circle key={i} cx={x(p.x)} cy={y(p.y)} r={radius(p.s)} fill={SERIES_COLORS[0]} fillOpacity={0.55} stroke={SERIES_COLORS[0]} strokeWidth={1}
        className={`bi-hit ${dimmed(p.value)?'dimmed':''}`} onClick={event=>select(p.value,event.ctrlKey||event.metaKey)}
        onMouseMove={event=>setTip(tipAt(event,displayValue(p.value,dim.format),[{label:mx.label,value:fmt(p.x,mx.format)},{label:my.label,value:fmt(p.y,my.format)},...(ms?[{label:ms.label,value:fmt(p.s,ms.format)}]:[])]))}/>)}
      {points.length<=25&&points.map((p,i)=><text key={i} x={x(p.x)+radius(p.s)+3} y={y(p.y)+4} className="bi-axis bi-point-label">{truncate(displayValue(p.value,dim.format),14)}</text>)}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Gauge: one value on a half-circle scale, with an optional target (second measure)
// ---------------------------------------------------------------------------
export function GaugeChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{limit:1})
  const [ref,size]=useSize<HTMLDivElement>()
  if(result.error)return <Message kind="error">{result.error}</Message>
  const [m,target]=compiled.measures
  const value=num(result.rows[0]?.[0]??null),goal=target?num(result.rows[0]?.[1]??null):null
  const lo=object.options.gaugeMin??0
  const hi=object.options.gaugeMax??niceTicks(0,Math.max(value??0,goal??0,1e-9)*1.1,4).slice(-1)[0]
  const W=size.width,H=size.height,R=Math.max(10,Math.min(W/2-10,H-34)),cx=W/2,cy=Math.min(H-24,R+12)
  const frac=(v:number)=>Math.max(0,Math.min(1,(v-lo)/((hi-lo)||1)))
  const pt=(f:number,r:number)=>[cx-r*Math.cos(Math.PI*f),cy-r*Math.sin(Math.PI*f)]
  const arc=(f0:number,f1:number,r:number,w:number)=>{const [x0,y0]=pt(f0,r),[x1,y1]=pt(Math.min(f1,0.9999),r),[x2,y2]=pt(Math.min(f1,0.9999),r-w),[x3,y3]=pt(f0,r-w),large=0
    return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r-w},${r-w} 0 ${large} 0 ${x3},${y3}Z`}
  const thickness=Math.max(10,R*0.22)
  const color=goal!==null&&value!==null?(value>=goal?'#1baf7a':'#eb6834'):SERIES_COLORS[0]
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot" ref={ref}>
    {W>60&&H>50&&<svg width={W} height={H} role="img" aria-label={object.title||'Gauge'}>
      <path d={arc(0,1,R,thickness)} fill="#e9eef2"/>
      {value!==null&&frac(value)>0&&<path d={arc(0,frac(value),R,thickness)} fill={color}/>}
      {goal!==null&&(()=>{const [a,b]=pt(frac(goal),R+4),[c,d]=pt(frac(goal),R-thickness-4);return <line x1={a} y1={b} x2={c} y2={d} stroke="#16324a" strokeWidth={3}/>})()}
      <text x={cx} y={cy-6} textAnchor="middle" className="bi-gauge-value" style={{fontSize:Math.max(14,Math.min(40,R*0.36))}}>{value===null?'—':compactNumber(value,m.format)}</text>
      <text x={pt(0,R-thickness/2)[0]} y={cy+16} textAnchor="middle" className="bi-axis">{compactNumber(lo,m.format)}</text>
      <text x={pt(1,R-thickness/2)[0]} y={cy+16} textAnchor="middle" className="bi-axis">{compactNumber(hi,m.format)}</text>
      <text x={cx} y={cy+16} textAnchor="middle" className="bi-axis">{goal!==null?`${target.label}: ${formatNumber(goal,target.format&&target.format!=='auto'?target.format:m.format)}`:m.label}</text>
    </svg>}</div></div>
}

// ---------------------------------------------------------------------------
// Bullet chart: value bar, target marker and a range, per dimension value (or one row)
// ---------------------------------------------------------------------------
export function BulletChart(props:Props){
  const {object,compiled}=props
  const dims=compiled.dimensions.length
  const result=useRows(props,{limit:dims?50:1})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0];const sel=dim?selector(props,dim):null
  const blocked=guard(result);if(blocked)return blocked
  const [mv,mt,mr]=compiled.measures
  const rows=result.rows.map(row=>({label:dims?displayValue(row[0],dim.format):mv.label,value:dims?row[0]:null,v:num(row[dims])??0,t:mt?num(row[dims+1]):null,r:mr?num(row[dims+2]):null}))
  const max=Math.max(1e-9,...rows.flatMap(r=>[r.v,r.t??0,r.r??0]))
  const ticks=niceTicks(Math.min(0,...rows.map(r=>r.v)),max,4)
  const W=size.width,labelW=dims?Math.min(140,Math.max(60,...rows.map(r=>r.label.length*6.5))):0
  const left=labelW+(dims?10:4),right=W-14,band=Math.max(26,Math.min(48,(size.height-20)/rows.length))
  const x=linear(ticks[0],ticks[ticks.length-1],left,right)
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>60&&<div className="bi-scroll" style={{height:size.height}}><svg width={W} height={rows.length*band+20} role="img" aria-label={object.title||'Bullet chart'} onMouseLeave={()=>setTip(null)}>
      {ticks.map(t=><g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={rows.length*band} className="bi-grid"/><text x={x(t)} y={rows.length*band+14} textAnchor="middle" className="bi-axis">{compactNumber(t,mv.format)}</text></g>)}
      {rows.map((row,i)=>{const y0=i*band,h=band*0.62,bh=h*0.42
        return <g key={i} className={`bi-hit ${sel&&sel.dimmed(row.value)?'dimmed':''}`} onClick={event=>sel?.select(row.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,row.label,[{label:mv.label,value:fmt(row.v,mv.format)},...(mt?[{label:mt.label,value:fmt(row.t,mt.format)}]:[]),...(mr?[{label:mr.label,value:fmt(row.r,mr.format)}]:[])]))}>
          {dims>0&&<text x={labelW} y={y0+band/2+4} textAnchor="end" className="bi-axis bi-cat">{truncate(row.label,Math.floor(labelW/6.5))}</text>}
          <rect x={x(0)} y={y0+(band-h)/2} width={Math.max(0,x(row.r??ticks[ticks.length-1])-x(0))} height={h} fill="#e9eef2" rx={3}/>
          <rect x={Math.min(x(0),x(row.v))} y={y0+(band-bh)/2} width={Math.abs(x(row.v)-x(0))} height={bh} fill={SERIES_COLORS[0]} rx={2}/>
          {row.t!==null&&<line x1={x(row.t)} x2={x(row.t)} y1={y0+(band-h)/2-2} y2={y0+(band+h)/2+2} stroke="#16324a" strokeWidth={3}/>}
        </g>})}
    </svg></div>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Funnel: stages sorted largest first, width proportional to value
// ---------------------------------------------------------------------------
export function FunnelChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:object.options.sortBy!=null?defaultSort(object,compiled):[{index:1,desc:true}],limit:20})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],m=compiled.measures[0];const {select,dimmed}=selector(props,dim)
  const blocked=guard(result);if(blocked)return blocked
  const rows=result.rows.map(row=>({value:row[0],v:Math.max(0,num(row[1])??0)}))
  const W=size.width,H=size.height,max=Math.max(1e-9,...rows.map(r=>r.v)),first=rows[0]?.v||0
  const step=(H-8)/Math.max(1,rows.length),cx=W/2,maxW=W*0.62
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>60&&H>40&&<svg width={W} height={H} role="img" aria-label={object.title||'Funnel chart'} onMouseLeave={()=>setTip(null)}>
      {rows.map((row,i)=>{const w0=maxW*row.v/max,w1=maxW*(rows[i+1]?.v??row.v*0.85)/max,y0=4+i*step,y1=y0+step-3
        return <g key={i} className={`bi-hit ${dimmed(row.value)?'dimmed':''}`} onClick={event=>select(row.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,displayValue(row.value,dim.format),[{label:m.label,value:fmt(row.v,m.format)},{label:'Of first stage',value:fmt(first?row.v/first:null,'percent')}]))}>
          <path d={`M${cx-w0/2},${y0}L${cx+w0/2},${y0}L${cx+w1/2},${y1}L${cx-w1/2},${y1}Z`} fill={SERIES_COLORS[i%SERIES_COLORS.length]}/>
          <text x={cx+maxW/2+8} y={(y0+y1)/2+4} className="bi-axis bi-cat">{truncate(displayValue(row.value,dim.format),18)}</text>
          {step>18&&<text x={cx} y={(y0+y1)/2+4} textAnchor="middle" className="bi-bar-label">{compactNumber(row.v,m.format)}</text>}
        </g>})}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Waterfall: each value moves a running total; a total bar at the end
// ---------------------------------------------------------------------------
export function WaterfallChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:object.options.sortBy!=null?defaultSort(object,compiled):[{index:0,desc:false}],limit:60})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],m=compiled.measures[0];const {select,dimmed}=selector(props,dim)
  const blocked=guard(result);if(blocked)return blocked
  let run=0
  const steps=result.rows.map(row=>{const v=num(row[1])??0,start=run;run+=v;return {value:row[0] as FieldValue,label:displayValue(row[0],dim.format),start,end:run,v,total:false}})
  steps.push({value:null,label:'Total',start:0,end:run,v:run,total:true})
  const W=size.width,H=size.height
  const ticks=niceTicks(Math.min(0,...steps.map(s=>Math.min(s.start,s.end))),Math.max(1e-9,...steps.map(s=>Math.max(s.start,s.end))),5)
  const left=axisWidth(ticks,m.format),right=W-10,top=10,bottom=H-(steps.length>6?44:28)
  const y=linear(ticks[0],ticks[ticks.length-1],bottom,top),band=(right-left)/steps.length,bw=Math.min(40,band*0.7)
  const rotate=steps.length>6
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Waterfall chart'} onMouseLeave={()=>setTip(null)}>
      <ValueAxis ticks={ticks} y={y} left={left} right={right} format={m.format}/>
      {steps.map((s,i)=>{const cx=left+band*i+band/2,a=y(Math.max(s.start,s.end)),b=y(Math.min(s.start,s.end))
        return <g key={i} className={`bi-hit ${!s.total&&dimmed(s.value)?'dimmed':''}`} onClick={event=>!s.total&&select(s.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,s.label,[{label:s.total?'Total':m.label,value:fmt(s.v,m.format)},...(s.total?[]:[{label:'Running total',value:fmt(s.end,m.format)}])]))}>
          <rect x={cx-bw/2} y={a} width={bw} height={Math.max(1,b-a)} rx={2} fill={s.total?'#2a78d6':s.v>=0?'#1baf7a':'#e34948'}/>
          {i<steps.length-1&&<line x1={cx+bw/2} x2={cx+band-bw/2} y1={y(s.end)} y2={y(s.end)} stroke="#9aa7b2" strokeDasharray="3 2"/>}
          <text transform={rotate?`translate(${cx},${bottom+12}) rotate(-35)`:undefined} x={rotate?0:cx} y={rotate?0:bottom+18} textAnchor={rotate?'end':'middle'} className="bi-axis bi-cat">{truncate(s.label,16)}</text>
        </g>})}
      <line x1={left} x2={right} y1={y(0)} y2={y(0)} className="bi-baseline"/>
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Treemap: rectangles sized by value (squarified); a second dimension nests inside the first
// ---------------------------------------------------------------------------
export function TreemapChart(props:Props){
  const {object,compiled}=props
  const two=compiled.dimensions.length>1
  const result=useRows(props,{sort:[{index:compiled.dimensions.length,desc:true}],limit:two?2000:300})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],inner=compiled.dimensions[1],m=compiled.measures[0];const outer=selector(props,dim);const innerSel=inner?selector(props,inner):null
  const blocked=guard(result);if(blocked)return blocked
  const W=size.width,H=size.height
  const groups=new Map<string,{value:FieldValue;v:number;children:{value:FieldValue;v:number}[]}>()
  for(const row of result.rows){const key=JSON.stringify(row[0]);const v=Math.max(0,num(row[two?2:1])??0)
    if(!groups.has(key))groups.set(key,{value:row[0],v:0,children:[]});const g=groups.get(key)!;g.v+=v;if(two)g.children.push({value:row[1],v})}
  const tiles=squarify([...groups.values()],{x:0,y:0,w:W,h:H})
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>40&&H>40&&<svg width={W} height={H} role="img" aria-label={object.title||'Treemap'} onMouseLeave={()=>setTip(null)}>
      {tiles.map((tile,i)=>{const color=SERIES_COLORS[i%SERIES_COLORS.length];const label=displayValue(tile.value,dim.format)
        const kids=two?squarify(tile.children,{x:tile.x+2,y:tile.y+18,w:Math.max(0,tile.w-4),h:Math.max(0,tile.h-20)}):[]
        return <g key={i} className={outer.dimmed(tile.value)?'dimmed':''}>
          <rect x={tile.x+1} y={tile.y+1} width={Math.max(0,tile.w-2)} height={Math.max(0,tile.h-2)} fill={color} fillOpacity={two?0.35:0.9} rx={3} className="bi-hit"
            onClick={event=>outer.select(tile.value,event.ctrlKey||event.metaKey)}
            onMouseMove={event=>setTip(tipAt(event,label,[{label:m.label,value:fmt(tile.v,m.format)}]))}/>
          {kids.map((kid,k)=><rect key={k} x={kid.x+1} y={kid.y+1} width={Math.max(0,kid.w-2)} height={Math.max(0,kid.h-2)} fill={color} rx={2}
            className={`bi-hit ${innerSel?.dimmed(kid.value)?'dimmed':''}`} onClick={event=>{event.stopPropagation();innerSel?.select(kid.value,event.ctrlKey||event.metaKey)}}
            onMouseMove={event=>setTip(tipAt(event,`${label} · ${displayValue(kid.value,inner.format)}`,[{label:m.label,value:fmt(kid.v,m.format)}]))}/>)}
          {two&&kids.map((kid,k)=>kid.w>50&&kid.h>18&&<text key={k} x={kid.x+6} y={kid.y+15} className="bi-tile-label" pointerEvents="none">{truncate(displayValue(kid.value,inner.format),Math.floor(kid.w/7))}</text>)}
          {tile.w>40&&tile.h>16&&<text x={tile.x+6} y={tile.y+14} className={two?'bi-tile-group':'bi-tile-label'} pointerEvents="none">{truncate(label,Math.floor(tile.w/7))}</text>}
          {!two&&tile.w>50&&tile.h>34&&<text x={tile.x+6} y={tile.y+30} className="bi-tile-value" pointerEvents="none">{compactNumber(tile.v,m.format)}</text>}
        </g>})}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Histogram: how many records fall in each range of a numeric field
// ---------------------------------------------------------------------------
export function HistogramChart(props:Props){
  const {object,compiled}=props
  const dim=compiled.dimensions[0]
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:10000,measures:[{expr:{t:'fn',name:'count',args:[dim.node]}}]})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const {select,selected}=selector(props,dim)
  const bins=useMemo(()=>histogramBins(result.rows.map(row=>({v:num(row[0]),n:num(row[1])??0})).filter((p):p is {v:number;n:number}=>p.v!==null),object.options.bins),[result.rows,object.options.bins])
  const blocked=guard(result);if(blocked)return blocked
  const W=size.width,H=size.height
  const ticks=niceTicks(0,Math.max(1,...bins.map(b=>b.n)),4),left=axisWidth(ticks,'integer'),right=W-10,top=10,bottom=H-32
  const y=linear(0,ticks[ticks.length-1],bottom,top),band=(right-left)/Math.max(1,bins.length)
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W} footer={result.has_more?<small className="bi-note">Using the first 10,000 values</small>:null}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Histogram'} onMouseLeave={()=>setTip(null)}>
      <ValueAxis ticks={ticks} y={y} left={left} right={right} format="integer"/>
      {bins.map((bin,i)=>{const sel=selected.length>0&&bin.values.some(v=>selected.some(s=>sameValue(s,v)))
        return <g key={i} className={`bi-hit ${selected.length&&!sel?'dimmed':''}`} onClick={event=>{if(bin.values.length)for(const [k,v] of bin.values.entries())select(v,k>0||event.ctrlKey||event.metaKey)}}
          onMouseMove={event=>setTip(tipAt(event,`${compactNumber(bin.from,dim.format)} – ${compactNumber(bin.to,dim.format)}`,[{label:'Count',value:formatNumber(bin.n,'integer')}]))}>
          <rect x={left+band*i+1} y={y(bin.n)} width={Math.max(1,band-2)} height={Math.max(0,bottom-y(bin.n))} fill={SERIES_COLORS[0]}/>
          {(i%Math.ceil(bins.length/Math.max(1,Math.floor((right-left)/60)))===0)&&<text x={left+band*i} y={bottom+16} textAnchor="middle" className="bi-axis">{compactNumber(bin.from,dim.format)}</text>}
        </g>})}
      <text x={(left+right)/2} y={H-2} textAnchor="middle" className="bi-axis bi-axis-title">{dim.label}</text>
      <line x1={left} x2={right} y1={bottom} y2={bottom} className="bi-baseline"/>
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Box plot and distribution plot: the spread of a measure over the values of an inner dimension,
// one box/column per value of the first dimension (or one for everything with a single dimension)
// ---------------------------------------------------------------------------
export function SpreadChart(props:Props&{mode:'box'|'distribution'}){
  const {object,compiled,mode}=props
  const two=compiled.dimensions.length>1
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:5000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const outerDim=two?compiled.dimensions[0]:null,innerDim=compiled.dimensions[two?1:0],m=compiled.measures[0]
  const outer=outerDim?selector(props,outerDim):null,inner=selector(props,innerDim)
  const groups=useMemo(()=>{
    const map=new Map<string,{value:FieldValue;points:{value:FieldValue;v:number}[]}>()
    for(const row of result.rows){const v=num(row[two?2:1]);if(v===null)continue;const key=two?JSON.stringify(row[0]):'all'
      if(!map.has(key))map.set(key,{value:two?row[0]:null,points:[]});map.get(key)!.points.push({value:row[two?1:0],v})}
    return [...map.values()].sort((a,b)=>compareValues(a.value,b.value)).slice(0,40)
  },[result.rows,two])
  const blocked=guard(result);if(blocked)return blocked
  const all=groups.flatMap(g=>g.points.map(p=>p.v))
  const W=size.width,H=size.height
  const ticks=niceTicks(Math.min(...all),Math.max(...all,1e-9),5),left=axisWidth(ticks,m.format),right=W-10,top=10,bottom=H-(groups.length>6?44:28)
  const y=linear(ticks[0],ticks[ticks.length-1],bottom,top),band=(right-left)/Math.max(1,groups.length),bw=Math.min(46,band*0.5)
  const rotate=groups.length>6
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W} footer={result.has_more?<small className="bi-note">Using the first 5,000 values</small>:null}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||(mode==='box'?'Box plot':'Distribution plot')} onMouseLeave={()=>setTip(null)}>
      <ValueAxis ticks={ticks} y={y} left={left} right={right} format={m.format}/>
      {groups.map((g,i)=>{const cx=left+band*i+band/2,st=quartiles(g.points.map(p=>p.v)),label=outerDim?displayValue(g.value,outerDim.format):m.label,color=SERIES_COLORS[i%SERIES_COLORS.length]
        const lines=[{label:'Values',value:formatNumber(st.count,'integer')},{label:'Median',value:fmt(st.median,m.format)},{label:'Quartiles',value:`${fmt(st.q1,m.format)} – ${fmt(st.q3,m.format)}`},{label:'Whiskers',value:`${fmt(st.low,m.format)} – ${fmt(st.high,m.format)}`}]
        return <g key={i} className={outer&&outer.dimmed(g.value)?'dimmed':''}>
          <rect x={left+band*i} y={top} width={band} height={bottom-top} fill="transparent" className="bi-hit-area" onClick={event=>outer?.select(g.value,event.ctrlKey||event.metaKey)} onMouseMove={event=>setTip(tipAt(event,label,lines))}/>
          {mode==='box'?<>
            <line x1={cx} x2={cx} y1={y(st.high)} y2={y(st.q3)} stroke="#526170"/><line x1={cx} x2={cx} y1={y(st.q1)} y2={y(st.low)} stroke="#526170"/>
            <line x1={cx-bw/4} x2={cx+bw/4} y1={y(st.high)} y2={y(st.high)} stroke="#526170"/><line x1={cx-bw/4} x2={cx+bw/4} y1={y(st.low)} y2={y(st.low)} stroke="#526170"/>
            <rect x={cx-bw/2} y={y(st.q3)} width={bw} height={Math.max(1,y(st.q1)-y(st.q3))} fill={color} fillOpacity={0.35} stroke={color} pointerEvents="none"/>
            <line x1={cx-bw/2} x2={cx+bw/2} y1={y(st.median)} y2={y(st.median)} stroke={color} strokeWidth={3} pointerEvents="none"/>
            {st.outliers.slice(0,200).map((v,k)=><circle key={k} cx={cx} cy={y(v)} r={2.5} fill="none" stroke={color} pointerEvents="none"/>)}
          </>:<>
            {g.points.slice(0,800).map((p,k)=><circle key={k} cx={cx+((k*37)%100/100-0.5)*Math.min(band*0.6,60)} cy={y(p.v)} r={3} fill={color} fillOpacity={0.5}
              className={`bi-hit ${inner.dimmed(p.value)?'dimmed':''}`} onClick={event=>{event.stopPropagation();inner.select(p.value,event.ctrlKey||event.metaKey)}}
              onMouseMove={event=>{event.stopPropagation();setTip(tipAt(event,displayValue(p.value,innerDim.format),[{label:m.label,value:fmt(p.v,m.format)}]))}}/>)}
            <line x1={cx-Math.min(band*0.35,36)} x2={cx+Math.min(band*0.35,36)} y1={y(st.median)} y2={y(st.median)} stroke="#16324a" strokeWidth={2} pointerEvents="none"/>
          </>}
          <text transform={rotate?`translate(${cx},${bottom+12}) rotate(-35)`:undefined} x={rotate?0:cx} y={rotate?0:bottom+18} textAnchor={rotate?'end':'middle'} className="bi-axis bi-cat">{truncate(label,16)}</text>
        </g>})}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Radar: one axis per value of the first dimension; one shape per measure or per second-dimension value
// ---------------------------------------------------------------------------
export function RadarChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:0,desc:false}],limit:compiled.dimensions.length>1?1000:30})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0];const {select,dimmed}=selector(props,dim)
  const data=useMemo(()=>toSeries(result.rows,compiled.dimensions.length,compiled.measures.map(m=>m.label)),[result.rows,compiled])
  const blocked=guard(result);if(blocked)return blocked
  const cats=data.categories.slice(0,24),n=cats.length
  const W=size.width,H=size.height-28,R=Math.max(10,Math.min(W,H)/2-34),cx=W/2,cy=H/2+4
  const max=Math.max(1e-9,...data.series.flatMap(s=>s.values.slice(0,n).map(v=>v??0)))
  const ticks=niceTicks(0,max,4),top=ticks[ticks.length-1]
  const pt=(i:number,v:number)=>{const a=-Math.PI/2+i*2*Math.PI/Math.max(n,1),r=R*Math.max(0,v)/top;return [cx+r*Math.cos(a),cy+r*Math.sin(a)] as const}
  const format=compiled.measures[0]?.format
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W} footer={<Legend items={data.series.map(s=>({name:s.name,color:s.color}))}/>}>
    {W>60&&H>60&&n>=3?<svg width={W} height={H} role="img" aria-label={object.title||'Radar chart'} onMouseLeave={()=>setTip(null)}>
      {ticks.slice(1).map(t=><polygon key={t} points={cats.map((_,i)=>pt(i,t).join(',')).join(' ')} fill="none" className="bi-grid"/>)}
      {ticks.slice(1).map(t=><text key={t} x={cx+3} y={pt(0,t)[1]-2} className="bi-axis">{compactNumber(t,format)}</text>)}
      {cats.map((c,i)=>{const [x,y]=pt(i,top),[lx,ly]=pt(i,top*1.13)
        return <g key={i} className={`bi-hit ${dimmed(c)?'dimmed':''}`} onClick={event=>select(c,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>setTip(tipAt(event,displayValue(c,dim.format),data.series.map(s=>({color:s.color,label:s.name,value:fmt(s.values[i],format)}))))}>
          <line x1={cx} y1={cy} x2={x} y2={y} className="bi-grid"/>
          <text x={lx} y={ly+4} textAnchor={Math.abs(lx-cx)<8?'middle':lx>cx?'start':'end'} className="bi-axis bi-cat">{truncate(displayValue(c,dim.format),14)}</text></g>})}
      {data.series.map(s=><polygon key={s.name} points={cats.map((_,i)=>pt(i,s.values[i]??0).join(',')).join(' ')} fill={s.color} fillOpacity={0.18} stroke={s.color} strokeWidth={2} pointerEvents="none"/>)}
    </svg>:<Message kind="empty">A radar chart needs at least 3 values of {dim.label}</Message>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Mekko: column width = total of the first dimension; segments = share of the second dimension
// ---------------------------------------------------------------------------
export function MekkoChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:2,desc:true}],limit:2000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const [d1,d2]=compiled.dimensions,m=compiled.measures[0];const s1=selector(props,d1),s2=selector(props,d2)
  const data=useMemo(()=>toSeries(result.rows,2,[m.label]),[result.rows,m.label])
  const raw=useMemo(()=>new Map(result.rows.map(r=>[displayValue(r[1]),r[1]] as [string,FieldValue])),[result.rows])
  const blocked=guard(result);if(blocked)return blocked
  const totals=data.categories.map((_,i)=>data.series.reduce((s,ser)=>s+Math.max(0,ser.values[i]??0),0))
  const order=data.categories.map((_,i)=>i).sort((a,b)=>totals[b]-totals[a]).slice(0,30)
  const grand=order.reduce((s,i)=>s+totals[i],0)||1
  const W=size.width,H=size.height-28,left=40,right=W-6,top=6,bottom=H-24
  let x=left
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}
    footer={<Legend items={data.series.map(ser=>({name:ser.name,color:ser.color,value:raw.has(ser.name)?raw.get(ser.name)!:ser.name}))} selected={s2.selected} onClick={(value,additive)=>s2.select(value,additive)}/>}>
    {W>60&&H>60&&<svg width={W} height={H} role="img" aria-label={object.title||'Mekko chart'} onMouseLeave={()=>setTip(null)}>
      {[0,0.25,0.5,0.75,1].map(t=><text key={t} x={left-6} y={bottom-(bottom-top)*t+4} textAnchor="end" className="bi-axis">{Math.round(t*100)}%</text>)}
      {order.map(i=>{const w=(right-left)*totals[i]/grand,x0=x;x+=w;let yy=bottom;const cat=data.categories[i]
        return <g key={i} className={s1.dimmed(cat)?'dimmed':''}>
          {data.series.map(ser=>{const v=Math.max(0,ser.values[i]??0);if(!v||!totals[i])return null;const h=(bottom-top)*v/totals[i];yy-=h
            return <rect key={ser.name} x={x0+1} y={yy} width={Math.max(0,w-2)} height={Math.max(0,h-1)} fill={ser.color} className="bi-hit"
              onClick={event=>ser.name!=='Other'&&s2.select(raw.has(ser.name)?raw.get(ser.name)!:ser.name,event.ctrlKey||event.metaKey)}
              onMouseMove={event=>setTip(tipAt(event,`${displayValue(cat,d1.format)} · ${ser.name}`,[{label:m.label,value:fmt(v,m.format)},{label:`Share of ${displayValue(cat,d1.format)}`,value:fmt(v/totals[i],'percent')}]))}/>})}
          {w>30&&<text x={x0+w/2} y={bottom+15} textAnchor="middle" className="bi-axis bi-cat bi-hit" onClick={event=>s1.select(cat,event.ctrlKey||event.metaKey)}>{truncate(displayValue(cat,d1.format),Math.floor(w/7))}</text>}
        </g>})}
    </svg>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Grid chart (heat map): first dimension down, second across, colour = value
// ---------------------------------------------------------------------------
export function GridChart(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:0,desc:false},{index:1,desc:false}],limit:3000})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const [d1,d2]=compiled.dimensions,m=compiled.measures[0];const s1=selector(props,d1),s2=selector(props,d2)
  const blocked=guard(result);if(blocked)return blocked
  const rowsK:FieldValue[]=[],colsK:FieldValue[]=[],cells=new Map<string,number|null>()
  for(const r of result.rows){if(!rowsK.some(v=>sameValue(v,r[0])))rowsK.push(r[0]);if(!colsK.some(v=>sameValue(v,r[1])))colsK.push(r[1]);cells.set(JSON.stringify([r[0],r[1]]),num(r[2]))}
  colsK.sort(compareValues)
  const vals=[...cells.values()].filter((v):v is number=>v!==null),lo=Math.min(...vals),hi=Math.max(...vals)
  const W=size.width,H=size.height,labelW=Math.min(140,Math.max(50,...rowsK.map(v=>displayValue(v,d1.format).length*6.5))),top=22
  const cw=Math.max(18,(W-labelW-8)/Math.max(1,colsK.length)),ch=Math.max(18,Math.min(34,(H-top-4)/Math.max(1,rowsK.length)))
  const shade=(v:number)=>{const t=hi===lo?1:(v-lo)/(hi-lo);const a=[238,244,251],b=[29,79,122];return `rgb(${a.map((c,i)=>Math.round(c+(b[i]-c)*t)).join(',')})`}
  return <Frame loading={result.loading} plotRef={ref} tip={tip} width={W}>
    {W>60&&<div className="bi-scroll" style={{height:H}}><svg width={Math.max(W,labelW+8+cw*colsK.length)} height={top+ch*rowsK.length+4} role="img" aria-label={object.title||'Grid chart'} onMouseLeave={()=>setTip(null)}>
      {colsK.map((c,j)=><text key={j} x={labelW+8+cw*j+cw/2} y={14} textAnchor="middle" className={`bi-axis bi-cat bi-hit ${s2.dimmed(c)?'dimmed':''}`} onClick={event=>s2.select(c,event.ctrlKey||event.metaKey)}>{truncate(displayValue(c,d2.format),Math.max(2,Math.floor(cw/7)))}</text>)}
      {rowsK.map((r,i)=><g key={i}>
        <text x={labelW} y={top+ch*i+ch/2+4} textAnchor="end" className={`bi-axis bi-cat bi-hit ${s1.dimmed(r)?'dimmed':''}`} onClick={event=>s1.select(r,event.ctrlKey||event.metaKey)}>{truncate(displayValue(r,d1.format),Math.floor(labelW/6.5))}</text>
        {colsK.map((c,j)=>{const v=cells.get(JSON.stringify([r,c]));if(v===undefined||v===null)return <rect key={j} x={labelW+8+cw*j+1} y={top+ch*i+1} width={cw-2} height={ch-2} fill="#f6f8fa" rx={2}/>
          return <g key={j} className={`bi-hit ${s1.dimmed(r)||s2.dimmed(c)?'dimmed':''}`} onClick={event=>s1.select(r,event.ctrlKey||event.metaKey)}
            onMouseMove={event=>setTip(tipAt(event,`${displayValue(r,d1.format)} · ${displayValue(c,d2.format)}`,[{label:m.label,value:fmt(v,m.format)}]))}>
            <rect x={labelW+8+cw*j+1} y={top+ch*i+1} width={cw-2} height={ch-2} fill={shade(v)} rx={2}/>
            {cw>44&&ch>16&&<text x={labelW+8+cw*j+cw/2} y={top+ch*i+ch/2+4} textAnchor="middle" className="bi-grid-label" fill={(hi===lo?1:(v-lo)/(hi-lo))>0.55?'#fff':'#16324a'}>{compactNumber(v,m.format)}</text>}
          </g>})}
      </g>)}
    </svg></div>}
  </Frame>
}

// ---------------------------------------------------------------------------
// Word cloud: words sized by value
// ---------------------------------------------------------------------------
export function WordCloud(props:Props){
  const {object,compiled}=props
  const result=useRows(props,{sort:[{index:1,desc:true}],limit:object.options.limit||80})
  const [ref,size]=useSize<HTMLDivElement>();const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],m=compiled.measures[0];const {select,dimmed}=selector(props,dim)
  const blocked=guard(result);if(blocked)return blocked
  const words=result.rows.map(row=>({value:row[0],v:num(row[1])??0})).filter(w=>w.v>0)
  const max=Math.max(1e-9,...words.map(w=>w.v)),min=Math.min(...words.map(w=>w.v))
  const font=(v:number)=>Math.round(11+(Math.sqrt(v)-Math.sqrt(min))/((Math.sqrt(max)-Math.sqrt(min))||1)*Math.max(10,Math.min(40,size.height/6)))
  // alternate large and small words so the cloud is mixed rather than sorted
  const mixed=words.map((w,i)=>({...w,i})).sort((a,b)=>((a.i*7919)%97)-((b.i*7919)%97))
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}><div className="bi-plot bi-wordcloud" ref={ref} onMouseLeave={()=>setTip(null)}>
    {mixed.map(w=><button key={w.i} type="button" className={`bi-word ${dimmed(w.value)?'dimmed':''}`} style={{fontSize:font(w.v),color:SERIES_COLORS[w.i%SERIES_COLORS.length]}}
      onClick={event=>select(w.value,event.ctrlKey||event.metaKey)}
      onMouseMove={event=>setTip(tipAt(event,displayValue(w.value,dim.format),[{label:m.label,value:fmt(w.v,m.format)}]))}>{displayValue(w.value,dim.format)}</button>)}
    <Tooltip tip={tip} width={size.width}/></div></div>
}

export type {Selection}
