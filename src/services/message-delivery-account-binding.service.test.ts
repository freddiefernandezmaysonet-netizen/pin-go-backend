import assert from "node:assert/strict";
import test from "node:test";
import { deliveryAccountBindingEnabled, readDeliveryAccountKey, resolveCapturedReceiptMessage } from "./message-delivery-account-binding.service";

test("account binding is opt-in and only accepts provider-specific provenance", () => {
  assert.equal(deliveryAccountBindingEnabled({}), false);
  assert.equal(deliveryAccountBindingEnabled({MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED: "0"}), false);
  assert.equal(deliveryAccountBindingEnabled({MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED: "1"}), true);
  assert.throws(() => deliveryAccountBindingEnabled({MESSAGE_DELIVERY_ACCOUNT_BINDING_ENABLED: "true"}), /CONFIG_INVALID/);
  assert.equal(readDeliveryAccountKey("twilio", {deliveryAccountKey: "AC" + "a".repeat(32)}), "AC" + "a".repeat(32));
  for (const value of [undefined, null, {}, {deliveryAccountKey: "arbitrary"}, {deliveryAccountKey: 42}]) {
    assert.equal(readDeliveryAccountKey("twilio", value), null);
  }
  assert.equal(readDeliveryAccountKey("resend", {deliveryAccountKey: "deployment_account-1"}), "deployment_account-1");
  assert.equal(readDeliveryAccountKey("resend", {deliveryAccountKey: "secret with spaces"}), null);
  assert.equal(readDeliveryAccountKey("other", {deliveryAccountKey: "account"}), null);
});

test("resolver refuses invalid correlation before touching persistence", async () => {
  const db = new Proxy({}, {get() {throw Error("must not access persistence");}});
  for (const receipt of [
    {provider: "other", accountKey: "account", providerMessageId: "message"},
    {provider: "twilio", accountKey: "account", providerMessageId: "message"},
    {provider: "resend", accountKey: "account", providerMessageId: " "},
  ]) assert.deepEqual(await resolveCapturedReceiptMessage(db as any, receipt), {state: "INVALID_CORRELATION"});
});
