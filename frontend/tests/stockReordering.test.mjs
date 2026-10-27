import {test} from 'node:test'
import assert from 'node:assert/strict'
import {filterAndSortStockReordering,matchesStockReordering,sortStockReordering} from '../src/stockReorderingData.ts'

const row=(overrides={})=>({id:'1',import_batch_id:'batch',franchise:'generic',part_number:'P-2',description:'Brake pad',alt_1:'ALT-9',alt_2:'',alt_3:'',alt_4:'',qoh_er:10,safety_er:2,qoh_pta:15,safety_pta:2,qoh_wh:25,safety_wh:5,global_safety:100,qty_on_order:1,qty_to_order:2,lead_time:'4 days',avg_sales:1,sales_this_month:3,gauge:'A',supplier:'Local Parts',last_cost:12.5,supplier_type:'local',source_name:'stock.xlsx',snapshot_activated_at:'2026-10-27T10:00:00Z',slow_max_avg_sales:2,ab_min_avg_sales:10,supply_percentage:50,is_slow_mover:true,is_ab_mover:false,...overrides})

test('reordering search covers parts, descriptions, suppliers and alternatives',()=>{
  const item=row()
  for(const search of ['p-2','brake','local parts','alt-9'])assert.equal(matchesStockReordering(item,{search,supplierType:'',mover:'all',supply:null}),true)
  assert.equal(matchesStockReordering(item,{search:'missing',supplierType:'',mover:'all',supply:null}),false)
})

test('shared mover and supply boundaries filter exactly',()=>{
  const slow=row({supply_percentage:25,is_slow_mover:true,is_ab_mover:false})
  const ab=row({id:'2',part_number:'P-10',avg_sales:10,supply_percentage:50,is_slow_mover:false,is_ab_mover:true,supplier_type:'international'})
  assert.deepEqual(filterAndSortStockReordering([ab,slow],{search:'',supplierType:'',mover:'slow',supply:25},{key:'part_number',direction:'asc'}).map(item=>item.id),['1'])
  assert.deepEqual(filterAndSortStockReordering([ab,slow],{search:'',supplierType:'international',mover:'ab',supply:50},{key:'part_number',direction:'asc'}).map(item=>item.id),['2'])
})

test('numeric sorting is numeric and uses part number as the stable tie break',()=>{
  const items=[row({id:'a',part_number:'P-10',qty_to_order:2}),row({id:'b',part_number:'P-2',qty_to_order:10}),row({id:'c',part_number:'P-1',qty_to_order:2})]
  assert.deepEqual(sortStockReordering(items,{key:'qty_to_order',direction:'asc'}).map(item=>item.id),['c','a','b'])
  assert.deepEqual(sortStockReordering(items,{key:'qty_to_order',direction:'desc'}).map(item=>item.id),['b','a','c'])
})

