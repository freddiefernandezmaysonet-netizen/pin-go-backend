import test from 'node:test';
import assert from 'node:assert/strict';
import {runLoop} from '../workers/host-mobile-push.worker.js';
test('continuous worker is explicit, serial, stops cleanly and rejects disabled/malformed configuration',async()=>{
 const env={HOST_MOBILE_PUSH_DELIVERY_ENABLED:'true',HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS:'["property"]',HOST_MOBILE_PUSH_DELIVERY_NOT_BEFORE:'2026-10-20T00:00:00Z'};
 const c=new AbortController();let calls=0,active=0,max=0,pauses=0;
 await runLoop(env,c.signal,async()=>{calls++;active++;max=Math.max(max,active);await Promise.resolve();active--;return {enabled:true,processed:0,enqueued:0};},async()=>{pauses++;if(pauses===2)c.abort();});
 assert.deepEqual({calls,max,pauses},{calls:2,max:1,pauses:2});
 await assert.rejects(runLoop({},c.signal),/DISABLED/);
 await assert.rejects(runLoop({...env,HOST_MOBILE_PUSH_DELIVERY_PROPERTY_IDS:'[]'},c.signal),/INVALID/);
});
