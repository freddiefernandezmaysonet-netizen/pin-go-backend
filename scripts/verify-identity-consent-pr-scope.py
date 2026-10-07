import hashlib, json, os, subprocess
from pathlib import Path
BASE = "c97cb69f7c8e531bced491cdd5588c2c74510963"
REPO = "freddiefernandezmaysonet-netizen/pin-go-backend"
EXPECTED = {'prisma/migrations/20261006231500_identity_check_host_consent/migration.sql', 'docs/identity-check-host-consent-v1.md', '.github/workflows/ota-airbnb-listing-discovery.yml', 'src/routes/dashboard.guest-access-settings.routes.ts', 'src/services/identity-check-billing-consent.ts', 'src/services/internal-demo-secure-precheckin.service.test.ts', 'src/services/internal-demo-commercial.db.test.ts', 'src/services/identity-check-billing-consent.test.ts', 'src/routes/public-booking.routes.ts', 'tsconfig.identity-check-host-consent.json', 'scripts/verify-identity-consent-pr-scope.py', '.github/workflows/identity-check-host-consent.yml', 'prisma/schema.prisma', 'scripts/verify-identity-consent-pr-scope.test.py', 'src/routes/dashboard.identity-check-consent.routes.test.ts'}
HASHES = {'prisma/schema.prisma': '25dcf05f9ebe76b6afe5cd08179ec8a91691ecc4a1d5ab1e580c1e80e432c293', 'prisma/migrations/20261006231500_identity_check_host_consent/migration.sql': '7b5e1eb927704d84e4418e872827f6f90262bd9675b4c1f2bd7ec3cb1b5f7472', 'src/routes/public-booking.routes.ts': '80b4f6a0de69fba899661a9cde2c3c9fabe7a81bcb98a185a17238ff0c5853b2', 'src/routes/dashboard.guest-access-settings.routes.ts': '58ad591ab029d24669296895259d64c731c30589de56de362dfa36b943ae0e0b', 'src/services/identity-check-billing-consent.ts': '685e3d0c61416864ba1df9273a4f0ee46e68c7fe60f47ae5ef26ab7380c7bff0'}
def validate_event(event, env):
    pr = event["pull_request"]
    assert env.get("GITHUB_EVENT_NAME") == "pull_request" and env.get("GITHUB_REPOSITORY") == REPO
    assert pr["number"] == 372 and pr["head"]["repo"]["full_name"] == REPO and pr["base"]["repo"]["full_name"] == REPO
    assert pr["head"]["ref"] == "agent/identity-check-host-consent-v1" and pr["base"]["ref"] == "main"
def validate_snapshot(changed, hashes):
    assert set(changed) == EXPECTED, "Unexpected Identity Check PR scope"
    assert hashes == HASHES, "Reviewed billing/checkout implementation changed"
def git(*args):
    return subprocess.check_output(["git", *args], text=True)
def main():
    validate_event(json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()), os.environ)
    assert git("merge-base", "origin/main", "HEAD").strip() == BASE
    validate_snapshot(git("diff", "--name-only", BASE, "HEAD").splitlines(),
        {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in HASHES})
    assert not git("diff", "--name-only", BASE, "HEAD", "src/pms", "src/distribution", "src/workers", "src/pin-ai").strip()
    print("Exact PR #372 consent scope verified; OTA and runtime protections retained.")
if __name__ == "__main__": main()
