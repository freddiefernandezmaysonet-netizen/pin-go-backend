import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PrismaClient } from "@prisma/client";
import { SalesVoiceCommercialError, SalesVoiceCommercialService } from "./sales-voice-commercial.service.js";

const url = process.env.SALES_VOICE_SERVICE_TEST_DATABASE_URL;
assert.ok(url, "Dedicated disposable PostgreSQL required");
const parsed = new URL(url);
assert.equal(parsed.protocol, "postgresql:");
assert.ok(["localhost", "127.0.0.1"].includes(parsed.hostname));
assert.equal(parsed.pathname, "/pingo_sales_voice_service_test");
assert.equal(process.env.DATABASE_URL, url);

const db = new PrismaClient({ datasources: { db: { url } } });
const service = new SalesVoiceCommercialService(db);
after(async () => db.$disconnect());

const sid = (n: number) => `CA${n.toString(16).padStart(32, "0")}`;
const input = (n: number, fromPhoneE164?: string | null) => ({
  providerCallId: sid(n), toPhoneE164: "+17875550111", fromPhoneE164,
});

async function errorCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, e => e instanceof SalesVoiceCommercialError && e.code === code);
}

test("anonymous call recorded with no automatic lead or cross-customer lookup", async () => {
  const before = await db.salesProspect.count();
  const call = await service.recordInboundCall(input(1));
  assert.equal(call.prospectId, null);
  assert.equal(call.fromPhoneE164, null);
  assert.equal(call.status, "RECEIVED");
  assert.equal(await db.salesProspect.count(), before);
});

test("duplicate provider events are idempotent even with concurrent receipt", async () => {
  const payload = input(2, "+12025550101");
  const calls = await Promise.all(Array.from({length: 8}, () => service.recordInboundCall(payload)));
  assert.equal(new Set(calls.map(c => c.id)).size, 1);
  assert.equal(await db.salesVoiceCall.count({ where: { providerCallId: payload.providerCallId } }), 1);
});

test("a reused provider ID with conflicting call metadata is rejected", async () => {
  await service.recordInboundCall(input(3, "+12025550101"));
  await errorCode(service.recordInboundCall(input(3, "+12025550102")), "PROVIDER_CALL_ID_CONFLICT");
});

test("malformed provider IDs and phone data are rejected before writing", async () => {
  await errorCode(service.recordInboundCall({ providerCallId: "not-a-sid", toPhoneE164: "+17875550111" }), "INVALID_TWILIO_CALL_SID");
  await errorCode(service.recordInboundCall({ providerCallId: sid(4), toPhoneE164: "787-555-0111" }), "INVALID_PHONE");
  assert.equal(await db.salesVoiceCall.count({where:{providerCallId:sid(4)}}),0);
});

test("first explicit prospect creates a separate lead, linked to one call", async () => {
  await service.recordInboundCall(input(5, "+12025550101"));
  const lead = await service.createProspectFromCall({
    providerCallId: sid(5), fullName: " Ana Pérez ", email: "ANA@EXAMPLE.COM",
    organizationName: "Island Rental", propertyCount: 5, preferredLanguage: "es",
  });
  assert.equal(lead.fullName, "Ana Pérez");
  assert.equal(lead.email, "ana@example.com");
  assert.equal(lead.propertyCount,5);
  assert.equal(lead.contactConsentAt,null);
  assert.equal(lead.marketingConsentAt,null);
  const call=await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:sid(5)}});
  assert.equal(call.prospectId,lead.id);
  // The inbound caller ID is not automatically treated as a confirmed contact number.
  assert.equal(lead.phoneE164,null);
});

test("retried lead creation for the same call is idempotent, not a silent profile overwrite", async () => {
  await service.recordInboundCall(input(6));
  const a = await service.createProspectFromCall({providerCallId:sid(6), fullName:"First name"});
  const b = await service.createProspectFromCall({providerCallId:sid(6), fullName:"Different name"});
  assert.equal(a.id,b.id);
  assert.equal(b.fullName,"First name");
});

test("concurrent lead creation on the same call results in only one prospect", async () => {
  await service.recordInboundCall(input(7));
  const before=await db.salesProspect.count();
  const leads=await Promise.all(Array.from({length: 6}, () =>
    service.createProspectFromCall({providerCallId:sid(7),fullName:"Concurrent lead"})));
  assert.equal(new Set(leads.map(l=>l.id)).size,1);
  assert.equal(await db.salesProspect.count(), before+1);
});

test("similar callers may create separate prospect records without caller ID matching", async () => {
  await service.recordInboundCall(input(8,"+12025550101"));
  await service.recordInboundCall(input(9,"+12025550101"));
  const a=await service.createProspectFromCall({providerCallId:sid(8),fullName:"Client A",phoneE164:"+12025550101"});
  const b=await service.createProspectFromCall({providerCallId:sid(9),fullName:"Client B",phoneE164:"+12025550101"});
  assert.notEqual(a.id,b.id);
});

