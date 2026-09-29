import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildCleaningHostAttentionEmail } from "./cleaning-followup-host-email.service.js";

test("host email states missing confirmation, not failed cleaning", () => {
  const email = buildCleaningHostAttentionEmail({
    to: ["h@example.test"],
    propertyName: "Casa",
    cleanerName: "Cleaner",
    reservationNumber: "PG-1",
    dashboardUrl: "https://app.example/properties/property-1/calendar",
  });

  assert.match(
    email.text,
    /has not received.*completion confirmation/i,
  );
  assert.match(email.text, /does not confirm/i);
  assert.doesNotMatch(
    email.text,
    /cleaning failed|did not clean|property is dirty/i,
  );
});

test("host attention delivery targets the property Mission Control calendar", () => {
  const deliverySource = fs.readFileSync(
    new URL(
      "./cleaning-followup-host-delivery.service.ts",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    deliverySource,
    /dashboardUrl:\s*\`\$\{origin\}\/properties\/\$\{encodeURIComponent\(work\.propertyId\)\}\/calendar\`/,
  );
  assert.doesNotMatch(
    deliverySource,
    /dashboardUrl:\s*\`\$\{origin\}\/dashboard\`/,
  );
});
