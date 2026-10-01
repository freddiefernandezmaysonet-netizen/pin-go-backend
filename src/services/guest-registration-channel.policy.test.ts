import assert from "node:assert/strict";
import test from "node:test";
import { isChannexGuestRegistrationExempt } from "./guest-registration-channel.policy";

test("only persisted Channex provenance with a booking id is exempt", () => {
  for (const externalProvider of ["CHANNEX", " channex "]) {
    assert.equal(isChannexGuestRegistrationExempt({ externalProvider, externalId: "booking-1" }), true);
  }
  for (const externalProvider of [undefined, null, "", "DIRECT_BOOKING", "LODGIFY", "AIRBNB", "PIN_GO_CONNECT"]) {
    assert.equal(isChannexGuestRegistrationExempt({ externalProvider, externalId: "booking-1" }), false);
  }
  for (const externalId of [undefined, null, "", " "]) {
    assert.equal(isChannexGuestRegistrationExempt({ externalProvider: "CHANNEX", externalId }), false);
  }
});
