import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, FileSpreadsheet, RefreshCw, Upload, XCircle } from 'lucide-react'
import { supabase } from './supabase'
import { loadStockAccess } from './stockPartsQueries'
import {
  activateStockImport, loadStockImportBatches, rejectStockImport, stageAndValidateStockImport, type StockImportBatch,
} from './stockImportPipeline'
import {
  autoMapImportHeaders, buildStockImportRows, combineStockImportChecksums, fieldsForDataset,
  parseStockImportFile, type ImportMapping, type ParsedImportTable, type StockImportDataset,
} from './stockImportFiles'
import {
  loadStockIngestion, saveGoogleSheetsSource, syncStockIngestionSource,
  type StockIngestionRun, type StockIngestionSource,
} from './stockIngestion'

type Props={ token:string; setNotice:(message:string)=>void; setError:(message:string)=>void }
type DatasetState={ table:ParsedImportTable|null; mapping:ImportMapping; loading:boolean; parseError:string }
const emptyDataset=():DatasetState=>({table:null,mapping:{},loading:false,parseError:''})

function DatasetPanel({dataset,state,setState}: {dataset:StockImportDataset;state:DatasetState;setState:(state:DatasetState)=>void}) {
  const title=dataset==='booking'?'Stock Booking':'Stock Reordering'; const fields=fieldsForDataset(dataset)
  const validation=useMemo(()=>state.table?buildStockImportRows(state.table,dataset,state.mapping):{rows:[],errors:[]},[state.table,state.mapping,dataset])
  const choose=async(file?:File) => {
    if (!file) return
    setState({...state,loading:true,parseError:''})
    try { const table=await parseStockImportFile(file,dataset); setState({table,mapping:autoMapImportHeaders(table.headers,fields),loading:false,parseError:''}) }
    catch(error) { setState({...emptyDataset(),parseError:(error as Error).message}) }
  }
  return <div className="settings-card stock-import-dataset">
    <div className="stock-import-title"><div><h3>{title}</h3><p>Select the source containing {title} inventory rows.</p></div><label className="secondary stock-import-file"><Upload size={15}/>{state.loading?'Reading…':state.table?'Replace file':'Choose file'}<input type="file" accept=".csv,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={state.loading} onChange={(event)=>{const file=event.target.files?.[0];if(file)void choose(file).catch(()=>{});event.target.value=''}}/></label></div>
    {state.parseError&&<div className="stock-import-validation invalid"><XCircle size={17}/><b>{state.parseError}</b></div>}
    {!state.table?<div className="stock-import-empty"><FileSpreadsheet size={28}/><span>CSV, TSV or XLSX · maximum 25 MB</span></div>:<>
      <div className="stock-import-file-meta"><b>{state.table.fileName}</b><span>{state.table.sheetName} · {state.table.rows.length.toLocaleString()} source rows</span><code>{state.table.fileChecksum.slice(0,16)}…</code></div>
      <details className="stock-import-mapping"><summary>Column mapping</summary><div className="stock-import-map-grid">{fields.map(field=><label key={field.key}>{field.label}{field.required&&<b className="required-mark"> *</b>}<select value={state.mapping[field.key]||''} onChange={(event)=>setState({...state,mapping:{...state.mapping,[field.key]:event.target.value}})}><option value="">Not mapped</option>{state.table!.headers.map(header=><option key={header} value={header}>{header}</option>)}</select></label>)}</div></details>
      <div className={`stock-import-validation ${validation.errors.length?'invalid':'valid'}`}>{validation.errors.length?<><XCircle size={17}/><b>{validation.errors.length} validation issue{validation.errors.length===1?'':'s'}</b></>:<><CheckCircle2 size={17}/><b>{validation.rows.length.toLocaleString()} rows ready</b></>}</div>
      {!!validation.errors.length&&<ul className="stock-import-errors">{validation.errors.slice(0,20).map((error,index)=><li key={`${error.row}-${error.field}-${index}`}>{error.row?`Row ${error.row}: `:''}{error.message}</li>)}{validation.errors.length>20&&<li>And {validation.errors.length-20} more issues.</li>}</ul>}
      {!validation.errors.length&&<div className="rfq-table-wrap stock-import-preview"><table className="rfq-table"><thead><tr>{fields.filter(field=>field.required||state.mapping[field.key]).slice(0,8).map(field=><th key={field.key}>{field.label}</th>)}</tr></thead><tbody>{validation.rows.slice(0,5).map((row,index)=><tr key={index}>{fields.filter(field=>field.required||state.mapping[field.key]).slice(0,8).map(field=><td key={field.key}>{String(row[field.key]??'')||'—'}</td>)}</tr>)}</tbody></table></div>}
    </>}
  </div>
}

