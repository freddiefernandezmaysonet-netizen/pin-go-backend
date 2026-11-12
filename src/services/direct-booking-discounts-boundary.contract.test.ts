import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const read = (path: string) => fs.readFileSync(path, "utf8");
test("discounted quote is opt-in only at public quote and checkout, never calendar or Channex", () => {
  const routes = read("src/routes/public-booking.routes.ts");
  assert.equal((routes.match(/await calculateDiscountedDirectQuote\(/g) || []).length, 2);
  assert.doesNotMatch(routes.slice(routes.indexOf('publicBookingRouter.get("/calendar-rates"'), routes.indexOf('publicBookingRouter.post("/quote"')), /await calculateDiscountedDirectQuote/);
  for (const file of ["src/services/channex-availability-sync.service.ts", "src/workers/dynamic-pricing-sync.worker.ts", "src/services/direct-booking-pricing.service.ts"]) {
    assert.doesNotMatch(read(file), /calculateDiscountedDirectQuote|calculateAccommodationDiscount/);
  }
});
