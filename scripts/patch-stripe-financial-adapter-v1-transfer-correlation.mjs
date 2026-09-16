import fs from "node:fs";

const servicePath = "src/services/stripe-financial-adapter.service.ts";
const testPath = "src/services/stripe-financial-adapter.service.test.ts";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${label}: anchor not found`);
  if (source.indexOf(before, first + 1) >= 0) {
    throw new Error(`${label}: anchor is not unique`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let service = fs.readFileSync(servicePath, "utf8");
service = replaceExactlyOnce(
  service,
  `          OR: [\n            { createdAt: { gte: since, lte: now } },\n            { stripeChargeId: { in: [...relatedChargeIds] } },\n            {\n              stripePaymentIntentId: {\n                in: [...relatedPaymentIntentIds],\n              },\n            },\n          ],`,
  `          OR: [\n            { createdAt: { gte: since, lte: now } },\n            { stripeChargeId: { in: [...relatedChargeIds] } },\n            {\n              stripePaymentIntentId: {\n                in: [...relatedPaymentIntentIds],\n              },\n            },\n            { stripeTransferId: { in: [...transfers.keys()] } },\n          ],`,
  "reservation transfer correlation query"
);
service = replaceExactlyOnce(
  service,
  `  const bookingTransfersFromLedger = sumMap(transfers);\n`,
  `  let bookingTransfersFromLedger = 0;\n  for (const reservation of reservationRows) {\n    if (!reservation.stripeTransferId) continue;\n    const amount = transfers.get(reservation.stripeTransferId);\n    if (amount !== undefined) bookingTransfersFromLedger += amount;\n  }\n`,
  "host transfer aggregation"
);
fs.writeFileSync(servicePath, service);

let test = fs.readFileSync(testPath, "utf8");
const transferFixture = `      ledgerEvent({\n        stripeId: "evt_transfer",\n        type: "transfer.created",\n        object: {\n          id: "tr_1",\n          object: "transfer",\n          amount: 9000,\n          currency: "usd",\n        },\n      }),\n`;
test = replaceExactlyOnce(
  test,
  transferFixture,
  `${transferFixture}      ledgerEvent({\n        stripeId: "evt_unrelated_transfer",\n        type: "transfer.created",\n        object: {\n          id: "tr_unrelated",\n          object: "transfer",\n          amount: 5000,\n          currency: "usd",\n        },\n      }),\n`,
  "unrelated transfer fixture"
);
test = replaceExactlyOnce(
  test,
  `    ledgerEventCount: 6,\n`,
  `    ledgerEventCount: 7,\n`,
  "ledger event count expectation"
);
fs.writeFileSync(testPath, test);

console.log("Stripe Financial Adapter V1 transfer-correlation patch applied.");
