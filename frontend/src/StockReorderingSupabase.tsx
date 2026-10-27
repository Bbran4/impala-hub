import {useCallback,useDeferredValue,useEffect,useMemo,useState} from 'react'
import {ChevronLeft,ChevronRight,PackageSearch,RefreshCw,Search} from 'lucide-react'
import {supabase} from './supabase'
import {
  filterAndSortStockReordering,loadStockReorderingWorkspace,type MoverFilter,
  type ReorderingSort,type StockReorderingItem,type SupplyFilter,
} from './stockReorderingData'

type Props={token:string;setNotice:(message:string)=>void;setError:(message:string)=>void}
const PAGE_SIZE=200
const money=(value:number|null)=>value==null?'—':`R${Number(value).toFixed(2)}`
const number=(value:number)=>Number(value).toLocaleString(undefined,{maximumFractionDigits:4})

export default function StockReorderingSupabase({setNotice,setError}:Props){
  const [items,setItems]=useState<StockReorderingItem[]>([]);const [search,setSearch]=useState('');const [supplierType,setSupplierType]=useState('')
  const [moverFilter,setMoverFilter]=useState<MoverFilter>('all');const [supplyFilter,setSupplyFilter]=useState<SupplyFilter>(null)
  const [slowMax,setSlowMax]=useState(2);const [abMin,setAbMin]=useState(10);const [snapshot,setSnapshot]=useState<{source_name:string;activated_at:string}|null>(null)
  const [sort,setSort]=useState<ReorderingSort>({key:'part_number',direction:'asc'});const [page,setPage]=useState(1);const [busy,setBusy]=useState(true)
  const deferredSearch=useDeferredValue(search)
  const load=useCallback(async()=>{
    if(!supabase){setError('Supabase is not configured.');setBusy(false);return}
    setBusy(true)
    try{const workspace=await loadStockReorderingWorkspace(supabase);setItems(workspace.items);setSlowMax(Number(workspace.settings.slow_max_avg_sales));setAbMin(Number(workspace.settings.ab_min_avg_sales));setSnapshot(workspace.activeSnapshot);setError('');setNotice('')}
    catch(error){setError((error as Error).message)}finally{setBusy(false)}
  },[setError,setNotice])
  useEffect(()=>{void load()},[load])
  const filtered=useMemo(()=>filterAndSortStockReordering(items,{search:deferredSearch,supplierType,mover:moverFilter,supply:supplyFilter},sort),[items,deferredSearch,supplierType,moverFilter,supplyFilter,sort])
  const pageCount=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));const visible=filtered.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE)
  useEffect(()=>{setPage(1)},[search,supplierType,moverFilter,supplyFilter,sort.key,sort.direction])
  useEffect(()=>{if(page>pageCount)setPage(pageCount)},[page,pageCount])
  const header=(label:string,key:keyof StockReorderingItem)=><th data-sort={key} onClick={()=>setSort(current=>current.key===key?{key,direction:current.direction==='asc'?'desc':'asc'}:{key,direction:'asc'})}>{label}{sort.key===key?(sort.direction==='asc'?' ↑':' ↓'):''}</th>
  return <section className="rfq-workspace">
    <div className="sd-session-bar"><PackageSearch size={18}/><span>Smart Stock Control workspace</span><div className="sd-view-tabs"><button className="active">Stock Reordering</button></div>{snapshot&&<small>{snapshot.source_name} · activated {new Date(snapshot.activated_at).toLocaleString()}</small>}</div>
    {!snapshot&&<div className="stock-import-validation invalid"><b>No active stock snapshot is available. Import and activate Booking and Reordering data first.</b></div>}
    <div className="rfq-toolbar buyouts-toolbar"><label className="rfq-search"><Search size={15}/>Search<input placeholder="Search part number, description, supplier, or alt number" value={search} onChange={event=>setSearch(event.target.value)}/></label><label>Supplier type<select value={supplierType} onChange={event=>setSupplierType(event.target.value)}><option value="">All suppliers</option><option value="local">Local suppliers</option><option value="international">International suppliers</option></select></label><div className="stock-mover-actions"><span>Shared avg sales thresholds</span><button className={moverFilter==='ab'?'secondary active':'secondary'} onClick={()=>setMoverFilter(moverFilter==='ab'?'all':'ab')}>A&amp;B Movers ≥ {number(abMin)}</button><button className={moverFilter==='slow'?'secondary active':'secondary'} onClick={()=>setMoverFilter(moverFilter==='slow'?'all':'slow')}>Slow Movers ≤ {number(slowMax)}</button></div><div className="stock-mover-actions"><span>Supply %</span><button className={supplyFilter===25?'secondary active':'secondary'} onClick={()=>setSupplyFilter(supplyFilter===25?null:25)}>25% or less</button><button className={supplyFilter===50?'secondary active':'secondary'} onClick={()=>setSupplyFilter(supplyFilter===50?null:50)}>50% or less</button></div><button className="secondary" disabled={busy} onClick={()=>void load()}><RefreshCw size={15}/>{busy?'Loading…':'Refresh'}</button></div>
    <div className="stock-results-bar"><span>{filtered.length.toLocaleString()} of {items.length.toLocaleString()} records</span>{pageCount>1&&<div className="stock-pagination"><button className="secondary" disabled={page<=1} onClick={()=>setPage(value=>Math.max(1,value-1))}><ChevronLeft size={15}/>Previous</button><span>Page {page} of {pageCount}</span><button className="secondary" disabled={page>=pageCount} onClick={()=>setPage(value=>Math.min(pageCount,value+1))}>Next<ChevronRight size={15}/></button></div>}</div>
    <div className="rfq-table-wrap"><table className="rfq-table stock-reordering-table"><thead><tr>{header('Franchise','franchise')}{header('Part Number','part_number')}{header('Description','description')}<th>Alt 1</th><th>Alt 2</th><th>Alt 3</th><th>Alt 4</th>{header('QOH ER','qoh_er')}{header('Safety ER','safety_er')}{header('QOH PTA','qoh_pta')}{header('Safety PTA','safety_pta')}{header('QOH WH','qoh_wh')}{header('Safety WH','safety_wh')}{header('Global Safety','global_safety')}{header('Supply %','supply_percentage')}{header('Qty on Order','qty_on_order')}{header('Qty to Order','qty_to_order')}{header('Lead Time','lead_time')}{header('Avg Sales','avg_sales')}{header('Sales this month','sales_this_month')}{header('Gauge','gauge')}{header('Supplier','supplier')}{header('Last cost','last_cost')}</tr></thead><tbody>{visible.map(item=><tr className="rfq-data-row" key={item.id}><td>{item.franchise||'—'}</td><td>{item.part_number}</td><td>{item.description}</td><td>{item.alt_1||'—'}</td><td>{item.alt_2||'—'}</td><td>{item.alt_3||'—'}</td><td>{item.alt_4||'—'}</td><td>{number(item.qoh_er)}</td><td>{number(item.safety_er)}</td><td>{number(item.qoh_pta)}</td><td>{number(item.safety_pta)}</td><td>{number(item.qoh_wh)}</td><td>{number(item.safety_wh)}</td><td>{number(item.global_safety)}</td><td>{Number(item.supply_percentage).toFixed(1)}%</td><td>{number(item.qty_on_order)}</td><td>{number(item.qty_to_order)}</td><td>{item.lead_time||'—'}</td><td>{number(item.avg_sales)}</td><td>{number(item.sales_this_month)}</td><td>{item.gauge||'—'}</td><td>{item.supplier||'—'}</td><td>{money(item.last_cost)}</td></tr>)}{!visible.length&&<tr><td colSpan={23}><div className="rfq-empty"><PackageSearch size={28}/><h3>No reordering records</h3><p>{snapshot?'Adjust the filters or import refreshed stock data.':'Import and activate stock data to populate this workspace.'}</p></div></td></tr>}</tbody></table></div>
  </section>
}
