import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react'
import {ChevronDown,ChevronUp,Download,Search,X} from 'lucide-react'
import {supabase} from './supabase'
import {BulletChart,ComboChart,FunnelChart,GaugeChart,GridChart,HistogramChart,MekkoChart,RadarChart,ScatterChart,SpreadChart,TreemapChart,WaterfallChart,WordCloud} from './biChartsMore'
import {ButtonObject,DatePicker,DividerObject,ImageObject,LayoutContainer,NavigationMenu,SliderObject,TabContainer,TextImageObject,TrellisContainer,VariableInput,VideoObject} from './biControls'
import {type ExprNode} from './biExpression'
import {Legend,Message,Tooltip,selectedValues,truncate,useQuery,useSize,type Compiled,type ObjectProps,type SelectFn,type Tip} from './biChartKit'
import {
  SERIES_COLORS,buildSpec,cellStyle,columnOrder,contrastText,safeColor,compactNumber,compareValues,compileObject,defaultSort,displayValue,formatNumber,niceTicks,
  runQuery,sameValue,toCsv,toNumber,toPivot,toSeries,
  type AppDetail,type CompiledObject,type FieldValue,type NumberFormat,type Selection,type SheetObject,
} from './biApps'

// ---------------------------------------------------------------------------
// The object frame and dispatcher
// ---------------------------------------------------------------------------
export type {SelectFn}

export function ObjectBody(props:ObjectProps&{extraConditions?:ExprNode[]}){
  const {object,app}=props
  const extraKey=JSON.stringify(props.extraConditions||[])
  const extraConditions=useMemo(()=>props.extraConditions||[],[extraKey])// eslint-disable-line react-hooks/exhaustive-deps
  const compiled=useMemo(()=>compileObject(object,app,extraConditions),[object,app,extraConditions])
  const renderChild=(child:SheetObject,extra?:ExprNode[])=><ObjectBody {...props} object={child} extraConditions={[...extraConditions,...(extra||[])]}/>
  switch(object.kind){
    case 'text':return <TextObject object={object}/>
    case 'variable':return <VariableInput {...props}/>
    case 'slider':return <SliderObject {...props}/>
    case 'navigation':return <NavigationMenu {...props}/>
    case 'image':return <ImageObject {...props}/>
    case 'textimage':return <TextImageObject {...props}/>
    case 'divider':return <DividerObject {...props}/>
    case 'video':return <VideoObject {...props}/>
    case 'tabs':return <TabContainer {...props} compiled={compiled} renderChild={renderChild}/>
    case 'layout':return <LayoutContainer {...props} compiled={compiled} renderChild={renderChild}/>
    case 'button':return compiled.errors.length&&object.options.action==='select'?<Message kind="error">{compiled.errors[0]}</Message>:<ButtonObject {...props} selectTarget={compiled.dimensions[0]||null}/>
  }
  if(compiled.errors.length)return <Message kind="error">{compiled.errors[0]}</Message>
  switch(object.kind){
    case 'datepicker':return <DatePicker {...props} compiled={compiled}/>
    case 'trellis':return <TrellisContainer {...props} compiled={compiled} renderChild={renderChild}/>
    case 'kpi':return <KpiObject {...props} compiled={compiled}/>
    case 'bar':case 'line':return <XYChart {...props} compiled={compiled}/>
    case 'pie':return <PieObject {...props} compiled={compiled}/>
    case 'table':return <TableObject {...props} compiled={compiled}/>
    case 'pivot':return <PivotObject {...props} compiled={compiled}/>
    case 'filter':return <FilterPane {...props} compiled={compiled}/>
    case 'combo':return <ComboChart {...props} compiled={compiled}/>
    case 'scatter':return <ScatterChart {...props} compiled={compiled}/>
    case 'gauge':return <GaugeChart {...props} compiled={compiled}/>
    case 'bullet':return <BulletChart {...props} compiled={compiled}/>
    case 'funnel':return <FunnelChart {...props} compiled={compiled}/>
    case 'waterfall':return <WaterfallChart {...props} compiled={compiled}/>
    case 'treemap':return <TreemapChart {...props} compiled={compiled}/>
    case 'histogram':return <HistogramChart {...props} compiled={compiled}/>
    case 'boxplot':return <SpreadChart {...props} compiled={compiled} mode="box"/>
    case 'distribution':return <SpreadChart {...props} compiled={compiled} mode="distribution"/>
    case 'radar':return <RadarChart {...props} compiled={compiled}/>
    case 'mekko':return <MekkoChart {...props} compiled={compiled}/>
    case 'grid':return <GridChart {...props} compiled={compiled}/>
    case 'wordcloud':return <WordCloud {...props} compiled={compiled}/>
  }
}


