import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Exercise the actual controlled form and button handlers without a browser or
// live backend. The hook adapter retains state/dependencies between renders.
const bundled = await build({
  stdin: {contents:"export {RfqPanel} from './src/SalesDesk.tsx'",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'tsx'},
  bundle:true,write:false,platform:'node',format:'esm',target:'es2022',jsx:'automatic',
  define:{'import.meta.env':'{}'},loader:{'.css':'empty'},
  plugins:[{name:'form-hooks',setup(builder){
    builder.onResolve({filter:/^react$/},args=>args.importer.endsWith('SalesDesk.tsx')?{path:'hooks',namespace:'test-hooks'}:undefined)
    builder.onLoad({filter:/.*/,namespace:'test-hooks'},()=>({contents:`
      export const useState=(...args)=>globalThis.__rfqFormHooks.state(...args);
      export const useMemo=(...args)=>globalThis.__rfqFormHooks.memo(...args);
      export const useCallback=(fn,deps)=>globalThis.__rfqFormHooks.memo(()=>fn,deps);
      export const useEffect=(...args)=>globalThis.__rfqFormHooks.effect(...args);
    `}))
  }}],
})
const bundlePath=path.join(tmpdir(),`rfq-form-${randomUUID()}.mjs`)
writeFileSync(bundlePath,bundled.outputFiles[0].text)
let RfqPanel
try { ({RfqPanel}=await import(pathToFileURL(bundlePath).href)) } finally { unlinkSync(bundlePath) }
const originalWindow=globalThis.window
const tick=()=>new Promise(resolve=>setImmediate(resolve))
after(()=>{delete globalThis.__rfqFormHooks; if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow})
function fixture({document='DOC-1',attachments=[{id:'attachment',original_name:'quote.pdf',content_type:'application/pdf',size:100,storage_path:'quote.pdf',created_at:'2026-11-01T08:00:00Z'}],closed=true}={}) {
  let index=0,slots=[],effects=[],tree
  const same=(a,b)=>Boolean(a&&b&&a.length===b.length&&a.every((value,i)=>Object.is(value,b[i])))
  const hooks={
    state(initial){const id=index++;if(!(id in slots))slots[id]={value:typeof initial==='function'?initial():initial};return [slots[id].value,value=>{slots[id].value=typeof value==='function'?value(slots[id].value):value}]},
    memo(factory,deps){const id=index++;if(!slots[id]||!same(slots[id].deps,deps))slots[id]={value:factory(),deps};return slots[id].value},
    effect(callback,deps){const id=index++;if(!slots[id]||!same(slots[id].deps,deps)){slots[id]={deps};effects.push(callback)}},
  }
  globalThis.__rfqFormHooks=hooks
  globalThis.window={addEventListener(){},removeEventListener(){},confirm:()=>true}
  let saved={id:'rfq',rfq_no:'IMP26110101',rfq_type:'quotation',status_id:'working',customer_name:'Customer',received_at:'2026-11-01T08:00:00Z',sales_code_id:'code',sales_code:'SALES',document_number:document,remarks:'',attachments,approval_state:'not_requested'}
  const sent=[],updates=[],errors=[]
  const service={detail:async()=>({...saved}),update:async(...args)=>{updates.push(args);return saved},sendForApproval:async(id,values)=>{sent.push([id,values]);saved={...saved,...values,approval_state:'pending'};return saved}}
  const props={mode:'edit',rfqId:'rfq',token:'test',user:{id:'consultant',role:'salesperson',sales_code:'SALES',can_request_approval:true},config:{statuses:[{id:'working',name:'In Progress',metric_category:'in_progress',is_closed:false,is_active:true},{id:'complete',name:'Complete',metric_category:'completed',is_closed:closed,is_active:true}],media_platforms:[],sales_codes:[]},service,onClose(){},onChanged:async()=>{},setNotice(){},setError:message=>errors.push(message)}
  const render=()=>{index=0;tree=RfqPanel(props);const run=effects;effects=[];for(const effect of run)effect();return tree}
  function find(predicate,node){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const child of node){const found=find(predicate,child);if(found)return found}return null}if(predicate(node))return node;if(node.props?.children===undefined)return null;return find(predicate,node.props.children)}
  const field=id=>find(node=>node.props?.id===id,tree)
  const button=()=>find(node=>node.type==='button'&&node.props.children==='Send for Approval',tree)
  return {render,field,button,sent,updates,errors,get saved(){return saved}}
}
test('Completed enables approval before saving, switching away disables it, and Send includes all unsaved consultant edits',async()=>{
 const f=fixture();f.render();await tick();f.render()
 assert.equal(f.button().props.disabled,true)
 f.field('rfq-status').props.onChange({target:{value:'complete'}});f.render()
 assert.equal(f.button().props.disabled,false)
 assert.equal(f.saved.status_id,'working','status selection did not save the RFQ')
 assert.equal(f.sent.length,0)
 f.field('rfq-status').props.onChange({target:{value:'working'}});f.render()
 assert.equal(f.button().props.disabled,true)
 f.field('rfq-status').props.onChange({target:{value:'complete'}})
 f.field('rfq-doc').props.onChange({target:{value:'DOC-UPDATED'}})
 f.field('rfq-remarks').props.onChange({target:{value:'Ready for approval'}})
 f.render();assert.equal(f.button().props.disabled,false)
 f.button().props.onClick();await tick();f.render()
 assert.deepEqual(f.sent,[['rfq',{status_id:'complete',document_number:'DOC-UPDATED',remarks:'Ready for approval'}]])
 assert.equal(f.updates.length,0,'one transactional submission saves and requests approval')
 assert.equal(f.saved.status_id,'complete')
 assert.equal(f.saved.approval_state,'pending')
 assert.equal(f.button().props.disabled,true,'pending unchanged submission cannot be sent twice')
})
test('Completed selection enables the button despite missing details; submission shows validation rather than sending',async()=>{
 for(const options of [{document:''},{attachments:[]}]) {
  const f=fixture(options);f.render();await tick();f.render()
  f.field('rfq-status').props.onChange({target:{value:'complete'}});f.render()
  assert.equal(f.button().props.disabled,false)
  f.button().props.onClick();await tick();f.render()
  assert.equal(f.sent.length,0)
  assert.ok(f.errors.some(message=>/document/i.test(message)))
 }
})
test('Completed outcome controls unsaved readiness even when a cached closed flag is stale',async()=>{
 const f=fixture({closed:false});f.render();await tick();f.render()
 f.field('rfq-status').props.onChange({target:{value:'complete'}});f.render()
 assert.equal(f.button().props.disabled,false)
 f.field('rfq-status').props.onChange({target:{value:'working'}});f.render()
 assert.equal(f.button().props.disabled,true)
})
