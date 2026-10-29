// Write table: dimensions and measures from the data plus columns people can type into.
// Values are saved per row (the row's dimension values) with bi_write_set; the ERP data is not changed.
import {useCallback,useEffect,useMemo,useState} from 'react'
import {Check,Download,Loader2,TriangleAlert} from 'lucide-react'
import {supabase} from './supabase'
import {buildSpec,defaultSort,displayValue,formatNumber,loadWriteCells,saveWriteCell,toCsv,toNumber,type FieldValue,type WriteCell,type WriteColumn} from './biApps'
import {Message,useQuery,type Compiled,type ObjectProps} from './biChartKit'

export const rowKey=(values:FieldValue[])=>JSON.stringify(values)

export function WriteTable(props:ObjectProps&Compiled){
  const {object,app,selections,dataVersion,compiled}=props
  const columns=(object.options.writeColumns||[]).filter(c=>c.name.trim())
  const spec=useMemo(()=>buildSpec(compiled,selections,{sort:defaultSort(object,compiled),limit:2000}),[compiled,selections,object])
  const result=useQuery(app.id,spec,dataVersion)
  const [cells,setCells]=useState<Map<string,WriteCell>>(new Map())
  const [status,setStatus]=useState<Record<string,'saving'|'saved'|string>>({})
  const [loadError,setLoadError]=useState('')
  const canWrite=object.options.writeEditors!=='builders'||app.can_edit
  const load=useCallback(async()=>{
    if(!supabase)return
    try{const list=await loadWriteCells(supabase,app.id,object.id);setCells(new Map(list.map(c=>[c.row_key+'\u0001'+c.column,c])));setLoadError('')}
    catch(error){setLoadError((error as Error).message)}
  },[app.id,object.id])
  useEffect(()=>{void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load()},30000);return()=>clearInterval(timer)},[load])
  const dims=compiled.dimensions.length
  async function save(key:string,column:WriteColumn,value:string){
    const id=key+'\u0001'+column.name
    if((cells.get(id)?.value||'')===value.trim())return
    if(!supabase)return
    setStatus(s=>({...s,[id]:'saving'}))
    try{
      await saveWriteCell(supabase,app.id,object.id,key,column.name,value)
      setCells(current=>{const next=new Map(current);if(value.trim())next.set(id,{row_key:key,column:column.name,value:column.type==='number'?value.trim().replace(',','.'):value.trim(),updated_at:new Date().toISOString(),updated_by:'you'});else next.delete(id);return next})
      setStatus(s=>({...s,[id]:'saved'}));setTimeout(()=>setStatus(s=>{const n={...s};if(n[id]==='saved')delete n[id];return n}),1500)
    }catch(error){setStatus(s=>({...s,[id]:(error as Error).message}))}
  }
  function exportCsv(){
    const headers=[...compiled.dimensions.map(d=>d.label),...compiled.measures.map(m=>m.label),...columns.map(c=>c.name)]
    const rows=result.rows.map(row=>[...row.slice(0,dims+compiled.measures.length),...columns.map(c=>cells.get(rowKey(row.slice(0,dims))+'\u0001'+c.name)?.value??null)])
    const blob=new Blob(['﻿'+toCsv(headers,rows)],{type:'text/csv;charset=utf-8'})
    const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`${(object.title||'write table').replace(/[^\w\- ]+/g,'').trim()||'export'}.csv`;link.click();URL.revokeObjectURL(link.href)
  }
  if(result.error)return <Message kind="error">{result.error}</Message>
  if(!columns.length)return <Message kind="empty">Add editable columns in this table's settings</Message>
  return <div className={`bi-table-wrap ${result.loading?'is-loading':''}`}>
    {loadError&&<small className="bi-expr-error">{loadError}</small>}
    <div className="bi-table-scroll"><table className="bi-table bi-write">
      <thead><tr>{compiled.dimensions.map((d,i)=><th key={'d'+i}>{d.label}</th>)}{compiled.measures.map((m,i)=><th key={'m'+i} className="num">{m.label}</th>)}
        {columns.map(c=><th key={'w'+c.name} className={`bi-write-head ${c.type==='number'?'num':''}`}>{c.name}</th>)}</tr></thead>
      <tbody>{result.rows.map((row,r)=>{const key=rowKey(row.slice(0,dims))
        return <tr key={r}>{row.slice(0,dims).map((v,i)=><td key={'d'+i}>{displayValue(v,compiled.dimensions[i].format)}</td>)}
          {compiled.measures.map((m,i)=><td key={'m'+i} className="num">{formatNumber(toNumber(row[dims+i]),m.format)}</td>)}
          {columns.map(c=>{const id=key+'\u0001'+c.name,cell=cells.get(id),state=status[id]
            return <td key={'w'+c.name} className={`bi-write-cell ${c.type==='number'?'num':''}`} title={cell?`Changed by ${cell.updated_by||'someone'} on ${new Date(cell.updated_at).toLocaleString()}`:undefined}>
              <div className="bi-write-input">
                {c.type==='choice'?<select value={cell?.value||''} disabled={!canWrite} aria-label={c.name} onChange={event=>void save(key,c,event.target.value)}>
                  <option value=""></option>{(c.choices||'').split(',').map(x=>x.trim()).filter(Boolean).map(x=><option key={x}>{x}</option>)}</select>
                :<input key={cell?.value||''} defaultValue={cell?.value||''} disabled={!canWrite} aria-label={c.name} inputMode={c.type==='number'?'decimal':undefined}
                  onBlur={event=>void save(key,c,event.target.value)} onKeyDown={event=>{if(event.key==='Enter')(event.target as HTMLInputElement).blur();if(event.key==='Escape'){(event.target as HTMLInputElement).value=cell?.value||'';(event.target as HTMLInputElement).blur()}}}/>}
                {state==='saving'?<Loader2 size={12} className="bi-spin"/>:state==='saved'?<Check size={12} className="bi-write-ok"/>:state?<span title={state}><TriangleAlert size={12} className="bi-write-bad"/></span>:null}
              </div></td>})}</tr>})}
      </tbody></table>
      {!result.loading&&!result.rows.length&&<Message kind="empty">No data for the current selections</Message>}
    </div>
    <div className="bi-table-foot"><span>{result.rows.length.toLocaleString()}{result.has_more?'+':''} rows · {canWrite?'type in the coloured columns; saved for everyone':'read only (builders can edit)'}</span>
      <button type="button" className="text-button" onClick={exportCsv}><Download size={13}/>CSV</button></div>
  </div>
}