export default function StockImport({setNotice,setError}:Props) {
  const [booking,setBooking]=useState<DatasetState>(emptyDataset)
  const [reordering,setReordering]=useState<DatasetState>(emptyDataset)
  const [batches,setBatches]=useState<StockImportBatch[]>([])
  const [sources,setSources]=useState<StockIngestionSource[]>([]); const [runs,setRuns]=useState<StockIngestionRun[]>([])
  const [sourceDraft,setSourceDraft]=useState({id:'',name:'Google Sheets stock feed',spreadsheet:'',bookingTab:'Stock Booking',reorderingTab:'Stock Reordering',isActive:true,scheduleEnabled:false})
  const [pairedChecksum,setPairedChecksum]=useState('')
  const [isAdmin,setIsAdmin]=useState(false); const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false)
  const bookingValidation=useMemo(()=>booking.table?buildStockImportRows(booking.table,'booking',booking.mapping):null,[booking])
  const reorderingValidation=useMemo(()=>reordering.table?buildStockImportRows(reordering.table,'reordering',reordering.mapping):null,[reordering])
  const fileKindsMatch=!booking.table||!reordering.table||booking.table.fileName.toLowerCase().endsWith('.xlsx')===reordering.table.fileName.toLowerCase().endsWith('.xlsx')
  useEffect(()=>{let current=true;if(booking.table&&reordering.table&&fileKindsMatch)void combineStockImportChecksums(booking.table.fileChecksum,reordering.table.fileChecksum).then(hash=>{if(current)setPairedChecksum(hash)});else setPairedChecksum('');return()=>{current=false}},[booking.table?.fileChecksum,reordering.table?.fileChecksum,fileKindsMatch])
  const load=useCallback(async()=>{
    if(!supabase){setError('Supabase is not configured.');setLoading(false);return}
    try {
      const [access,history,ingestion]=await Promise.all([loadStockAccess(supabase),loadStockImportBatches(supabase),loadStockIngestion(supabase)])
      setIsAdmin(access.isAdmin);setBatches(history);setSources(ingestion.sources);setRuns(ingestion.runs)
      const source=ingestion.sources.find(item=>item.provider==='google_sheets')
      if(source)setSourceDraft({id:source.id,name:source.name,spreadsheet:source.configuration.spreadsheet_id||'',bookingTab:source.configuration.booking_tab||'Stock Booking',reorderingTab:source.configuration.reordering_tab||'Stock Reordering',isActive:source.is_active,scheduleEnabled:source.schedule_enabled})
      setError('')
    }
    catch(error){setError((error as Error).message)} finally{setLoading(false)}
  },[setError])
  useEffect(()=>{void load()},[load])

  const stage=async()=>{
    if(!supabase||!booking.table||!reordering.table||!bookingValidation||!reorderingValidation)return
    if(bookingValidation.errors.length||reorderingValidation.errors.length){setError('Correct the file validation issues before staging this import.');return}
    setBusy(true);setError('')
    try {
      if(!fileKindsMatch)throw new Error('Use two CSV/TSV files or two XLSX files for one import batch.')
      const checksum=pairedChecksum||await combineStockImportChecksums(booking.table.fileChecksum,reordering.table.fileChecksum)
      const sourceType=booking.table.fileName.toLowerCase().endsWith('.xlsx')||reordering.table.fileName.toLowerCase().endsWith('.xlsx')?'manual_xlsx':'manual_csv'
      const sourceName=booking.table.fileName===reordering.table.fileName?booking.table.fileName:`${booking.table.fileName} + ${reordering.table.fileName}`
      await stageAndValidateStockImport(supabase,{sourceType,sourceName,checksum,bookingRows:bookingValidation.rows,reorderingRows:reorderingValidation.rows})
      setNotice('Stock import staged and validated. Review it below, then activate it.')
      await load()
    } catch(error) {
      setError((error as Error).message);await load()
    } finally{setBusy(false)}
  }
  const activate=async(batch:StockImportBatch)=>{
    if(!supabase||busy||!window.confirm(`Activate ${batch.source_name}? This will replace the current Smart Stock snapshot.`))return
    setBusy(true);setError('');try{await activateStockImport(supabase,batch.id);setNotice('Stock snapshot activated successfully.');await load()}catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  const reject=async(batch:StockImportBatch)=>{
    if(!supabase||busy)return;const reason=window.prompt('Why should this import be rejected?');if(!reason)return
    setBusy(true);setError('');try{await rejectStockImport(supabase,batch.id,reason);setNotice('Stock import rejected.');await load()}catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  const saveSource=async()=>{
    if(!supabase||busy)return;setBusy(true);setError('')
    try{const id=await saveGoogleSheetsSource(supabase,sourceDraft);setSourceDraft({...sourceDraft,id});setNotice('Google Sheets stock source saved.');await load()}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  const syncSource=async()=>{
    if(!supabase||!sourceDraft.id||busy)return;setBusy(true);setError('')
    try{const result=await syncStockIngestionSource(supabase,sourceDraft.id);setNotice(result.status==='no_change'?'Google Sheets is unchanged; no new import was created.':`Google Sheets staged and validated (${result.bookingRows.toLocaleString()} Booking, ${result.reorderingRows.toLocaleString()} Reordering). Review and activate it below.`);await load()}
    catch(error){setError((error as Error).message);await load()}finally{setBusy(false)}
  }
  if(loading)return <section className="settings-page"><p>Loading Stock Data Import…</p></section>
  if(!isAdmin)return <section className="settings-page"><div className="settings-card"><h2>Administrator access required</h2><p>Only administrators can stage or activate stock snapshots.</p></div></section>
  const ready=Boolean(booking.table&&reordering.table&&fileKindsMatch&&pairedChecksum&&bookingValidation&&!bookingValidation.errors.length&&reorderingValidation&&!reorderingValidation.errors.length)
  return <section className="settings-page">
    <div className="section-head"><div><h2>Stock Data Import</h2><p>Map and validate both datasets before creating a versioned snapshot.</p></div><button className="secondary" disabled={busy} onClick={()=>void load()}><RefreshCw size={15}/>Refresh history</button></div>
    <div className="security-note"><FileSpreadsheet size={20}/><div><b>Nothing becomes live immediately.</b><p>Files are validated into a staged version first. An administrator must activate the validated version separately.</p></div></div>
    <div className="settings-card stock-import-history">
      <div className="stock-import-title"><div><h3>Automated source · Google Sheets</h3><p>The private sheet is read by a Vercel service account and passed through the same validation and versioned snapshot pipeline as manual files.</p></div><button className="secondary" disabled={busy||!sourceDraft.id||!sourceDraft.isActive} onClick={()=>void syncSource()}><RefreshCw size={15}/>{busy?'Working…':'Sync now'}</button></div>
      <div className="stock-import-map-grid">
        <label>Source name<input value={sourceDraft.name} onChange={event=>setSourceDraft({...sourceDraft,name:event.target.value})}/></label>
        <label>Spreadsheet URL or ID<input value={sourceDraft.spreadsheet} onChange={event=>setSourceDraft({...sourceDraft,spreadsheet:event.target.value})} placeholder="https://docs.google.com/spreadsheets/d/…"/></label>
        <label>Stock Booking tab<input value={sourceDraft.bookingTab} onChange={event=>setSourceDraft({...sourceDraft,bookingTab:event.target.value})}/></label>
        <label>Stock Reordering tab<input value={sourceDraft.reorderingTab} onChange={event=>setSourceDraft({...sourceDraft,reorderingTab:event.target.value})}/></label>
      </div>
      <div className="stock-import-submit"><div><label><input type="checkbox" checked={sourceDraft.isActive} onChange={event=>setSourceDraft({...sourceDraft,isActive:event.target.checked})}/> Source enabled</label><small>Share the sheet as Viewer with the Google service-account email configured in Vercel.</small><label><input type="checkbox" checked={sourceDraft.scheduleEnabled} onChange={event=>setSourceDraft({...sourceDraft,scheduleEnabled:event.target.checked})}/> Stage and validate daily</label><small>Scheduled runs never activate stock automatically.</small></div><button className="primary" disabled={busy} onClick={()=>void saveSource()}>{sourceDraft.id?'Save source':'Add source'}</button></div>
      {!!runs.length&&<div className="config-list">{runs.slice(0,5).map(run=><div className="config-row" key={run.id}><span><b>{run.trigger_type==='scheduled'?'Scheduled sync':'Manual sync'}</b><small>{new Date(run.started_at).toLocaleString()} · Booking {run.booking_row_count.toLocaleString()} · Reordering {run.reordering_row_count.toLocaleString()}</small>{run.error_message&&<small className="stock-import-error-text">{run.error_message}</small>}</span><span className={`roadmap-status ${run.status==='validated'||run.status==='no_change'?'complete':run.status==='failed'?'missing':'partial'}`}>{run.status.replace('_',' ')}</span></div>)}</div>}
    </div>
    <div className="stock-import-grid"><DatasetPanel dataset="booking" state={booking} setState={(state)=>{setBooking(state);setError('')}}/><DatasetPanel dataset="reordering" state={reordering} setState={(state)=>{setReordering(state);setError('')}}/></div>
    {!fileKindsMatch&&<div className="stock-import-validation invalid"><XCircle size={17}/><b>Use two CSV/TSV files or two XLSX files in the same import batch.</b></div>}
    <div className="stock-import-submit"><div><b>{ready?'Both datasets are ready.':'Select and validate both datasets.'}</b><small>{pairedChecksum?`Combined SHA-256: ${pairedChecksum.slice(0,20)}…`:'Activation remains a separate confirmation step.'}</small></div><button className="primary" disabled={!ready||busy} onClick={()=>void stage()}><Upload size={16}/>{busy?'Working…':'Stage and validate'}</button></div>
    <div className="settings-card stock-import-history"><h3>Import history</h3>{!batches.length?<p>No stock imports have been recorded.</p>:<div className="config-list">{batches.slice(0,20).map(batch=><div className="config-row" key={batch.id}><span><b>{batch.source_name}</b><small>{new Date(batch.created_at).toLocaleString()} · Booking {batch.booking_row_count.toLocaleString()} · Reordering {batch.reordering_row_count.toLocaleString()}</small>{batch.validation_errors?.slice(0,2).map((error,index)=><small className="stock-import-error-text" key={index}>{error.message}</small>)}</span><div className="stock-config-actions"><span className={`roadmap-status ${batch.status==='active'?'complete':batch.status==='rejected'?'missing':'partial'}`}>{batch.status}</span>{batch.status==='validated'&&<button className="primary" disabled={busy} onClick={()=>void activate(batch)}>Activate</button>}{['staged','validated'].includes(batch.status)&&<button className="secondary" disabled={busy} onClick={()=>void reject(batch)}>Reject</button>}</div></div>)}</div>}</div>
  </section>
}
