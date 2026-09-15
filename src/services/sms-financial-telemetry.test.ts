import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TWILIO_SMS_SEGMENT_COST_USD,
  estimateSmsSegments,
  getTwilioSmsSegmentCostUsd,
  summarizeSmsFinancialTelemetry,
} from "./sms-financial-telemetry.service";

test("GSM-7 single and multipart boundaries are correct", () => {
  assert.deepEqual(
    estimateSmsSegments("A".repeat(160)),
    { encoding: "GSM-7", units: 160, segments: 1 }
  );
  assert.equal(
    estimateSmsSegments("A".repeat(161)).segments,
    2
  );
  assert.equal(
    estimateSmsSegments("A".repeat(306)).segments,
    2
  );
  assert.equal(
    estimateSmsSegments("A".repeat(307)).segments,
    3
  );
});

test("GSM-7 extended characters count as two units", () => {
  const estimate = estimateSmsSegments("^".repeat(80));
  assert.equal(estimate.encoding, "GSM-7");
  assert.equal(estimate.units, 160);
  assert.equal(estimate.segments, 1);
  assert.equal(
    estimateSmsSegments("^".repeat(81)).segments,
    2
  );
});

test("Unicode and emoji use UCS-2 boundaries conservatively", () => {
  assert.deepEqual(
    estimateSmsSegments("á".repeat(70)),
    { encoding: "UCS-2", units: 70, segments: 1 }
  );
  assert.equal(
    estimateSmsSegments("á".repeat(71)).segments,
    2
  );

  const emoji = estimateSmsSegments("😀".repeat(35));
  assert.equal(emoji.encoding, "UCS-2");
  assert.equal(emoji.units, 70);
  assert.equal(emoji.segments, 1);
  assert.equal(
    estimateSmsSegments("😀".repeat(36)).segments,
    2
  );
});

test("empty bodies contribute zero billable segments", () => {
  assert.deepEqual(
    estimateSmsSegments(""),
    { encoding: "GSM-7", units: 0, segments: 0 }
  );
});

test("Twilio segment rate uses valid override and safe fallback", () => {
  assert.equal(
    getTwilioSmsSegmentCostUsd({} as NodeJS.ProcessEnv),
    DEFAULT_TWILIO_SMS_SEGMENT_COST_USD
  );
  assert.equal(
    getTwilioSmsSegmentCostUsd({
      TWILIO_SMS_SEGMENT_COST_USD: "0.061",
    } as NodeJS.ProcessEnv),
    0.061
  );
  assert.equal(
    getTwilioSmsSegmentCostUsd({
      TWILIO_SMS_SEGMENT_COST_USD: "invalid",
    } as NodeJS.ProcessEnv),
    DEFAULT_TWILIO_SMS_SEGMENT_COST_USD
  );
  assert.equal(
    getTwilioSmsSegmentCostUsd({
      TWILIO_SMS_SEGMENT_COST_USD: "0",
    } as NodeJS.ProcessEnv),
    DEFAULT_TWILIO_SMS_SEGMENT_COST_USD
  );
});

test("summary charges segments, not logical messages", () => {
  const summary = summarizeSmsFinancialTelemetry(
    [
      { body: "A".repeat(160) },
      { body: "A".repeat(161) },
      { body: "á".repeat(71) },
    ],
    {} as NodeJS.ProcessEnv
  );

  assert.equal(summary.totalMessages, 3);
  assert.equal(summary.totalSegments, 5);
  assert.equal(summary.gsm7Messages, 2);
  assert.equal(summary.ucs2Messages, 1);
  assert.equal(summary.segmentRateUsd, 0.054);
  assert.equal(summary.estimatedCostUsd, 5 * 0.054);
});
