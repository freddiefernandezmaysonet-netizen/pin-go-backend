import assert from "node:assert/strict";
import test from "node:test";
import { composeGuestIncidentReply, hasCanonicalGuestIncidentReply } from "./guest-incident-response.js";

const receipt = "Tu reporte sigue abierto. El aviso llegó al correo del anfitrión. Referencia: GI-012345ABCDEF.";
test("guest-supplied contact and a useful follow-up survive with the separate canonical receipt", () => {
  const narrative = "Gracias por contarme que el anfitrión te llamó. ¿Te indicó cómo ayudarte?";
  const reply = composeGuestIncidentReply(narrative, receipt);
  assert.equal(reply, `${narrative}\n\n${receipt}`);
  assert.equal(hasCanonicalGuestIncidentReply(reply, receipt), true);
  assert.equal(hasCanonicalGuestIncidentReply(reply.replace("sigue abierto", "está resuelto"), receipt), false);
  assert.equal(hasCanonicalGuestIncidentReply(`${reply}\nAltered`, receipt), false);
});
test("model action claims or contradictory status fall back to evidence without blocking the dialogue", () => {
  for (const narrative of ["He notificado al anfitrión.", "He registrado el problema de conexión.",
    "I've recorded your report.", "Your refund has been approved.",
    "Tu caso está resuelto.", "The notification was delivered.", "Your host has read your email.",
    "Referencia: GI-FFFFFFFFFFFF", "x".repeat(4001)]) {
    assert.equal(composeGuestIncidentReply(narrative, receipt), receipt);
    assert.equal(hasCanonicalGuestIncidentReply(`${narrative}\n\n${receipt}`, receipt), false);
  }
});
test("copying the receipt does not duplicate it and an empty receipt is rejected", () => {
  assert.equal(composeGuestIncidentReply(receipt, receipt), receipt);
  assert.equal(composeGuestIncidentReply(`Gracias.\n${receipt}`, receipt), `Gracias.\n\n${receipt}`);
  assert.throws(() => composeGuestIncidentReply("Hello", ""), /RECEIPT_REQUIRED/);
});
