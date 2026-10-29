import { loadAllRows } from './pagedRows.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadStockAccess, type StockAccess } from './stockPartsQueries.ts'

export type StockBookingItem = {
  id:string; import_batch_id:string; franchise:string; part_number:string; description:string; unit_size:string
  supply_er:number; on_picking_slip_er:number; qoh_er:number; max_er:number
  supply_pta:number; on_picking_slip_pta:number; qoh_pta:number; max_pta:number
  qoh_wh:number; max_wh:number; bin_pta:string; bin_er:string; bin_wh:string
}
export type StockLocation = { id:string; name:string; description:string; vehicle_name:string; supply_branch:''|'er'|'pta'; color:string; is_active:boolean }
export type StockTransferCsvRow = { franchise:string; part_number:string; from_location:string; from_bin_location:string; to_location:string; to_bin_location:string; transfer_qty:number; remarks:string }
export type StockTransferResult = { id:string; reference:string; import_batch_id:string; from_location:string; to_location:string; supply_branch:'er'|'pta'; remarks:string; item_count:number; items:StockTransferCsvRow[] }
export type StockTransferHistory = { id:string; reference:string; from_location:string; to_location:string; supply_branch:'er'|'pta'; remarks:string; item_count:number; created_at:string; created_by:string }

const bookingColumns='id,import_batch_id,franchise,part_number,description,unit_size,supply_er,on_picking_slip_er,qoh_er,max_er,supply_pta,on_picking_slip_pta,qoh_pta,max_pta,qoh_wh,max_wh,bin_pta,bin_er,bin_wh'

export async function loadStockBookingWorkspace(client:SupabaseClient):Promise<{items:StockBookingItem[];locations:StockLocation[];activeBatchId:string|null;access:StockAccess;history:StockTransferHistory[]}> {
  const [active,locations,access,history]=await Promise.all([
    client.from('stock_import_batches').select('id').eq('status','active').maybeSingle(),
    client.from('stock_locations').select('id,name,description,vehicle_name,supply_branch,color,is_active').eq('is_active',true).order('name'),
    loadStockAccess(client),
    client.from('stock_transfer_batches').select('id,reference,from_location,to_location,supply_branch,remarks,item_count,created_at,created_by').order('created_at',{ascending:false}).limit(10),
  ])
  for(const result of [active,locations,history])if(result.error)throw new Error(result.error.message)
  const activeBatchId=(active.data as {id:string}|null)?.id||null
  if(!activeBatchId)return {items:[],locations:(locations.data||[]) as StockLocation[],activeBatchId:null,access,history:(history.data||[]) as StockTransferHistory[]}
  const items=await loadAllRows((from,to)=>client.from('stock_booking_items').select(bookingColumns,{count:'exact'}).eq('import_batch_id',activeBatchId).order('part_number').order('id').range(from,to))
  return {items:(items.data||[]) as StockBookingItem[],locations:(locations.data||[]) as StockLocation[],activeBatchId,access,history:(history.data||[]) as StockTransferHistory[]}
}

export function prepareStockTransferRows(items:StockBookingItem[],selected:Record<string,number|string>) {
  const rows:{stock_booking_item_id:string;transfer_qty:number}[]=[]
  for(const item of items){
    const raw=selected[item.id]
    if(raw==null||raw==='')continue
    const qty=Number(raw)
    if(!Number.isInteger(qty)||qty<0)throw new Error(`Book quantity for ${item.part_number} must be a whole number.`)
    if(qty===0)continue
    if(qty>Math.max(0,item.qoh_wh))throw new Error(`Book quantity for ${item.part_number} cannot exceed warehouse stock (${Math.max(0,item.qoh_wh)}).`)
    rows.push({stock_booking_item_id:item.id,transfer_qty:qty})
  }
  if(!rows.length)throw new Error('Enter at least one East Rand or Pretoria booking quantity.')
  return rows
}

export async function createStockBookingTransfer(client:SupabaseClient,input:{activeBatchId:string;fromLocationId:string;toLocationId:string;remarks:string;rows:{stock_booking_item_id:string;transfer_qty:number}[]}) {
  const remarks=input.remarks.trim()
  if(!remarks)throw new Error('Enter a comment before exporting the picking list.')
  if(remarks.length>1000)throw new Error('Comments must be 1,000 characters or fewer.')
  const result=await client.rpc('create_stock_booking_transfer',{
    p_import_batch_id:input.activeBatchId,p_from_location_id:input.fromLocationId,
    p_to_location_id:input.toLocationId,p_remarks:remarks,p_rows:input.rows,
  })
  if(result.error)throw new Error(result.error.message)
  return result.data as StockTransferResult
}

export async function loadStockBookingTransfer(client:SupabaseClient,transferId:string):Promise<StockTransferResult> {
  const [batch,items]=await Promise.all([
    client.from('stock_transfer_batches').select('id,reference,import_batch_id,from_location,to_location,supply_branch,remarks,item_count').eq('id',transferId).single(),
    loadAllRows((from,to)=>client.from('stock_transfer_items').select('franchise,part_number,from_bin_location,to_bin_location,transfer_qty',{count:'exact'}).eq('transfer_batch_id',transferId).order('part_number').order('id').range(from,to)),
  ])
  if(batch.error)throw new Error(batch.error.message)
  const saved=batch.data as Omit<StockTransferResult,'items'>
  return {...saved,items:(items.data||[]).map((item:any)=>({...item,from_location:saved.from_location,to_location:saved.to_location,remarks:saved.remarks}))}
}

function safeCsvText(value:unknown) {
  let text=String(value??'')
  if(/^\s*[=+@]/.test(text)||/^\s*-[A-Za-z]/.test(text))text=`'${text}`
  return `"${text.replace(/"/g,'""')}"`
}

export function buildStockBookingCsv(rows:StockTransferCsvRow[]) {
  const header=['Franchise','Part Number','From Location','From Bin Location','To Location','To Bin Location','Transfer Qty','Remarks']
  const lines=[header,...rows.map(row=>[row.franchise,row.part_number,row.from_location,row.from_bin_location,row.to_location,row.to_bin_location,row.transfer_qty,row.remarks])]
  return `\uFEFF${lines.map(values=>values.map(safeCsvText).join(',')).join('\r\n')}\r\n`
}

export function stockBookingFilename(branch:'er'|'pta',now=new Date()) {
  const date=`${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`
  const time=`${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`
  return `${date}${branch==='pta'?'PT':'ER'}${time}.csv`
}

export function downloadStockBookingCsv(transfer:StockTransferResult) {
  const blob=new Blob([buildStockBookingCsv(transfer.items)],{type:'text/csv;charset=utf-8'})
  const url=URL.createObjectURL(blob);const link=document.createElement('a')
  link.href=url;link.download=stockBookingFilename(transfer.supply_branch);link.click();URL.revokeObjectURL(url)
}

