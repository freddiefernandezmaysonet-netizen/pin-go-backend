import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const financialRoute = readFileSync(
  "src/routes/financial.routes.ts",
  "utf8"
);
const adminFinancialRoute = readFileSync(
  "src/routes/admin.financial.routes.ts",
  "utf8"
);

for (const [name, source] of [
  ["organization financial route", financialRoute],
  ["admin financial route", adminFinancialRoute],
] as const) {
  test(`${name} uses segment-aware sent Twilio telemetry`, () => {
    assert.match(
      source,
      /summarizeSmsFinancialTelemetry/
    );
    assert.match(source, /provider:\s*"twilio"/);
    assert.match(source, /status:\s*"SENT"/);
    assert.doesNotMatch(source, /AVG_SMS_COST/);
    assert.doesNotMatch(source, /0\.008/);
  });
}

test("organization financial route no longer estimates four SMS per reservation", () => {
  assert.doesNotMatch(
    financialRoute,
    /reservations\s*\*\s*4/
  );
  assert.match(
    financialRoute,
    /smsTelemetry\.estimatedCostUsd/
  );
});

test("admin financial route exposes segment totals while preserving message totals", () => {
  assert.match(
    adminFinancialRoute,
    /totalSmsMessages:\s*smsTelemetry\.totalMessages/
  );
  assert.match(
    adminFinancialRoute,
    /totalSmsSegments:\s*smsTelemetry\.totalSegments/
  );
  assert.match(
    adminFinancialRoute,
    /smsUsed:\s*orgSmsTelemetry\.totalMessages/
  );
  assert.match(
    adminFinancialRoute,
    /smsSegments:\s*orgSmsTelemetry\.totalSegments/
  );
});
