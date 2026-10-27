import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, PackageCheck, RefreshCw, Search } from 'lucide-react'
import { supabase } from './supabase'
import {
  createStockBookingTransfer, downloadStockBookingCsv, loadStockBookingTransfer, loadStockBookingWorkspace,
  prepareStockTransferRows, type StockBookingItem, type StockLocation, type StockTransferHistory,
} from './stockBookingData'

type Props={token:string;setNotice:(message:string)=>void;setError:(message:string)=>void}

export default function StockBookingSupabase({setNotice,setError}:Props) {
  const [items,setItems]=useState<StockBookingItem[]>([]);const [locations,setLocations]=useState<StockLocation[]>([])
  const [activeBatchId,setActiveBatchId]=useState<string|null>(null);const [history,setHistory]=useState<StockTransferHistory[]>([])
  const [fromLocation,setFromLocation]=useState('');const [toLocation,setToLocation]=useState('');const [comments,setComments]=useState('')
  const [supplySort,setSupplySort]=useState<'none'|'er'|'pta'>('none');const [search,setSearch]=useState('')
  const [selected,setSelected]=useState<Record<string,string>>({});const [canEdit,setCanEdit]=useState(false)
  const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false)

  const load=useCallback(async()=>{
    if(!supabase){setError('Supabase is not configured.');setLoading(false);return}
    try{
      const workspace=await loadStockBookingWorkspace(supabase)
      setItems(workspace.items);setLocations(workspace.locations);setActiveBatchId(workspace.activeBatchId)
      setHistory(workspace.history);setCanEdit(workspace.access.canEdit)
      const warehouse=workspace.locations.find(location=>location.name==='10'||location.description.toLowerCase().includes('warehouse'))
      const vehicle=workspace.locations.find(location=>['erbakkie','ptabakkie'].includes(location.vehicle_name.toLowerCase().replaceAll(' ','')))
      setFromLocation(current=>workspace.locations.some(location=>location.id===current)?current:warehouse?.id||'')
      setToLocation(current=>workspace.locations.some(location=>location.id===current)?current:vehicle?.id||'')
      setError('')
    }catch(error){setError((error as Error).message)}finally{setLoading(false)}
  },[setError])
  useEffect(()=>{void load()},[load])

  const supplyEr=(item:StockBookingItem)=>Math.max(0,item.supply_er)
  const supplyPta=(item:StockBookingItem)=>Math.max(0,item.supply_pta)
  const visible=useMemo(()=>{const query=search.trim().toLowerCase();return [...items].filter(item=>(!query||`${item.part_number} ${item.description}`.toLowerCase().includes(query))&&(supplySort==='none'||(supplySort==='er'?supplyEr(item)>0:supplyPta(item)>0))).sort((a,b)=>supplySort==='er'?supplyEr(b)-supplyEr(a):supplySort==='pta'?supplyPta(b)-supplyPta(a):a.part_number.localeCompare(b.part_number))},[items,search,supplySort])
  const fromLocationOptions=locations.filter(location=>location.name==='10'||location.description.toLowerCase().includes('warehouse'))
  const toLocationOptions=locations.filter(location=>['erbakkie','ptabakkie'].includes(location.vehicle_name.toLowerCase().replaceAll(' ','')))
  const selectedDestination=locations.find(location=>location.id===toLocation);const selectedSource=locations.find(location=>location.id===fromLocation)
  useEffect(()=>{if(selectedDestination?.supply_branch==='er')setSupplySort('er');else if(selectedDestination?.supply_branch==='pta')setSupplySort('pta')},[selectedDestination?.supply_branch])

  const exportRows=async()=>{
    if(!supabase||!canEdit||busy)return
    if(!activeBatchId){setError('No active stock snapshot is available. Import and activate stock data first.');return}
    if(!fromLocation||!toLocation||fromLocation===toLocation){setError('Choose two different From and To locations before exporting.');return}
    try{
      const rows=prepareStockTransferRows(items,selected)
      setBusy(true);setError('')
      const transfer=await createStockBookingTransfer(supabase,{activeBatchId,fromLocationId:fromLocation,toLocationId:toLocation,remarks:comments,rows})
      downloadStockBookingCsv(transfer);setSelected({});setNotice(`Stock Booking ${transfer.reference} saved and downloaded.`);await load()
    }catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  const redownload=async(transferId:string)=>{
    if(!supabase||busy)return
    setBusy(true);setError('')
    try{const transfer=await loadStockBookingTransfer(supabase,transferId);downloadStockBookingCsv(transfer);setNotice(`Stock Booking ${transfer.reference} downloaded again.`)}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  }
  if(loading)return <section className="rfq-workspace"><p>Loading Stock Booking…</p></section>
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><PackageCheck size={18}/><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Stock Booking</button></div><button className="secondary" disabled={busy} onClick={()=>void load()}><RefreshCw size={14}/>Refresh</button></div>
    {!canEdit&&<div className="security-note"><PackageCheck size={20}/><div><b>Read-only access</b><p>Management users can review Stock Booking but only stock operators and administrators can create transfers.</p></div></div>}
    {!activeBatchId&&<div className="stock-import-validation invalid"><b>No active stock snapshot is available. Import and activate Booking and Reordering data first.</b></div>}
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search"><Search size={15}/>Search stock<input placeholder="Part number or description" value={search} onChange={event=>setSearch(event.target.value)}/></label><label>From<select disabled={!canEdit||busy} value={fromLocation} onChange={event=>setFromLocation(event.target.value)}><option value="">Select location</option>{fromLocationOptions.map(location=><option key={location.id} value={location.id}>{location.name}{location.description?` — ${location.description}`:''}</option>)}</select></label><label>To<select disabled={!canEdit||busy} value={toLocation} onChange={event=>{setToLocation(event.target.value);setSelected({})}}><option value="">Select vehicle</option>{toLocationOptions.map(location=><option key={location.id} value={location.id}>{location.vehicle_name} (vehicle for {location.name})</option>)}</select></label><div className="stock-sort-actions"><span>Order by supply</span><button className={supplySort==='er'?'secondary active':'secondary'} onClick={()=>setSupplySort(supplySort==='er'?'none':'er')}>ER Supply ↓</button><button className={supplySort==='pta'?'secondary active':'secondary'} onClick={()=>setSupplySort(supplySort==='pta'?'none':'pta')}>PT Supply ↓</button></div><label className="stock-comments-field">Comments <b className="required-mark" aria-hidden="true"> *</b><input disabled={!canEdit||busy} required maxLength={1000} value={comments} onChange={event=>setComments(event.target.value)} placeholder="Required for export"/></label><button className="primary" disabled={!canEdit||busy||!activeBatchId} onClick={()=>void exportRows()}><Download size={16}/>{busy?'Saving…':'Save and export'}</button></div>
    <div className="rfq-table-wrap"><table className="rfq-table stock-booking-table"><thead><tr><th>Franchise</th><th>Part No</th><th>Description</th><th>Unit size</th><th className={selectedDestination?.supply_branch==='er'?'stock-supply-highlight':''} style={selectedDestination?.supply_branch==='er'?{backgroundColor:selectedDestination.color}:undefined}>Supply ER</th><th>On picking slip ER</th><th>QOH ER / Max ER</th><th className={selectedDestination?.supply_branch==='pta'?'stock-supply-highlight':''} style={selectedDestination?.supply_branch==='pta'?{backgroundColor:selectedDestination.color}:undefined}>Supply PTA</th><th>On picking slip PTA</th><th>QOH PTA / Max PTA</th><th style={selectedSource?{backgroundColor:selectedSource.color}:undefined}>QOH WH / Max WH</th><th>Book</th></tr></thead><tbody>{visible.map(item=>{const noWarehouseStock=item.qoh_wh<=0;const erShort=item.qoh_wh<item.qoh_er;const ptaShort=item.qoh_wh<item.qoh_pta;return <tr className={`rfq-data-row ${noWarehouseStock?'stock-row-no-warehouse':''}`} key={item.id}><td>{item.franchise||'—'}</td><td>{item.part_number}</td><td>{item.description}</td><td>{item.unit_size||'—'}</td><td className={selectedDestination?.supply_branch==='er'?'stock-supply-highlight':''} style={selectedDestination?.supply_branch==='er'?{backgroundColor:selectedDestination.color}:undefined}>{supplyEr(item)}</td><td className={item.on_picking_slip_er>0?'stock-cell-picking-slip':''}>{item.on_picking_slip_er}</td><td className={erShort?'stock-cell-short':''}>{item.qoh_er} / {item.max_er}</td><td className={selectedDestination?.supply_branch==='pta'?'stock-supply-highlight':''} style={selectedDestination?.supply_branch==='pta'?{backgroundColor:selectedDestination.color}:undefined}>{supplyPta(item)}</td><td className={item.on_picking_slip_pta>0?'stock-cell-picking-slip':''}>{item.on_picking_slip_pta}</td><td className={ptaShort?'stock-cell-short':''}>{item.qoh_pta} / {item.max_pta}</td><td style={selectedSource?{backgroundColor:selectedSource.color}:undefined}>{item.qoh_wh} / {item.max_wh}</td><td><input className="stock-booking-qty" aria-label={`Book ${item.part_number}`} disabled={!canEdit||busy||noWarehouseStock} type="number" min="0" max={Math.max(0,item.qoh_wh)} step="1" value={selected[item.id]||''} onChange={event=>setSelected(previous=>({...previous,[item.id]:event.target.value}))}/></td></tr>})}{!visible.length&&<tr><td colSpan={12}><div className="rfq-empty"><PackageCheck size={28}/><h3>No active stock items available</h3><p>Import and activate the latest stock list to begin booking.</p></div></td></tr>}</tbody></table></div>
    <div className="settings-card stock-transfer-history"><h3>Recent transfer exports</h3>{!history.length?<p>No Stock Booking transfers have been exported.</p>:<div className="config-list">{history.map(batch=><div className="config-row" key={batch.id}><span><b>{batch.reference}</b><small>{batch.from_location} → {batch.to_location} · {batch.item_count} item{batch.item_count===1?'':'s'} · {new Date(batch.created_at).toLocaleString()}</small><small>{batch.remarks}</small></span><div className="stock-config-actions"><span className="roadmap-status complete">Exported</span><button className="secondary" disabled={busy} onClick={()=>void redownload(batch.id)}><Download size={14}/>Download again</button></div></div>)}</div>}</div>
  </section>
}
