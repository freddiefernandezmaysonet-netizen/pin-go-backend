import assert from "node:assert/strict";
import {test} from "node:test";
import {decideSalesVoiceRecovery,type SessionEvidence} from "./sales-voice-reconciliation-decisions.service.js";
const id="live_reconciliation_fixture_123";
const base={sessionId:id,provider:"OPENAI_LIVE_SIP",direction:"INBOUND",status:"ACCEPTED",finalized:false};
const none:SessionEvidence={kind:"NONE"};

test("a socket disconnect is not closure proof and must retain capacity",()=>{
  assert.equal(decideSalesVoiceRecovery({...base,evidence:{kind:"SOCKET_DISCONNECTED"}}),"KEEP_CAPACITY_HELD");
});
test("HTTP accept or hangup acknowledgment cannot release capacity",()=>{
  for(const kind of ["PROVIDER_HTTP_ACCEPTED","HANGUP_HTTP_ACKNOWLEDGED"] as const){
    assert.equal(decideSalesVoiceRecovery({...base,status:"HANGUP_SENT",evidence:{kind}}),"KEEP_CAPACITY_HELD");
  }
});
test("ambiguous accept/hangup states require reconciliation without retry",()=>{
  for(const status of ["ACCEPT_UNKNOWN","HANGUP_UNKNOWN","ADMISSION_CLAIMED","HANGUP_CLAIMED"]){
    assert.equal(decideSalesVoiceRecovery({...base,status,evidence:none}),"REQUIRE_PROVIDER_REVIEW");
  }
});
test("only matching authenticated sideband close is eligible for existing finalizer",()=>{
  const evidence:SessionEvidence={kind:"SIGNED_BOUND_SESSION_CLOSED",sessionId:id,eventSessionId:id,usageSeconds:19};
  assert.equal(decideSalesVoiceRecovery({...base,evidence}),"HAND_OFF_SIGNED_CLOSE_TO_FINALIZER");
});
test("forged or inconsistent session IDs never authorize finalization",()=>{
  for(const evidence of [
    {kind:"SIGNED_BOUND_SESSION_CLOSED",sessionId:id,eventSessionId:"live_another",usageSeconds:1},
    {kind:"SIGNED_BOUND_SESSION_CLOSED",sessionId:"live_another",eventSessionId:id,usageSeconds:1},
    {kind:"SIGNED_BOUND_SESSION_CLOSED",sessionId:id,eventSessionId:id,usageSeconds:-1},
    {kind:"SIGNED_BOUND_SESSION_CLOSED",sessionId:id,eventSessionId:id,usageSeconds:Infinity},
  ] as SessionEvidence[]){
    assert.equal(decideSalesVoiceRecovery({...base,evidence}),"REQUIRE_PROVIDER_REVIEW");
  }
});
test("wrong provider, direction, invalid ID or finalized record is never recovered",()=>{
  assert.equal(decideSalesVoiceRecovery({...base,provider:"TWILIO",evidence:none}),"REQUIRE_PROVIDER_REVIEW");
  assert.equal(decideSalesVoiceRecovery({...base,direction:"OUTBOUND",evidence:none}),"REQUIRE_PROVIDER_REVIEW");
  assert.equal(decideSalesVoiceRecovery({...base,sessionId:"invalid",evidence:none}),"REQUIRE_PROVIDER_REVIEW");
  assert.equal(decideSalesVoiceRecovery({...base,finalized:true,evidence:none}),"NO_ACTION");
  assert.equal(decideSalesVoiceRecovery({...base,status:"COMPLETED",evidence:none}),"NO_ACTION");
});
test("RECEIVED is not a claimed call and no provider action follows",()=>{
  assert.equal(decideSalesVoiceRecovery({...base,status:"RECEIVED",evidence:none}),"NO_ACTION");
});
