import assert from "node:assert/strict";
import test from "node:test";

import { CHANNEX_CERTIFICATION_V1_MANIFEST } from "./channex-certification-v1.fixture";

test("freezes the exact mapping certified for Channex Certification V1", () => {
  assert.deepEqual(CHANNEX_CERTIFICATION_V1_MANIFEST, {
    organizationId: "cms0zipf70000pf6n7is2ncwr",
    propertyId: "cms0zipff0002pf6n5h3d500k",
    channexPropertyId: "1d699e11-593c-4a3d-b66a-28741759e82f",
    channexRoomTypeId: "31a7161d-cd47-4f38-b5f4-4b9e11d4e6f9",
    channexRatePlanId: "daa6211c-bd9b-455f-b526-4136550b9a92",
    connectionId: "cms0zipfl0004pf6n5i0z6oxt",
    listingId: "cms0zipfr0006pf6nu8tzzbr9",
  });
  assert.equal(Object.isFrozen(CHANNEX_CERTIFICATION_V1_MANIFEST), true);
});
