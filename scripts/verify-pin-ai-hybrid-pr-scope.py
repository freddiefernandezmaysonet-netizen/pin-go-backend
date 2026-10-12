"""PR #407 exact billing boundary. Runtime certifications remain enabled."""
import json
import os
from pathlib import Path
import subprocess

BASE = "e99961e39aac45a89140e4033f0e475537195496"
REPO = "freddiefernandezmaysonet-netizen/pin-go-backend"
ALLOWED = {'.github/workflows/apms-exit-closure-a-certification.yml', 'src/pin-ai/hybrid-fee-stripe.provider.test.ts', 'src/pin-ai/reservation-service-evidence.ts', 'src/services/direct-booking.service.ts', 'prisma/migrations/20261012000000_pin_ai_hybrid_fee/migration.sql', 'src/workers/reservation.worker.ts', 'docs/pin-ai-hybrid-reservation-fee-v2.md', '.github/workflows/ota-airbnb-listing-discovery.yml', 'src/pin-ai/hybrid-fee.database.test.ts', 'src/services/reservations.service.ts', 'src/pin-ai/hybrid-fee.service.ts', 'src/services/ingest.service.ts', 'src/routes/dashboard.pin-ai-activation.routes.ts', 'src/services/cleaning-pin-ai-activation.service.ts', 'src/routes/public-booking.routes.ts', 'src/pin-ai/property-activation.ts', 'src/routes/dashboard.pin-ai-activation.routes.test.ts', 'src/services/pin-ai-activation.service.ts', 'scripts/verify-pin-ai-hybrid-pr-scope.py', 'src/pin-ai/hybrid-fee-stripe.provider.ts', 'prisma/schema.prisma', 'src/pin-ai/hybrid-fee-evidence.service.ts', '.github/workflows/guest-journey-enterprise-e15-certification.yml', 'tsconfig.pin-ai-hybrid-billing.json', 'src/services/cleaning-pin-ai-activation.service.test.ts', '.github/workflows/pin-ai-connect-native-certification.yml', 'src/services/direct-booking-refund.service.ts', 'src/pin-ai/billing-terms.ts'}
NEW_COLUMNS = """  collectionMethod String?
  stripePaymentIntentId String?
  stripeApplicationFeeId String?
  stripeReversalId String? @unique
  reversedAt DateTime?
  reversalStartedAt DateTime?
  reversalRequest Json?
"""

def verify(files, before, after):
    if set(files) != ALLOWED:
        raise ValueError("HYBRID_SCOPE_FILES_MISMATCH")
    if after.count(NEW_COLUMNS) != 1 or after.replace(NEW_COLUMNS, "", 1) != before:
        raise ValueError("HYBRID_SCOPE_SCHEMA_MISMATCH")

if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event.get("pull_request", {})
    if (os.environ.get("GITHUB_EVENT_NAME") != "pull_request" or event.get("number") != 407 or
        os.environ.get("GITHUB_REPOSITORY") != REPO or pr.get("base", {}).get("ref") != "main" or
        pr.get("head", {}).get("ref") != "agent/pin-ai-hybrid-billing" or
        pr.get("head", {}).get("repo", {}).get("full_name") != REPO or
        pr.get("base", {}).get("repo", {}).get("full_name") != REPO):
        raise SystemExit("HYBRID_SCOPE_EVENT_MISMATCH")
    subprocess.run(["git", "diff", "--check", BASE + "...HEAD"], check=True)
    files = subprocess.check_output(["git", "diff", "--name-only", BASE + "...HEAD"], text=True).splitlines()
    before = subprocess.check_output(["git", "show", BASE + ":prisma/schema.prisma"], text=True)
    verify(files, before, Path("prisma/schema.prisma").read_text())
    print("PR #407 exact billing scope and seven nullable ledger columns verified; retaining runtime certifications")
