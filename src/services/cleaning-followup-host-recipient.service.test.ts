import assert from "node:assert/strict";import test from "node:test";
import { resolveCleaningHostAttentionRecipients } from "./cleaning-followup-host-recipient.service.js";
test("never falls back outside the organization",async()=>{const calls:any[]=[];const prisma:any={dashboardUser:{findMany:async({where}:any)=>{calls.push(where);return[];}}};assert.deepEqual(await resolveCleaningHostAttentionRecipients(prisma,"org_1"),[]);assert.equal(calls.every(x=>x.organizationId==="org_1"),true);});
