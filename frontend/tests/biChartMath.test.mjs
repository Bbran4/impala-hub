import {test} from 'node:test'
import assert from 'node:assert/strict'
import {histogramBins,quartiles,squarify} from '../src/biChartMath.ts'

test('treemap tiles fill the area in proportion to their values',()=>{
  const tiles=squarify([{v:6},{v:6},{v:4},{v:3},{v:2},{v:2},{v:1}],{x:0,y:0,w:600,h:400})
  assert.equal(tiles.length,7)
  const total=24
  for(const tile of tiles){
    assert.ok(Math.abs(tile.w*tile.h-tile.v/total*600*400)<1e-6,'area matches value')
    assert.ok(tile.x>=-1e-9&&tile.y>=-1e-9&&tile.x+tile.w<=600+1e-6&&tile.y+tile.h<=400+1e-6,'inside the area')
  }
  assert.deepEqual(squarify([{v:0},{v:-2}],{x:0,y:0,w:10,h:10}),[])
})

test('histogram bins use round widths and count every record',()=>{
  const bins=histogramBins([{v:1,n:2},{v:9,n:1},{v:23,n:4},{v:47,n:1}],5)
  assert.equal(bins.reduce((s,b)=>s+b.n,0),8)
  assert.deepEqual(bins.map(b=>b.from),[0,10,20,30,40])
  assert.deepEqual(bins.map(b=>b.n),[3,0,4,0,1])
  assert.deepEqual(histogramBins([{v:5,n:3}]),[{from:5,to:5,n:3,values:[5]}])
  assert.deepEqual(histogramBins([]),[])
})

test('box plot statistics',()=>{
  const st=quartiles([1,2,3,4,5,6,7,8,100])
  assert.equal(st.median,5);assert.equal(st.q1,3);assert.equal(st.q3,7)
  assert.equal(st.high,8);assert.equal(st.low,1);assert.deepEqual(st.outliers,[100]);assert.equal(st.count,9)
})