function TextObject({object}:{object:SheetObject}){
  const text=object.options.text||''
  return <div className="bi-text">{text.split(/\n{2,}/).map((block,i)=><p key={i}>{block.split('\n').map((line,j)=><span key={j}>{j>0&&<br/>}{line}</span>)}</p>)}{!text&&!object.title&&<p className="bi-muted">Empty text object</p>}</div>
}

// ---------------------------------------------------------------------------
// KPI
// ---------------------------------------------------------------------------
function KpiObject({object,app,selections,dataVersion,compiled}:ObjectProps&Compiled){
  const spec=useMemo(()=>buildSpec(compiled,selections,{limit:1}),[compiled,selections])
  const result=useQuery(app.id,spec,dataVersion)
  if(result.error)return <Message kind="error">{result.error}</Message>
  const row=result.rows[0]||[]
  const [main,second]=compiled.measures
  const value=toNumber(row[0]??null);const other=second?toNumber(row[1]??null):null
  return <div className={`bi-kpi ${result.loading?'is-loading':''}`}>
    <strong title={formatNumber(value,main.format||'number')}>{value===null?'—':formatNumber(value,main.format).length>9?compactNumber(value,main.format):formatNumber(value,main.format)}</strong>
    {main.label.toLowerCase()!==object.title.trim().toLowerCase()&&<span>{main.label}</span>}
    {second&&<small>{second.label}: <b>{formatNumber(other,second.format)}</b></small>}
  </div>
}

