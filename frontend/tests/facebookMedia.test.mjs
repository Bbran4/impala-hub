import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFacebookMedia } from '../api/marketing/facebook/_media.ts'

function storage(cached=[]) {
 const uploads=[]
 const bucket={getPublicUrl:p=>({data:{publicUrl:'https://project.supabase.co/storage/v1/object/public/marketing-media/'+p}}),
  async list(){return {data:cached,error:null}},async upload(path,data,options){uploads.push({path,data,options});return {error:null}}}
 return {admin:{storage:{from:()=>bucket}},uploads}
}
test('provider images become stable bucket URLs and reuse cached objects', async () => {
 const old=globalThis.fetch;let calls=0
 globalThis.fetch=async()=>{calls++;return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}})}
 try {
  const one=storage();const a=await copyFacebookMedia(one.admin,'page_post',['https://scontent.fbcdn.net/image?sig=one'])
  assert.equal(one.uploads.length,1);assert.match(a.media[0].url,/project.supabase.co/);assert.ok(!a.media[0].url.includes('sig='))
  const two=storage([{name:one.uploads[0].path.split('/').at(-1)}]);const b=await copyFacebookMedia(two.admin,'page_post',['https://scontent.fbcdn.net/image?sig=two'])
  assert.deepEqual(a.media,b.media);assert.equal(calls,1);assert.equal(two.uploads.length,0)
 } finally {globalThis.fetch=old}
})
test('unsafe hosts, redirected private addresses and oversized images never persist provider URLs', async () => {
 const old=globalThis.fetch
 try {
  globalThis.fetch=async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})
  const db=storage();const a=await copyFacebookMedia(db.admin,'post',['https://scontent.fbcdn.net/image','https://fbcdn.net.evil.invalid/image'])
  assert.equal(a.unavailable,2);assert.deepEqual(a.media,[]);assert.equal(db.uploads.length,0)
  globalThis.fetch=async()=>new Response('too big',{headers:{'content-type':'image/jpeg','content-length':String(11*1024*1024)}})
  const b=await copyFacebookMedia(db.admin,'post',['https://scontent.fbcdn.net/image'])
  assert.deepEqual(b.media,[]);assert.equal(b.unavailable,1)
 } finally {globalThis.fetch=old}
})

test('streamed size limits and failed uploads retain only existing bucket images', async () => {
 const old=globalThis.fetch
 try {
  globalThis.fetch=async()=>new Response(new Uint8Array(10*1024*1024+1),{headers:{'content-type':'image/jpeg'}})
  const db=storage()
  const retained={id:'saved',url:'https://project.supabase.co/storage/v1/object/public/marketing-media/saved.jpg'}
  const result=await copyFacebookMedia(db.admin,'post',['https://scontent.fbcdn.net/image'],[retained,{id:'expired',url:'https://scontent.fbcdn.net/expired?sig=old'}])
  assert.equal(result.unavailable,1);assert.deepEqual(result.media,[retained]);assert.equal(db.uploads.length,0)
 } finally {globalThis.fetch=old}
})
