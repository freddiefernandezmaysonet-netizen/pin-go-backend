import assert from "node:assert/strict";
import {test} from "node:test";
import {salesVoiceAddonPrices} from "./sales-voice-addon-pricing.service.js";
import {readSalesVoicePricing,renderSalesVoicePricing} from "./sales-voice-pricing.service.js";
test("canonical guest Pin AI terms retain reservation unit under either collection version",()=>{
  for(const flag of [undefined,"false","true"]){
    const lines=salesVoiceAddonPrices({PIN_AI_HYBRID_BILLING_ENABLED:flag});
    assert.ok(lines[0].includes("VERIFIED USD 1.00"));
    assert.ok(lines[0].includes("once per reservation"));
    assert.ok(lines[0].includes("aceptacion")&&lines[0].includes("exenciones"));
    assert.ok(!lines.join(" ").includes("BALANCE_DEBIT"));
    assert.ok(Object.isFrozen(lines));
  }
});
test("identity fee reads current configuration and states direct-booking host conditions",()=>{
  const first=salesVoiceAddonPrices({DIRECT_BOOKING_PROTECTION_FEE_AMOUNT:"3.75"});
  const second=salesVoiceAddonPrices({DIRECT_BOOKING_PROTECTION_FEE_AMOUNT:"4.00"});
  assert.ok(first[1].includes("USD 3.75"));assert.ok(second[1].includes("USD 4.00"));
  assert.ok(first[1].includes("direct booking")&&first[1].includes("anfitrion"));
  assert.ok(first[1].includes("consentimiento")&&first[1].includes("limite del pago"));
  assert.ok(salesVoiceAddonPrices({})[1].includes("USD 2.50"));
  assert.ok(salesVoiceAddonPrices({DIRECT_BOOKING_PROTECTION_FEE_AMOUNT:"0"})[1].includes("USD 0.00"));
});
test("malformed identity pricing never falls back to the marketing amount or leaks input",()=>{
  for(const value of [""," ","-1","NaN","Infinity","2.555","1e2","sk-private","9007199254740992"]){
    const line=salesVoiceAddonPrices({DIRECT_BOOKING_PROTECTION_FEE_AMOUNT:value})[1];
    assert.equal(line,"Verificacion de identidad / Identity verification: UNAVAILABLE.");
  }
});
test("subscription lookup failures preserve separately validated addon terms in the call snapshot",async()=>{
  const snapshot=await readSalesVoicePricing({DIRECT_BOOKING_PROTECTION_FEE_AMOUNT:"3.75"},async()=>{throw Error("secret");});
  const text=renderSalesVoicePricing(snapshot);
  assert.ok(snapshot.lines.every(l=>l.includes("UNAVAILABLE")));
  assert.ok(text.includes("USD 3.75")&&text.includes("USD 1.00"));
  assert.ok(!text.includes("No cotices complementos Pin AI"));
  assert.ok(!text.includes("secret"));
});
