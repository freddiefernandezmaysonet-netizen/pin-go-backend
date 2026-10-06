"""Exact PR #371 boundary; retain runtime/provider certifications."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

REPO = "freddiefernandezmaysonet-netizen/pin-go-backend"
BASE = "c97cb69f7c8e531bced491cdd5588c2c74510963"
ALLOWED = {'.github/workflows/apms-exit-closure-a-certification.yml',
 '.github/workflows/guest-journey-enterprise-e15-certification.yml',
 '.github/workflows/ota-airbnb-listing-discovery.yml',
 '.github/workflows/pin-ai-connect-native-certification.yml',
 '.github/workflows/pin-ai-host-incidents-v1.yml',
 'docs/pin-ai-connect-reservation-fee-v1.md',
 'docs/pin-ai-property-activation-v1.md',
 'docs/pin-ai-reservation-fee-v1.md',
 'prisma/migrations/20261006170000_pin_ai_property_activation/migration.sql',
 'prisma/migrations/20261006173000_pin_ai_billing_acceptance/migration.sql',
 'prisma/migrations/20261006174000_pin_ai_reservation_fee/migration.sql',
 'prisma/migrations/20261006180000_pin_ai_fee_invoice_export/migration.sql',
 'prisma/migrations/20261006193000_pin_ai_connect_debit/migration.sql',
 'prisma/migrations/20261006200000_pin_ai_service_enrollment/migration.sql',
 'prisma/schema.prisma',
 'scripts/verify-pin-ai-activation-pr-scope.py',
 'scripts/verify-pin-ai-activation-pr-scope.test.py',
 'src/pin-ai/billing-terms.ts',
 'src/pin-ai/fee-connect-cycle.service.ts',
 'src/pin-ai/fee-connect-stripe.provider.test.ts',
 'src/pin-ai/fee-connect-stripe.provider.ts',
 'src/pin-ai/fee-connect.native.database.test.ts',
 'src/pin-ai/fee-connect.service.ts',
 'src/pin-ai/fee-connect.test.ts',
 'src/pin-ai/fee-stripe-evidence.ts',
 'src/pin-ai/fixtures/fee-stripe-sandbox-20261006.json',
 'src/pin-ai/fixtures/fee-stripe-sdk-paid-20261006.json',
 'src/pin-ai/guest/guest-incident-notification.service.ts',
 'src/pin-ai/guest/guest-incident.service.ts',
 'src/pin-ai/guest/guest-runtime-gateway.ts',
 'src/pin-ai/host/host-incident.service.ts',
 'src/pin-ai/property-activation.database.test.ts',
 'src/pin-ai/property-activation.test.ts',
 'src/pin-ai/property-activation.ts',
 'src/pin-ai/reservation-fee.service.ts',
 'src/pin-ai/reservation-fee.test.ts',
 'src/pin-ai/reservation-service-evidence.ts',
 'src/pin-ai/service-enrollment.database.test.ts',
 'src/pin-ai/service-enrollment.service.ts',
 'src/routes/dashboard.pin-ai-activation.routes.test.ts',
 'src/routes/dashboard.pin-ai-activation.routes.ts',
 'src/routes/public-booking.pin-ai.routes.test.ts',
 'src/routes/public-booking.pin-ai.routes.ts',
 'src/scripts/certify-pin-ai-connect-debit-sandbox.test.ts',
 'src/scripts/certify-pin-ai-connect-debit-sandbox.ts',
 'src/scripts/certify-pin-ai-connect-reconciliation-sandbox.test.ts',
 'src/scripts/certify-pin-ai-connect-reconciliation-sandbox.ts',
 'src/server.ts',
 'src/services/guest-cancellation.service.ts',
 'src/services/ingest.service.ts',
 'src/services/internal-demo-commercial.db.test.ts',
 'src/services/internal-demo-secure-precheckin.service.test.ts',
 'src/services/manual-reservation-cancellation.service.ts',
 'src/services/pin-ai-activation.service.ts',
 'src/services/reservations.patch.service.ts',
 'src/services/reservations.service.ts',
 'src/workers/reservation.worker.ts'}
PINNED = {'prisma/migrations/20261006170000_pin_ai_property_activation/migration.sql': '85394b5c48db03082e8328117bad109d3682e838a3f26e9329edbffa47f70e0f',
 'prisma/migrations/20261006173000_pin_ai_billing_acceptance/migration.sql': '4e6ad7eed66199172f02e06e8939c795fcd2b67f494f353cf9481851e2668af0',
 'prisma/migrations/20261006174000_pin_ai_reservation_fee/migration.sql': 'e7251d5b092930d08f5eb5522d720ab7b67f2865af84cf6bc09680655a11eabf',
 'prisma/migrations/20261006180000_pin_ai_fee_invoice_export/migration.sql': 'e9333590d4b398840d2744ec15df66e08e9f543edca99b366dd584ab581802bc',
 'prisma/migrations/20261006193000_pin_ai_connect_debit/migration.sql': '01ae270a9c47ce524bb37526c73d47cdcea5d80626abedc0abc3b6449c6c9dbb',
 'prisma/migrations/20261006200000_pin_ai_service_enrollment/migration.sql': '5cbcf2eea2e80e2ec425d61c1315b5e92b344c8c306af5892c9b716244c0c2d2',
 'prisma/schema.prisma': 'f9253a41ef0d2e0091847df3a5c8a4ae2a457bb3e0dd5bff6b114ca2d9acb0c9',
 'src/workers/reservation.worker.ts': '705d62624e3b64f3a733834e4f3941fd4f0511250c0e63bc9b6152bede86a4d2'}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate_event(event, event_name):
    require(event_name == "pull_request", "PR event required")
    require(event.get("number") == 371, "Only PR #371 is permitted")
    pr = event["pull_request"]
    require(pr["head"]["repo"]["full_name"] == pr["base"]["repo"]["full_name"] == REPO,
            "Repository mismatch")
    require(pr["head"]["ref"] == "agent/pin-ai-property-activation-v1" and pr["base"]["ref"] == "main",
            "Branch mismatch")
    return pr

def validate_changes(changed):
    require(changed == ALLOWED, f"Exact scope mismatch: {sorted(changed ^ ALLOWED)}")

def validate_bytes(path, data):
    require(hashlib.sha256(data).hexdigest() == PINNED[path], f"Reviewed bytes changed: {path}")

def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()

def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = validate_event(event, os.environ["GITHUB_EVENT_NAME"])
    git("merge-base", "--is-ancestor", pr["head"]["sha"], "HEAD")
    base = git("merge-base", pr["base"]["sha"], "HEAD")
    require(base == BASE, "Reviewed base changed; re-audit required")
    validate_changes(set(git("diff", "--name-only", base, "HEAD").splitlines()))
    for path in PINNED:
        validate_bytes(path, Path(path).read_bytes())
    git("diff", "--check", base, "HEAD")
    git("diff", "--exit-code", base, "HEAD", "--", "src/pms", "src/workers",
        "src/distribution/channex-readonly.http-transport.ts",
        "src/distribution/channex-white-label.http-transport.ts",
        "src/services/ttlock/ttlock.brain.ts", ":(exclude)src/workers/reservation.worker.ts")
    print("PR #371 exact scope and reviewed schema/migrations/worker verified; Channex core frozen")

if __name__ == "__main__":
    main()
