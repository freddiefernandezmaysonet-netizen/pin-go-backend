"""Fail-closed certification boundary for Staff Preferred Language PR #328 only."""
import json
import os
from pathlib import Path
import subprocess
import sys

def git(*args):
    return subprocess.check_output(["git", *args], text=True)

def require(condition, message):
    if not condition:
        sys.exit(message)

event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
pr = event["pull_request"]
repo = "freddiefernandezmaysonet-netizen/pin-go-backend"
require(os.environ["GITHUB_EVENT_NAME"] == "pull_request", "PR event required")
require(event["number"] == 328, "Only PR #328 is permitted")
require(pr["head"]["repo"]["full_name"] == pr["base"]["repo"]["full_name"] == repo, "Repository mismatch")
require(pr["head"]["ref"] == "agent/staff-preferred-language-v1" and pr["base"]["ref"] == "main", "Branch mismatch")
base = git("merge-base", pr["base"]["sha"], "HEAD").strip()
allowed = {
    '.github/workflows/apms-exit-closure-a-certification.yml',
    '.github/workflows/cleaning-followup-v1-foundation.yml',
    '.github/workflows/guest-journey-enterprise-e15-certification.yml',
    '.github/workflows/ota-airbnb-listing-discovery.yml',
    'prisma/migrations/20260930210000_staff_preferred_language_v1/migration.sql',
    'prisma/schema.prisma',
    'scripts/verify-staff-language-pr-scope.py',
    'src/guest-mobile/guest-mobile-http.contract.test.ts',
    'src/routes/cleaning-completion-mobile.response.test.js',
    'src/routes/cleaning-confirm.language.test.ts',
    'src/routes/cleaning-confirm.routes.ts',
    'src/routes/staff.routes.ts',
    'src/services/cleaner-timing-mobile-ui.contract.test.js',
    'src/services/cleaning-confirmation-dispatch.service.ts',
    'src/services/cleaning-confirmation-sms-body.service.ts',
    'src/services/cleaning-followup-delivery.service.ts',
    'src/services/cleaning-followup-sms-body.service.ts',
    'src/services/cleaning-ready-sms-body.service.ts',
    'src/services/cleaning-timing-property-timezone.contract.test.js',
    'src/services/cleaningReadySms.service.ts',
    'src/services/manual-reservation-cleaner-cancellation-notification.service.ts',
    'src/services/messaging.service.ts',
    'src/services/staff-language.service.test.ts',
    'src/services/staff-language.service.ts',
    'src/services/staff-preferred-language.contract.test.ts',
    'src/workers/reservation.worker.ts',
}
changed = set(git("diff", "--name-only", base, "HEAD").splitlines())
require(changed == allowed, f"Exact scope mismatch: {sorted(changed ^ allowed)}")
schema = "prisma/schema.prisma"
old = git("show", f"{base}:{schema}")
addition = '  preferredLanguage String         @default("en") @db.VarChar(5)\n'
current = Path(schema).read_text()
require(current.count(addition) == 1, "Preferred language field must occur once")
require(current.replace(addition, "", 1) == old, "Unexpected schema change")
model = current.split("model StaffMember {", 1)[1].split("\n}", 1)[0]
require(addition.strip() in model, "Field must belong to StaffMember")
migration = Path("prisma/migrations/20260930210000_staff_preferred_language_v1/migration.sql").read_text()
require(migration == 'ALTER TABLE "StaffMember"\nADD COLUMN "preferredLanguage" VARCHAR(5) NOT NULL DEFAULT \'en\';\n', "Unexpected migration")
git("diff", "--check", base, "HEAD")
print("PR #328 exact scope, additive StaffMember schema and migration verified")
