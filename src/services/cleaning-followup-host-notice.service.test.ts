import assert from "node:assert/strict";import test from "node:test";
import { queueCleaningHostAttentionNotice } from "./cleaning-followup-host-notice.service.js";
test("returns existing notice on duplicate work",async()=>{let creates=0;const existing={id:"n1",cleaningWorkId:"w1",status:"QUEUED"};const prisma:any={cleaningHostAttentionNotice:{create:async()=>{creates++;const e:any=new Error("dup");e.code="P2002";throw e;},findUniqueOrThrow:async()=>existing}};assert.deepEqual(await queueCleaningHostAttentionNotice(prisma,"w1"),existing);assert.equal(creates,1);});
