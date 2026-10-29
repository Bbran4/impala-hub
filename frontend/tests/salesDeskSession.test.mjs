import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSalesDeskSessionCache } from '../src/salesDeskSession.ts'

const session=(id='user',sid='session')=>({user:{id},access_token:`header.${btoa(JSON.stringify({session_id:sid}))}.signature`})
function fixture() {
 let current=session(),calls=0,failing=false
 const client={auth:{async getSession(){return {data:{session:current},error:null}}},async rpc(name){assert.equal(name,'sales_desk_session_context');calls++;return failing?{error:{message:'Denied'}}:{data:{id:current.user.id,role:'administrator'}}}}
 return {cache:createSalesDeskSessionCache(client),get calls(){return calls},set current(value){current=value},set failing(value){failing=value}}
}
test('concurrent Sales Desk calls share one context lookup, including token refresh and repeated sign-in events',async()=>{
 const f=fixture();await Promise.all([f.cache.get(),f.cache.get(),f.cache.get()]);assert.equal(f.calls,1)
 f.cache.authChanged('TOKEN_REFRESHED',session());f.cache.authChanged('SIGNED_IN',session());await f.cache.get();assert.equal(f.calls,1)
})
test('a new session, user change or sign-out invalidates cached context',async()=>{
 const f=fixture();await f.cache.get();f.current=session('user','new-session');await f.cache.get();assert.equal(f.calls,2)
 f.current=session('other');await f.cache.get();assert.equal(f.calls,3)
 f.cache.authChanged('SIGNED_OUT',null);f.current=null;await assert.rejects(f.cache.get(),/Sign in again/)
})
test('failed context loads are retryable and profile updates invalidate display data',async()=>{
 const f=fixture();f.failing=true;await assert.rejects(f.cache.get(),/Denied/);f.failing=false;await f.cache.get();assert.equal(f.calls,2)
 f.cache.authChanged('USER_UPDATED',session());await f.cache.get();assert.equal(f.calls,3)
})
