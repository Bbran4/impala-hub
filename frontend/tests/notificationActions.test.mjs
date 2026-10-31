import test from 'node:test'
import assert from 'node:assert/strict'
import { dismissNotification, resolveNotification } from '../src/notificationActions.ts'
test('deleting targets only the selected notification and propagates failure', async () => {
 const calls=[]; await dismissNotification({rpc:async (...args)=>{calls.push(args);return {data:true,error:null}}},'one');
 assert.deepEqual(calls,[['delete_user_notification',{p_id:'one'}]]);
 await assert.rejects(()=>dismissNotification({rpc:async()=>({error:{message:'Offline'}})},'one'),/Offline/);
});
test('opening uses the live server result and handles removed targets without navigation data', async () => {
 for(const status of ['missing','unavailable']) assert.deepEqual(await resolveNotification({rpc:async()=>({data:{status},error:null})},'one'),{status});
 const notification={id:'one',title:'Current server title'};
 assert.deepEqual(await resolveNotification({rpc:async(name,args)=>{assert.equal(name,'open_user_notification');assert.deepEqual(args,{p_id:'one'});return {data:{status:'ready',notification},error:null}}},'one'),{status:'ready',notification});
});
test('failed or malformed target checks never supply a navigation target', async () => {
 await assert.rejects(()=>resolveNotification({rpc:async()=>({error:{message:'Offline'}})},'one'),/Offline/);
 for(const data of [null,{}, {status:'ready',notification:{id:'other'}}]) await assert.rejects(()=>resolveNotification({rpc:async()=>({data,error:null})},'one'),/could not be checked/);
});
