import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildStockBookingCsv,createStockBookingTransfer,prepareStockTransferRows,stockBookingFilename} from '../src/stockBookingData.ts'

const item=(overrides={})=>({id:'item-1',import_batch_id:'batch-1',franchise:'generic',part_number:'P-1',description:'Part',unit_size:'each',supply_er:3,on_picking_slip_er:0,qoh_er:2,max_er:5,supply_pta:2,on_picking_slip_pta:0,qoh_pta:3,max_pta:5,qoh_wh:10,max_wh:20,bin_er:'ER-1',bin_pta:'PT-1',bin_wh:'WH-1',...overrides})

test('booking quantities are whole, positive and bounded by warehouse stock',()=>{
  assert.deepEqual(prepareStockTransferRows([item()],{'item-1':'4'}),[{stock_booking_item_id:'item-1',transfer_qty:4}])
  assert.throws(()=>prepareStockTransferRows([item()],{'item-1':'1.5'}),/whole number/i)
  assert.throws(()=>prepareStockTransferRows([item()],{'item-1':'11'}),/cannot exceed warehouse stock/i)
  assert.throws(()=>prepareStockTransferRows([item()],{'item-1':'0'}),/at least one/i)
})

test('Evolve CSV preserves columns, quotes values and neutralizes formula text',()=>{
  const csv=buildStockBookingCsv([{franchise:'=cmd',part_number:'P,"1"',from_location:'10',from_bin_location:'WH-1',to_location:'ERBAKKIE',to_bin_location:'ER-1',transfer_qty:2,remarks:'+unsafe'}])
  assert.ok(csv.startsWith('\uFEFF'))
  assert.match(csv,/"Franchise","Part Number","From Location","From Bin Location","To Location","To Bin Location","Transfer Qty","Remarks"\r\n/)
  assert.match(csv,/"'=cmd","P,""1""","10","WH-1","ERBAKKIE","ER-1","2","'\+unsafe"\r\n$/)
})

test('booking filename uses branch and local timestamp',()=>{
  const date=new Date(2026,9,27,14,5)
  assert.equal(stockBookingFilename('er',date),'20261027ER1405.csv')
  assert.equal(stockBookingFilename('pta',date),'20261027PT1405.csv')
})

test('transfer creation trims remarks and sends snapshot-bound RPC arguments',async()=>{
  let call
  const client={rpc:async(name,args)=>{call={name,args};return {data:{id:'transfer-1',items:[]},error:null}}}
  const saved=await createStockBookingTransfer(client,{activeBatchId:'batch-1',fromLocationId:'from-1',toLocationId:'to-1',remarks:'  Move stock  ',rows:[{stock_booking_item_id:'item-1',transfer_qty:2}]})
  assert.equal(saved.id,'transfer-1')
  assert.deepEqual(call,{name:'create_stock_booking_transfer',args:{p_import_batch_id:'batch-1',p_from_location_id:'from-1',p_to_location_id:'to-1',p_remarks:'Move stock',p_rows:[{stock_booking_item_id:'item-1',transfer_qty:2}]}})
})