// ---------------------------------------------------------------------------
// Bar and line charts
// ---------------------------------------------------------------------------
function XYChart({object,app,selections,onSelect,dataVersion,compiled}:ObjectProps&Compiled){
  const isLine=object.kind==='line'
  const limit=object.options.limit||(isLine?500:100)
  const spec=useMemo(()=>buildSpec(compiled,selections,{sort:defaultSort(object,compiled),limit:compiled.dimensions.length>1?2000:limit}),[compiled,selections,object,limit])
  const result=useQuery(app.id,spec,dataVersion)
  const [ref,size]=useSize<HTMLDivElement>()
  const [tip,setTip]=useState<Tip|null>(null)
  const [hover,setHover]=useState<number|null>(null)
  const stableOrder=useRef<string[]>([])
  const data=useMemo(()=>{
    const shaped=toSeries(result.rows,compiled.dimensions.length,compiled.measures.map(m=>m.label),stableOrder.current)
    if(compiled.dimensions.length>1)stableOrder.current=Array.from(new Set([...stableOrder.current,...shaped.series.map(s=>s.name)]))
    if(isLine&&compiled.dimensions.length>1){const order=shaped.categories.map((value,i)=>({value,i})).sort((a,b)=>compareValues(a.value,b.value));return {categories:order.map(o=>o.value),series:shaped.series.map(s=>({...s,values:order.map(o=>s.values[o.i])}))}}
    return shaped
  },[result.rows,compiled,isLine])
  const dim=compiled.dimensions[0];const format=compiled.measures[0]?.format
  const selected=selectedValues(selections,dim.selectKey)
  const splitDim=compiled.dimensions[1]
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!result.loading&&!result.rows.length)return <Message kind="empty">No data for the current selections</Message>

  const horizontal=!isLine&&(object.options.horizontal||data.categories.length>14)
  const stacked=Boolean(object.options.stacked)&&data.series.length>1
  const legendItems=data.series.map(s=>({name:s.name,color:s.color}))
  const legendHeight=data.series.length>1?28:0
  const W=size.width,H=Math.max(0,size.height-legendHeight)
  const values=data.series.flatMap(s=>s.values.filter((v):v is number=>v!==null))
  const stackTotals=stacked?data.categories.map((_,i)=>data.series.reduce((sum,s)=>sum+Math.max(0,s.values[i]||0),0)):[]
  const minV=Math.min(0,...values),maxV=Math.max(0,...(stacked?stackTotals:values),1e-9)
  const ticks=niceTicks(minV,maxV,horizontal?4:5)
  const lo=ticks[0],hi=ticks[ticks.length-1]
  const labelText=(value:FieldValue)=>displayValue(value,dim.format)
  const select=(value:FieldValue,additive:boolean)=>onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,additive)
  const isSelected=(value:FieldValue)=>selected.some(item=>sameValue(item,value))
  const dimmed=(value:FieldValue)=>selected.length>0&&!isSelected(value)

  let chart:ReactNode=null
  if(W>40&&H>40&&data.categories.length){
    if(horizontal){
      const labelW=Math.min(160,Math.max(60,...data.categories.map(c=>labelText(c).length*6.5)))
      const band=Math.max(22,Math.min(40,(H-24)/data.categories.length))
      const plotH=band*data.categories.length;const left=labelW+8,right=W-12
      const x=(v:number)=>left+(v-lo)/(hi-lo||1)*(right-left)
      const groupH=Math.min(24,band-8);const barH=stacked?groupH:Math.max(3,groupH/data.series.length)
      chart=<div className="bi-scroll" style={{height:H}}><svg width={W} height={plotH+24} role="img" aria-label={object.title||'Bar chart'}>
        {ticks.map(t=><g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={plotH} className="bi-grid"/><text x={x(t)} y={plotH+16} textAnchor="middle" className="bi-axis">{compactNumber(t,format)}</text></g>)}
        {data.categories.map((category,i)=>{const y0=i*band+(band-groupH)/2;let acc=0
          return <g key={i} className={`bi-hit ${dimmed(category)?'dimmed':''}`} onClick={event=>select(category,event.ctrlKey||event.metaKey)}
            onMouseMove={event=>{const r=(event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();setTip({x:event.clientX-r.left,y:event.clientY-r.top,title:labelText(category),lines:data.series.map(s=>({color:data.series.length>1?s.color:undefined,label:s.name,value:formatNumber(s.values[i],format)}))})}}
            onMouseLeave={()=>setTip(null)}>
            <rect x={0} y={i*band} width={W} height={band} fill="transparent"/>
            <text x={labelW} y={i*band+band/2+4} textAnchor="end" className="bi-axis bi-cat">{truncate(labelText(category),Math.floor(labelW/6.5))}</text>
            {data.series.map((s,j)=>{const v=s.values[i]??0
              const from=stacked?x(acc):x(Math.min(0,v)),to=stacked?x(acc+=Math.max(0,v)):x(Math.max(0,v))
              const y=stacked?y0:y0+j*barH
              return <path key={j} d={roundedBar(from,y,Math.max(0,to-from-(stacked?2:0)),barH-(stacked?0:1),'right',v<0,!stacked||j===data.series.length-1)} fill={s.color}/>})}
          </g>})}
        <line x1={x(0)} x2={x(0)} y1={0} y2={plotH} className="bi-baseline"/>
      </svg></div>
    }else{
      const axisW=Math.max(34,...ticks.map(t=>compactNumber(t,format).length*7+8))
      const rotateLabels=data.categories.length>6
      const left=Math.max(axisW,rotateLabels?Math.min(80,Math.max(...data.categories.slice(0,3).map(c=>Math.min(16,labelText(c).length)*5.2))):axisW),right=W-10,top=10,bottom=H-(rotateLabels?44:28)
      const y=(v:number)=>bottom-(v-lo)/(hi-lo||1)*(bottom-top)
      const band=(right-left)/data.categories.length
      const step=Math.ceil(data.categories.length/Math.max(1,Math.floor((right-left)/70)))
      const rotate=data.categories.length>6
      const cx=(i:number)=>left+band*i+band/2
      chart=<svg width={W} height={H} role="img" aria-label={object.title||(isLine?'Line chart':'Bar chart')}
        onMouseLeave={()=>{setTip(null);setHover(null)}}>
        {ticks.map(t=><g key={t}><line x1={left} x2={right} y1={y(t)} y2={y(t)} className="bi-grid"/><text x={left-6} y={y(t)+4} textAnchor="end" className="bi-axis">{compactNumber(t,format)}</text></g>)}
        {data.categories.map((category,i)=>i%step===0&&<text key={i} transform={rotate?`translate(${cx(i)},${bottom+12}) rotate(-35)`:undefined} x={rotate?0:cx(i)} y={rotate?0:bottom+18} textAnchor={rotate?'end':'middle'} className="bi-axis bi-cat">{truncate(labelText(category),rotate?16:Math.max(4,Math.floor(band*step/7)))}</text>)}
        {!isLine&&data.categories.map((category,i)=>{const groupW=Math.min(24*(stacked?1:data.series.length)+(stacked?0:2*(data.series.length-1)),band*0.72);const barW=stacked?groupW:Math.max(2,(groupW-2*(data.series.length-1))/data.series.length);let acc=0
          return <g key={i} className={`bi-hit ${dimmed(category)?'dimmed':''}`}>{data.series.map((s,j)=>{const v=s.values[i]??0
            const top2=stacked?y(acc+Math.max(0,v)):y(Math.max(0,v)),base=stacked?y(acc):y(Math.min(0,v));if(stacked)acc+=Math.max(0,v)
            const x0=cx(i)-groupW/2+(stacked?0:j*(barW+2))
            return <path key={j} d={roundedBar(x0,top2,barW,Math.max(0,base-top2-(stacked&&j>0?2:0)),'up',v<0,!stacked||j===data.series.length-1)} fill={s.color}/>})}</g>})}
        {isLine&&data.series.map(s=>{const pts=s.values.map((v,i)=>v===null?null:[cx(i),y(v)] as [number,number])
          const segments:string[]=[];let current='';pts.forEach(p=>{if(!p){if(current)segments.push(current);current=''}else current+=(current?'L':'M')+p[0].toFixed(1)+','+p[1].toFixed(1)});if(current)segments.push(current)
          const lastIndex=pts.map((p,i)=>p?i:-1).filter(i=>i>=0).pop()
          return <g key={s.name}>
            {segments.map((d,k)=><path key={k} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>)}
            {data.categories.length<=40&&pts.map((p,i)=>p&&(i===lastIndex||hover===i)&&<circle key={i} cx={p[0]} cy={p[1]} r={4} fill={s.color} stroke="#fff" strokeWidth={2}/>)}
          </g>})}
        {isLine&&hover!==null&&<line x1={cx(hover)} x2={cx(hover)} y1={top} y2={bottom} className="bi-crosshair"/>}
        <line x1={left} x2={right} y1={y(Math.max(lo,0))} y2={y(Math.max(lo,0))} className="bi-baseline"/>
        {data.categories.map((category,i)=><rect key={i} x={left+band*i} y={top} width={band} height={bottom-top} fill="transparent" className="bi-hit-area"
          onClick={event=>select(category,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>{const r=(event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();setHover(i);setTip({x:event.clientX-r.left,y:event.clientY-r.top,title:labelText(category),lines:data.series.filter(s=>s.values[i]!==null).map(s=>({color:data.series.length>1?s.color:undefined,label:s.name,value:formatNumber(s.values[i],format)}))})}}/>)}
      </svg>
    }
  }
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}>
    <div className="bi-plot" ref={ref}>{chart}<Tooltip tip={tip} width={W}/></div>
    <Legend items={legendItems} selected={splitDim?selectedValues(selections,splitDim.selectKey):undefined}
      onClick={splitDim?(value,additive)=>onSelect({key:splitDim.selectKey,label:splitDim.label,node:splitDim.node},value,additive):undefined}/>
    {result.has_more&&<small className="bi-note">Showing the first {limit} values</small>}
  </div>
}

function roundedBar(x:number,y:number,w:number,h:number,direction:'up'|'right',negative:boolean,round=true){
  if(w<=0||h<=0)return ''
  if(!round)return `M${x},${y}h${w}v${h}h${-w}z`
  const r=Math.min(4,direction==='up'?w/2:h/2,direction==='up'?h:w)
  if(direction==='up'){
    if(negative)return `M${x},${y}h${w}v${h-r}a${r},${r} 0 0 1 ${-r},${r}h${-(w-2*r)}a${r},${r} 0 0 1 ${-r},${-r}z`
    return `M${x},${y+h}v${-(h-r)}a${r},${r} 0 0 1 ${r},${-r}h${w-2*r}a${r},${r} 0 0 1 ${r},${r}v${h-r}z`
  }
  if(negative)return `M${x+w},${y}v${h}h${-(w-r)}a${r},${r} 0 0 1 ${-r},${-r}v${-(h-2*r)}a${r},${r} 0 0 1 ${r},${-r}z`
  return `M${x},${y}h${w-r}a${r},${r} 0 0 1 ${r},${r}v${h-2*r}a${r},${r} 0 0 1 ${-r},${r}h${-(w-r)}z`
}

// ---------------------------------------------------------------------------
// Pie (donut)
// ---------------------------------------------------------------------------
function PieObject({object,app,selections,onSelect,dataVersion,compiled}:ObjectProps&Compiled){
  const spec=useMemo(()=>buildSpec(compiled,selections,{sort:[{index:1,desc:true}],limit:200}),[compiled,selections])
  const result=useQuery(app.id,spec,dataVersion)
  const [ref,size]=useSize<HTMLDivElement>()
  const [tip,setTip]=useState<Tip|null>(null)
  const dim=compiled.dimensions[0],measure=compiled.measures[0]
  const slices=useMemo(()=>{
    const rows=result.rows.map(row=>({value:row[0],amount:Math.max(0,toNumber(row[1])||0)})).filter(row=>row.amount>0)
    const top=rows.length>8?rows.slice(0,7):rows
    const rest=rows.length>8?rows.slice(7).reduce((sum,row)=>sum+row.amount,0):0
    const list=top.map((row,i)=>({name:displayValue(row.value,dim.format),value:row.value,amount:row.amount,color:SERIES_COLORS[i]}))
    if(rest>0)list.push({name:'Other',value:null,amount:rest,color:'#9aa5ae'})
    return list
  },[result.rows,dim.format])
  const total=slices.reduce((sum,slice)=>sum+slice.amount,0)
  const selected=selectedValues(selections,dim.selectKey)
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!result.loading&&!slices.length)return <Message kind="empty">No data for the current selections</Message>
  const W=size.width,H=size.height-28,R=Math.max(10,Math.min(W,H)/2-6),cx=W/2,cy=H/2
  let angle=-Math.PI/2
  return <div className={`bi-chart ${result.loading?'is-loading':''}`}>
    <div className="bi-plot" ref={ref}>{W>40&&H>40&&<svg width={W} height={H} role="img" aria-label={object.title||'Pie chart'} onMouseLeave={()=>setTip(null)}>
      {slices.map((slice,i)=>{const a0=angle,a1=angle+slice.amount/total*Math.PI*2;angle=a1
        const large=a1-a0>Math.PI?1:0,ri=R*0.58
        const p=(r:number,a:number)=>`${cx+r*Math.cos(a)},${cy+r*Math.sin(a)}`
        const d=slices.length===1?`M${cx-R},${cy}a${R},${R} 0 1 0 ${2*R},0a${R},${R} 0 1 0 ${-2*R},0M${cx-ri},${cy}a${ri},${ri} 0 1 1 ${2*ri},0a${ri},${ri} 0 1 1 ${-2*ri},0`
          :`M${p(R,a0)}A${R},${R} 0 ${large} 1 ${p(R,a1)}L${p(ri,a1)}A${ri},${ri} 0 ${large} 0 ${p(ri,a0)}Z`
        return <path key={i} d={d} fill={slice.color} stroke="#fff" strokeWidth={2} fillRule="evenodd"
          className={`bi-hit ${selected.length&&!selected.some(v=>sameValue(v,slice.value))?'dimmed':''}`}
          onClick={event=>slice.name!=='Other'&&onSelect({key:dim.selectKey,label:dim.label,node:dim.node},slice.value,event.ctrlKey||event.metaKey)}
          onMouseMove={event=>{const r=(event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();setTip({x:event.clientX-r.left,y:event.clientY-r.top,title:slice.name,lines:[{label:measure.label,value:formatNumber(slice.amount,measure.format)},{label:'Share',value:formatNumber(slice.amount/total,'percent')}]})}}/>})}
      <text x={cx} y={cy+5} textAnchor="middle" className="bi-donut-total">{compactNumber(total,measure.format)}</text>
    </svg>}<Tooltip tip={tip} width={W}/></div>
    <Legend items={slices} selected={selected} onClick={(value,additive)=>onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,additive)}/>
  </div>
}

