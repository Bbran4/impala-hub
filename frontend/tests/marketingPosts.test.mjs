import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPostPage, safeMarketingFilename } from '../src/marketingPosts.ts'

test('post page sends all filters to one bounded database command', async () => {
  const client={async rpc(name,args) {
    assert.equal(name,'marketing_post_page')
    assert.deepEqual(args,{p_month:'2021-01-01',p_campaign:null,p_unassigned:true,p_search:'Launch',p_status:'published',p_channel:null,p_offset:100,p_limit:50,p_preview:false,p_summary:true})
    return {data:{items:[],total:1205,summary:[]},error:null}
  }}
  assert.equal((await loadPostPage(client,{month:'2021-01-01',campaign:'none',search:' Launch ',status:'engagements',offset:100,summary:true})).total,1205)
})
test('post query errors are not presented as empty success', async () => {
  await assert.rejects(loadPostPage({async rpc(){return {error:{message:'database unavailable'}}}}),/database unavailable/)
})
test('upload storage names remove paths, control characters and unsafe names', () => {
  for(const name of ['../../test.jpg','C:\\uploads\\.hidden photo.jpg','\u0000\n../x.jpg','...', 'photo?size=2.jpg', 'a'.repeat(300)+'.png']) {
    const safe=safeMarketingFilename(name)
    assert.match(safe,/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/)
    assert.ok(safe.length<=100)
  }
})