test("invalid identity and lead attributes cannot create a prospect", async () => {
  await service.recordInboundCall(input(10));
  await errorCode(service.createProspectFromCall({providerCallId:sid(10)}),"PROSPECT_IDENTITY_REQUIRED");
  await errorCode(service.createProspectFromCall({providerCallId:sid(10),fullName:"A",propertyCount:-1}),"INVALID_PROPERTY_COUNT");
  await errorCode(service.createProspectFromCall({providerCallId:sid(10),email:"not-email"}),"INVALID_EMAIL");
  await errorCode(service.createProspectFromCall({providerCallId:sid(10),fullName:"A",preferredLanguage:"fr" as any}),"INVALID_LANGUAGE");
  assert.equal((await db.salesVoiceCall.findUniqueOrThrow({where:{providerCallId:sid(10)}})).prospectId,null);
});

test("signup handoff contains no personal data, card, session, or authentication token", async () => {
  const lead=await db.salesProspect.create({data:{fullName:"Link request",email:"private@example.com"}});
  const handoff=await service.prepareSignupHandoff(lead.id);
  assert.deepEqual(handoff,{url:"https://pin-ngo.com",status:"CUSTOMER_ACTION_REQUIRED"});
  assert.equal(handoff.url.includes(lead.email!),false);
});

test("follow-up requires explicit contact consent and distinct marketing consent", async () => {
  const lead=await db.salesProspect.create({data:{fullName:"Consent check",email:"test@example.com",phoneE164:"+12025550101"}});
  await errorCode(service.prepareFollowUp({prospectId:lead.id,channel:"EMAIL",purpose:"REQUESTED_INFORMATION"}),"CONTACT_CONSENT_REQUIRED");
  await db.salesProspect.update({where:{id:lead.id},data:{contactConsentAt:new Date()}});
  const proposed=await service.prepareFollowUp({prospectId:lead.id,channel:"EMAIL",purpose:"REQUESTED_INFORMATION"});
  assert.deepEqual(proposed,{status:"READY_FOR_MANUAL_REVIEW",channel:"EMAIL",purpose:"REQUESTED_INFORMATION",recipient:"test@example.com"});
  await errorCode(service.prepareFollowUp({prospectId:lead.id,channel:"SMS",purpose:"MARKETING"}),"MARKETING_CONSENT_REQUIRED");
  await db.salesProspect.update({where:{id:lead.id},data:{marketingConsentAt:new Date(),marketingConsentSource:"VERBAL_RECORDED_OUTSIDE_SERVICE"}});
  const marketing=await service.prepareFollowUp({prospectId:lead.id,channel:"SMS",purpose:"MARKETING"});
  assert.equal(marketing.recipient,"+12025550101");
  assert.equal(marketing.status,"READY_FOR_MANUAL_REVIEW");
});

test("converted prospect cannot generate signup or contact follow-up proposal", async () => {
  const lead=await db.salesProspect.create({data:{fullName:"Converted",email:"done@example.com",contactConsentAt:new Date(),convertedAt:new Date()}});
  await errorCode(service.prepareSignupHandoff(lead.id),"ALREADY_CONVERTED");
  await errorCode(service.prepareFollowUp({prospectId:lead.id,channel:"EMAIL",purpose:"REQUESTED_INFORMATION"}),"ALREADY_CONVERTED");
});

test("call finalization is idempotent and does not overwrite first outcome", async () => {
  const call=await service.recordInboundCall(input(11));
  const endedAt=new Date(call.startedAt.getTime()+125000);
  const first=await service.completeCall({providerCallId:sid(11),disposition:"SIGNUP_LINK_SHARED",endedAt});
  const second=await service.completeCall({providerCallId:sid(11),disposition:"CALL_DROPPED",endedAt:new Date(endedAt.getTime()+60000)});
  assert.equal(first.id,second.id);
  assert.equal(second.disposition,"SIGNUP_LINK_SHARED");
  assert.equal(second.durationSeconds,125);
  assert.equal(second.status,"COMPLETED");
});

test("invalid completion timestamp leaves the call unchanged", async () => {
  const call=await service.recordInboundCall(input(12));
  await errorCode(service.completeCall({providerCallId:sid(12),disposition:"CALL_DROPPED",endedAt:new Date(call.startedAt.getTime()-2000)}),"INVALID_END_TIME");
  const current=await db.salesVoiceCall.findUniqueOrThrow({where:{id:call.id}});
  assert.equal(current.endedAt,null);
});
