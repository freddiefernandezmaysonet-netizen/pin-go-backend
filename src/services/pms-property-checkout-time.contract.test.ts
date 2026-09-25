import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function read(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("PMS ingest boundaries use Property.checkOutTime with 11:00 fallback", async () => {
  const [ingest, handler, processor] = await Promise.all([
    read("./ingest.service.ts"),
    read("../pms/ingest/webhook.handler.ts"),
    read("../pms/ingest/webhook.processor.ts"),
  ]);

  for (const source of [ingest, handler, processor]) {
    assert.match(source, /checkOutTime:\s*true/);
    assert.match(source, /property\?\.checkOutTime\s*\?\?\s*"11:00"/);
  }
});

test("date-only checkout uses property time while explicit PMS datetime remains intact", async () => {
  const [ingest, handler] = await Promise.all([
    read("./ingest.service.ts"),
    read("../pms/ingest/webhook.handler.ts"),
  ]);

  for (const source of [ingest, handler]) {
    assert.match(
      source,
      /isDateOnly\([^)]*checkOut[^)]*\)[\s\S]*buildLocalDateFromDateOnly\([^,]+,\s*propertyCheckOutTime,\s*propertyTimeZone\)[\s\S]*new Date\([^)]*checkOut[^)]*\)/
    );
  }
});