// ---------------------------------------------------------------------------
// Table: sortable, totals, paging, CSV
// ---------------------------------------------------------------------------
function TableObject({object,app,selections,onSelect,dataVersion,compiled}:ObjectProps&Compiled){
  const [sort,setSort]=useState<{index:number;desc:boolean}|null>(null)
  const [pages,setPages]=useState(1)
  const pageSize=200
  const order=sort?[sort]:defaultSort(object,compiled)
  const spec=useMemo(()=>buildSpec(compiled,selections,{sort:order,limit:pageSize*pages,styles:true}),[compiled,selections,JSON.stringify(order),pages])// eslint-disable-line react-hooks/exhaustive-deps
  const result=useQuery(app.id,spec,dataVersion)
  const totalsSpec=useMemo(()=>compiled.measures.length&&compiled.dimensions.length&&object.options.totals!==false?buildSpec(compiled,selections,{dimensions:[],limit:1}):null,[compiled,selections,object.options.totals])
  const totals=useQuery(app.id,totalsSpec,dataVersion)
  const [exporting,setExporting]=useState(false)
  useEffect(()=>{setPages(1)},[selections,sort])
  const dims=compiled.dimensions.length,ncols=dims+compiled.measures.length
  const headers=[...compiled.dimensions.map(d=>d.label),...compiled.measures.map(m=>m.label)]
  const formats=[...compiled.dimensions.map(d=>d.format),...compiled.measures.map(m=>m.format)]
  const display=columnOrder(object).filter(i=>i<ncols)
  const numeric=(i:number)=>i>=dims
  async function exportCsv(){
    if(!supabase)return
    setExporting(true)
    try{
      const all=await runQuery(supabase,app.id,buildSpec(compiled,selections,{sort:order,limit:10000}))
      const blob=new Blob(['\ufeff'+toCsv(display.map(i=>headers[i]),all.rows.map(row=>display.map(i=>row[i])))],{type:'text/csv;charset=utf-8'})
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${(object.title||app.name).replace(/[^\w\- ]+/g,'').trim()||'export'}.csv`;link.click();URL.revokeObjectURL(link.href)
    }finally{setExporting(false)}
  }
  if(result.error)return <Message kind="error">{result.error}</Message>
  const current=sort??order[0]
  return <div className={`bi-table-wrap ${result.loading?'is-loading':''}`}>
    <div className="bi-table-scroll"><table className="bi-table">
      <thead><tr>{display.map((i,k)=><th key={i} className={numeric(i)?'num':''} onClick={()=>setSort(c=>c?.index===i?{index:i,desc:!c.desc}:{index:i,desc:numeric(i)})}>
        {headers[i]}{current?.index===i?(current.desc?<ChevronDown size={12}/>:<ChevronUp size={12}/>):null}</th>)}</tr>
        {totalsSpec&&totals.rows[0]&&<tr className="bi-totals">{display.map(i=><th key={i} className={numeric(i)?'num':''}>{numeric(i)?formatNumber(toNumber(totals.rows[0][i-dims]),formats[i]):i===display.find(c=>!numeric(c))?'Totals':''}</th>)}</tr>}
      </thead>
      <tbody>{result.rows.map((row,r)=><tr key={r}>{display.map(i=>{const value=row[i],dim=compiled.dimensions[i],style=cellStyle(compiled,row,i,ncols)
        if(!dim)return <td key={i} className="num" style={style}>{formatNumber(toNumber(value),formats[i])}</td>
        const isSel=selectedValues(selections,dim.selectKey).some(v=>sameValue(v,value))
        return <td key={i} style={style} className={`bi-selectable ${isSel?'selected':''}`} onClick={event=>onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,event.ctrlKey||event.metaKey)}>{displayValue(value,formats[i])}</td>})}</tr>)}
      </tbody></table>
      {!result.loading&&!result.rows.length&&<Message kind="empty">No data for the current selections</Message>}
    </div>
    <div className="bi-table-foot"><span>{result.rows.length.toLocaleString()}{result.has_more?'+':''} rows</span>
      {result.has_more&&<button type="button" className="text-button" onClick={()=>setPages(p=>p+1)}>Load more</button>}
      <button type="button" className="text-button" disabled={exporting} onClick={()=>void exportCsv()}><Download size={13}/>{exporting?'Exporting…':'CSV'}</button></div>
  </div>
}

// ---------------------------------------------------------------------------
// Pivot table: all dimensions but the last are rows; the last becomes columns
// ---------------------------------------------------------------------------
function PivotObject({app,selections,onSelect,dataVersion,compiled}:ObjectProps&Compiled){
  const rowDims=compiled.dimensions.length-1
  const spec=useMemo(()=>buildSpec(compiled,selections,{sort:compiled.dimensions.map((_,index)=>({index,desc:false})),limit:5000,styles:true}),[compiled,selections])
  const result=useQuery(app.id,spec,dataVersion)
  const pivot=useMemo(()=>toPivot(result.rows,rowDims),[result.rows,rowDims])
  const colDim=compiled.dimensions[rowDims]
  // dimension colours: row headers per row, column headers per column (their own small queries)
  const rowStyles=compiled.styles.filter(style=>style.column<rowDims),colStyles=compiled.styles.filter(style=>style.column===rowDims)
  const rowStyleSpec=useMemo(()=>rowStyles.length?{...buildSpec(compiled,selections,{dimensions:compiled.dimensions.slice(0,rowDims).map((_,i)=>i),measures:[],limit:5000}),measures:rowStyles.map(style=>({expr:style.node}))}:null,[compiled,selections])// eslint-disable-line react-hooks/exhaustive-deps
  const colStyleSpec=useMemo(()=>colStyles.length?{...buildSpec(compiled,selections,{dimensions:[rowDims],measures:[],limit:500}),measures:colStyles.map(style=>({expr:style.node}))}:null,[compiled,selections])// eslint-disable-line react-hooks/exhaustive-deps
  const rowStyleRows=useQuery(app.id,rowStyleSpec,dataVersion),colStyleRows=useQuery(app.id,colStyleSpec,dataVersion)
  const headerStyle=(styles:typeof rowStyles,rows:FieldValue[][],keyCount:number,key:FieldValue[],column:number)=>{
    const row=rows.find(r=>JSON.stringify(r.slice(0,keyCount))===JSON.stringify(key));if(!row)return undefined
    const style:{background?:string;color?:string}={}
    styles.forEach((item,k)=>{if(item.column!==column)return;const color=safeColor(row[keyCount+k]);if(!color)return;if(item.kind==='background')style.background=color;else style.color=color})
    if(style.background&&!style.color)style.color=contrastText(style.background)
    return style
  }
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!result.loading&&!result.rows.length)return <Message kind="empty">No data for the current selections</Message>
  const cols=pivot.colKeys.slice(0,60)
  return <div className={`bi-table-wrap ${result.loading?'is-loading':''}`}><div className="bi-table-scroll"><table className="bi-table bi-pivot">
    <thead><tr>{compiled.dimensions.slice(0,rowDims).map((d,i)=><th key={i} rowSpan={compiled.measures.length>1?2:1}>{d.label}</th>)}
      {cols.map((c,i)=><th key={i} colSpan={compiled.measures.length} className="num bi-selectable" style={colStyles.length?headerStyle(colStyles,colStyleRows.rows,1,[c],rowDims):undefined} onClick={event=>onSelect({key:colDim.selectKey,label:colDim.label,node:colDim.node},c,event.ctrlKey||event.metaKey)}>{displayValue(c,colDim.format)}</th>)}</tr>
      {compiled.measures.length>1&&<tr>{cols.flatMap((_,i)=>compiled.measures.map((m,j)=><th key={`${i}-${j}`} className="num">{m.label}</th>))}</tr>}</thead>
    <tbody>{pivot.rowKeys.map((rk,r)=><tr key={r}>{rk.map((value,i)=>{const dim=compiled.dimensions[i];return <td key={i} className="bi-selectable" style={rowStyles.length?headerStyle(rowStyles,rowStyleRows.rows,rowDims,rk,i):undefined} onClick={event=>onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,event.ctrlKey||event.metaKey)}>{displayValue(value,dim.format)}</td>})}
      {cols.flatMap((c,i)=>{const cell=pivot.cells.get(JSON.stringify(rk)+'|'+JSON.stringify(c));return compiled.measures.map((m,j)=><td key={`${i}-${j}`} className="num" style={cell?cellStyle(compiled,[...Array(compiled.dimensions.length).fill(null),...cell],compiled.dimensions.length+j,compiled.dimensions.length+compiled.measures.length):undefined}>{cell?formatNumber(toNumber(cell[j]),m.format):''}</td>)})}</tr>)}</tbody>
  </table></div>{pivot.colKeys.length>60&&<small className="bi-note">Showing the first 60 columns</small>}</div>
}

// ---------------------------------------------------------------------------
// Filter pane (Qlik list box): selected values green, click toggles
// ---------------------------------------------------------------------------
function FilterPane({app,selections,onSelect,dataVersion,compiled}:ObjectProps&Compiled){
  const dim=compiled.dimensions[0]
  const [search,setSearch]=useState('')
  const spec=useMemo(()=>buildSpec(compiled,selections,{ignoreKey:dim.selectKey,sort:[{index:0,desc:false}],limit:2000}),[compiled,selections,dim.selectKey])
  const result=useQuery(app.id,spec,dataVersion)
  const selected=selectedValues(selections,dim.selectKey)
  const values=useMemo(()=>{const needle=search.trim().toLowerCase();return result.rows.map(row=>row[0]).filter(value=>value!==null&&(!needle||displayValue(value,dim.format).toLowerCase().includes(needle)))},[result.rows,search,dim.format])
  if(result.error)return <Message kind="error">{result.error}</Message>
  return <div className={`bi-filter ${result.loading?'is-loading':''}`}>
    <label className="bi-filter-search"><Search size={13}/><input placeholder="Search" value={search} onChange={event=>setSearch(event.target.value)}/>{search&&<button type="button" aria-label="Clear search" onClick={()=>setSearch('')}><X size={12}/></button>}</label>
    <ul>{values.map((value,i)=>{const isSel=selected.some(v=>sameValue(v,value));return <li key={i}><button type="button" className={isSel?'selected':''} onClick={()=>onSelect({key:dim.selectKey,label:dim.label,node:dim.node},value,true)}>{displayValue(value,dim.format)}</button></li>})}</ul>
    {result.has_more&&<small className="bi-note">First 2,000 values. Search to narrow down.</small>}
  </div>
}

export function formatLabel(format?:NumberFormat){return format&&format!=='auto'?{integer:'Whole number',money:'Rand',percent:'Percent',number:'Number'}[format]:'Automatic'}
