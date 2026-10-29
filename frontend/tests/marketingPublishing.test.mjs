import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { claimPost, publishClaimed, facebookMediaId } from '../api/marketing/facebook/_publishing.ts'

test('media identity is stable across syncs and expiring URL signatures', () => {
  assert.equal(facebookMediaId('post','https://cdn/image?token=old'),facebookMediaId('post','https://cdn/image?token=new'))
  assert.notEqual(facebookMediaId('post','https://cdn/image'),facebookMediaId('post','https://cdn/other'))
})

const key = crypto.randomBytes(32)
const iv = crypto.randomBytes(12)
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
const encrypted = Buffer.concat([cipher.update('token'), cipher.final()])
const connection = { page_id: 'page', token_ciphertext: [iv, cipher.getAuthTag(), encrypted].map(x => x.toString('base64')).join('.') }
const secret = key.toString('base64')
const post = { id: 'one', status: 'draft', provider_ids: {}, caption: 'Hello', media: [] }

function database(initial = post, failReceipt = false) {
  const row = structuredClone(initial)
  return { row, from() {
    let values, filters = []
    const q = {
      update(v) { values = v; return q }, eq(k,v) { filters.push(() => row[k] === v); return q },
      in(k,v) { filters.push(() => v.includes(row[k])); return q },
      is(k,v) { filters.push(() => k === 'provider_ids->>facebook' ? (row.provider_ids.facebook ?? null) === v : row[k] === v); return q },
      lte(k,v) { filters.push(() => row[k] <= v); return q }, select() { return q },
      async maybeSingle() {
        if (failReceipt && values.status === 'published') return { error: new Error('database unavailable') }
        if (!filters.every(f => f())) return { data: null }
        Object.assign(row, values); return { data: structuredClone(row) }
      },
    }; return q
  } }
}

test('simultaneous manual/cron claims admit exactly one publisher; published posts cannot be reclaimed', async () => {
  const db = database()
  const claims = await Promise.all([claimPost(db,'one',['draft']),claimPost(db,'one',['draft'])])
  assert.equal(claims.filter(Boolean).length,1)
  db.row.status='published'; assert.equal(await claimPost(db,'one',['draft','failed']),null)
  db.row.status='failed'; db.row.provider_ids.facebook='already-live'
  assert.equal(await claimPost(db,'one',['failed']),null)
})

test('confirmed publish stores canonical photo post id and a bounded HTTP signal', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => { assert.ok(options.signal instanceof AbortSignal); return { ok:true, json:async()=>({id:'photo',post_id:'page_post'}) } }
  try {
    const db=database({...post,status:'publishing'})
    assert.equal((await publishClaimed(db,db.row,connection,secret)).facebook_post_id,'page_post')
    assert.equal(db.row.status,'published')
  } finally { globalThis.fetch=oldFetch }
})

for (const failure of ['timeout','receipt','rejection']) test(`publication handles ${failure} without unsafe retries`, async () => {
  const oldFetch=globalThis.fetch
  globalThis.fetch=async()=> {
    if(failure==='timeout') throw new Error('timeout')
    return failure==='rejection' ? {ok:false,status:400,json:async()=>({error:{message:'rejected'}})} : {ok:true,json:async()=>({id:'page_post'})}
  }
  try {
    const db=database({...post,status:'publishing'},failure==='receipt')
    const result=await publishClaimed(db,db.row,connection,secret)
    assert.equal(result.status,failure==='rejection'?'failed':'publish_unknown')
    if(result.status==='publish_unknown') assert.equal(await claimPost(db,'one',['failed','draft']),null)
  } finally { globalThis.fetch=oldFetch }
})
