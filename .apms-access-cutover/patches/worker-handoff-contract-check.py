from pathlib import Path

root = Path(__file__).parents[1]
service_text = (root / "src/services/guest-journey-access-owner-handoff.service.ts").read_text()
fragments = root / "patches/fragments"
import_new = (fragments / "import.new").read_text()
checkin_new = (fragments / "checkin.new").read_text()
checkout_new = (fragments / "checkout.new").read_text()
worker_changes = "\n".join([import_new, checkin_new, checkout_new])

for token in [
    "resolveGuestJourneyAccessOwnerHandoff",
    'operation: "PROVISION"',
    'operation: "REVOKE"',
    '"ACCESS_OWNER"',
    '"APMS_PENDING"',
    'accessHandoff.owner === "BLOCKED"',
    "GUEST_JOURNEY_INTERNAL_RECONCILE_CONFIG",
    "GUEST_JOURNEY_COORDINATION_CONFIG",
]:
    assert token in worker_changes, token

assert worker_changes.count('operation: "PROVISION"') == 1
assert worker_changes.count('operation: "REVOKE"') == 1
assert worker_changes.count("resolveGuestJourneyAccessOwnerHandoff") == 3  # import + two calls
assert worker_changes.count("deferred pending Guest Journey ACCESS coordination") == 2
assert worker_changes.count("blocked by APMS ownership fence") == 2

# Resolver remains read-only. Provider mutation symbols or Prisma mutation calls
# are forbidden inside the handoff boundary itself.
for forbidden in [
    "activateGrant(",
    "deactivateGrant(",
    "ttlockChange",
    "ttlockDelete",
    "stripe.",
    "twilio",
    "channex",
    ".create(",
    ".createMany(",
    ".update(",
    ".updateMany(",
    ".delete(",
    ".deleteMany(",
]:
    assert forbidden.lower() not in service_text.lower(), forbidden

for required in [
    "reservation.findUnique",
    "guestJourneyCoordinationIntent.findFirst",
    "REQUEST_ACCESS_PROVISIONING",
    "REQUEST_ACCESS_REVOCATION_CHECK",
    "WAITING_FOR_EVIDENCE",
    "APMS_ADOPTION_WINDOW_PENDING_DURABLE_ACCESS_INTENT",
    "OUTSIDE_APMS_ADOPTION_WINDOW_WITHOUT_DURABLE_ACCESS_OWNERSHIP",
    "EXHAUSTED",
    "SUCCEEDED",
]:
    assert required in service_text, required

# The old scope-only yield can no longer exist in either replacement hunk.
for fragment in [checkin_new, checkout_new]:
    yield_at = fragment.find("yielded to Guest Journey ACCESS owner")
    resolver_at = fragment.find("resolveGuestJourneyAccessOwnerHandoff")
    assert resolver_at >= 0
    assert yield_at > resolver_at
    assert "APMS_PENDING" in fragment

print("worker_handoff_contract_check=PASS")
