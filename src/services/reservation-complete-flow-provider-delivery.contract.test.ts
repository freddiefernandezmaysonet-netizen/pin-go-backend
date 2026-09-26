import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readAudit() {
  return readFile(
    new URL("./reservation-complete-flow-audit.service.ts", import.meta.url),
    "utf8"
  );
}

test("complete flow audit loads provider delivery outcome with MessageLog evidence", async () => {
  const source = await readAudit();

  assert.match(
    source,
    /messageLog\.findMany\([\s\S]*?providerDeliveryStatus:\s*true/
  );
  assert.match(
    source,
    /providerDeliveryStatus:\s*string \| null/
  );
});

test("terminal provider failures override legacy SENT evidence for the correlated message", async () => {
  const source = await readAudit();
  const start = source.indexOf("function hasMessageEvidence");
  const end = source.indexOf(
    "export async function auditReservationCompleteFlow",
    start
  );
  const fn = source.slice(start, end);

  const messageIndex = fn.indexOf("matchingMessageLog");
  const auditIndex = fn.indexOf("matchingAuditEntry");
  const dispatchIndex = fn.indexOf("matchingDispatchLog");

  assert.ok(messageIndex >= 0);
  assert.ok(auditIndex > messageIndex);
  assert.ok(dispatchIndex > messageIndex);

  assert.match(
    fn,
    /isTerminalProviderDeliveryFailure\([\s\S]*?providerDeliveryStatus[\s\S]*?return false/
  );
  assert.match(fn, /return isSuccessStatus\(matchingMessageLog\.status\)/);
});

test("provider terminal failure policy is conservative", async () => {
  const source = await readAudit();
  const start = source.indexOf(
    "function isTerminalProviderDeliveryFailure"
  );
  const end = source.indexOf(
    "function getAuditSearchText",
    start
  );
  const helper = source.slice(start, end);

  for (const status of [
    "FAILED",
    "BOUNCED",
    "SUPPRESSED",
    "COMPLAINED",
    "UNDELIVERED",
    "CANCELED",
  ]) {
    assert.match(helper, new RegExp(`"${status}"`));
  }

  assert.doesNotMatch(helper, /"SENT"/);
  assert.doesNotMatch(helper, /"DELIVERED"/);
  assert.doesNotMatch(helper, /"DELIVERY_DELAYED"/);
});
