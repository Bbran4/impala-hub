import {test} from 'node:test'
import assert from 'node:assert/strict'
import {fitMap,insights,orgTree,parseRowStyles,project,sankeyLayout,visibleTiles} from '../src/biChartMath.ts'

test('sankey flows keep their totals',()=>{
  const p=(...labels)=>labels.map(label=>({value:label,label}))
  const layout=sankeyLayout([{path:p('Centurion','Engine'),v:6},{path:p('Centurion','Brakes'),v:2},{path:p('Pretoria','Engine'),v:4},{path:p('Pretoria','Brakes'),v:0}],200,10)
  assert.equal(layout.columns,2)
  const node=label=>layout.nodes.find(n=>n.label===label)
  assert.equal(node('Engine').total,10);assert.equal(node('Centurion').total,8);assert.equal(node('Pretoria').total,4)
  assert.equal(layout.links.length,3)
  const scale=node('Engine').h/10
  assert.ok(Math.abs(node('Centurion').h-8*scale)<1e-9)
  assert.ok(node('Engine').y<node('Brakes').y,'larger nodes first')
})

test('org chart builds a tree, adds missing parents and breaks loops',()=>{
  const tree=orgTree([{id:'Engine',parent:'Impala',data:1},{id:'Brakes',parent:'Impala',data:2},{id:'Filters',parent:'Engine',data:3}],id=>0)
  assert.equal(tree.roots.length,1);assert.equal(tree.roots[0].id,'Impala');assert.equal(tree.depth,3);assert.equal(tree.width,2)
  assert.equal(tree.roots[0].x,(tree.roots[0].children[0].x+tree.roots[0].children[1].x)/2)
  const loop=orgTree([{id:'A',parent:'B',data:0},{id:'B',parent:'A',data:0}])
  assert.equal(loop.roots.length,1)
})

test('map maths: projection, fitting and tiles',()=>{
  const z=project(0,0,0);assert.ok(Math.abs(z.x-128)<1e-9&&Math.abs(z.y-128)<1e-9)
  const pts=[{lat:-25.86,lon:28.19},{lat:-26.2,lon:28.04}]
  const view=fitMap(pts,600,400)
  const ps=pts.map(p=>project(p.lat,p.lon,view.zoom))
  for(const p of ps){assert.ok(Math.abs(p.x-view.cx)<=300&&Math.abs(p.y-view.cy)<=200)}
  assert.ok(view.zoom>=8&&view.zoom<=12)
  const tiles=visibleTiles(view.zoom,view.cx,view.cy,600,400)
  assert.ok(tiles.length>=4&&tiles.every(t=>t.url.startsWith('https://tile.openstreetmap.org/'+view.zoom+'/')))
})

test('insights describe totals, leaders and changes',()=>{
  const lines=insights([{label:'2026-07',v:100},{label:'2026-08',v:300},{label:'2026-09',v:150},{label:'2026-10',v:180}],{measure:'Sales',dimension:'Month',format:v=>String(Math.round(v)),ordered:true})
  assert.match(lines[0],/Sales is 730 in total across 4 values of Month/)
  assert.match(lines[1],/2026-08 is the highest with 300 \(41% of the total\)/)
  assert.match(lines.join(' '),/From 2026-09 to 2026-10, Sales rose 20%/)
  assert.match(lines.join(' '),/biggest change was from 2026-07 to 2026-08 \(\+200\)/)
  assert.deepEqual(insights([],{measure:'x',dimension:'y',format:String}),[])
})

test('P&L row styles',()=>{
  assert.deepEqual(parseRowStyles('Sales: bold\nGross profit: bold, line\n\nExpenses\nTotal: weird, highlight'),[
    {label:'Sales',style:{bold:true}},{label:'Gross profit',style:{bold:true,line:true}},{label:'Expenses',style:{}},{label:'Total',style:{highlight:true}}])
})
