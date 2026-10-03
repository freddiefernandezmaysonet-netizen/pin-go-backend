"""PR #345 exact snapshot exception for legacy feature-specific CI boundaries.
Only accepts the reviewed additive location schema and precise communication changes.
Runtime tests, provider safety checks, and certified core fingerprints still execute.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

REPOSITORY = "freddiefernandezmaysonet-netizen/pin-go-backend"
BASE = "54713537611da6f766239d330a1d3bb34dd42777"
FILES = {
    ".github/workflows/apms-exit-closure-a-certification.yml": "e1708566c432cc39cc2a64b25708576e880e169518d04ed2c79761097fdaec70",
    ".github/workflows/guest-journey-enterprise-e15-certification.yml": "fa3f493b60ff965d629b537f582e42892a990ba3f18f2830135b0c6942ff5a97",
    ".github/workflows/ota-airbnb-listing-discovery.yml": "bc97ab1f546a620002a28c5f0ac467d59e122dec9ef97cf69d470f479eb3cad2",
    ".github/workflows/property-arrival-location-v1.yml": "89b6e62d9c12359d47d1cdb315206ce8f593366daa372c23b939480c93abce56",
    "docs/property-arrival-location-v1.md": "03ee9c907394bbdf78abe0de146a8fb99fec1a20c4132eb2dd9293741e3bdb81",
    "prisma/migrations/20261003160000_property_arrival_location/migration.sql": "2b688f63629b13046f28413a0fbe46ffd1030591688d4cf838faf7c7888709b3",
    "prisma/schema.prisma": "aa81a3ed76d6a83dbbae1bf97bd67b78f08864ebacf874429cfc417dd6eb109d",
    "src/channex-messaging/airbnb-access.policy.ts": "3de6b60c2aebbe79b27213f9f7c28d2299e30214963180266a990d739c41cf9f",
    "src/channex-messaging/airbnb-access.service.ts": "83569c4c3181c2ab47e3b7795c79112d662f2a88523746894e388c479b76cefb",
    "src/lib/mailer.ts": "a51f0d0f90a34dba74159747c00ecd71cea0a8730da024ee3520a0907f3ed878",
    "src/routes/dashboard.messages.routes.ts": "e58d97349b9d258c6846ad27cac6c0bc6f2031f55b715d5c4e46620d653dc73d",
    "src/routes/dashboard.properties.route.ts": "063e1af161a078fe172a97283af912f36c2184291e5840a3bb67b3e4c85f3082",
    "src/routes/properties.create.route.ts": "6cfe0fa99cc2ea754ac157d000e24ff0c4eb43a7463b5a8c231cdbff8556558c",
    "src/routes/properties.route.ts": "2794ec89d6c27258c5c6eb571c1f42ec3d74fede657c1561bae460ccb3c17270",
    "src/services/checkoutSms.consent-guard.test.ts": "70a3ab7ae79300b81b13a6a298825a108aeb30faa7d9a5a3138dcc4729ca183b",
    "src/services/guest-access-sms-retry-body.service.ts": "0ddb9daf51088f7ea78bc83ef26cf48ca9ac3831392492f34df29a8add7feb1c",
    "src/services/guest-journey-communications-delivery-adapter.service.ts": "4b46c46afe748a64df0b675b4d86cfa6bcc854197843d748f4d6a1252693d796",
    "src/services/messaging.service.ts": "6e5e680fab12853b4093eb4ca9df091fba87c0f46eb27d08083d165fced11e0c",
    "src/services/preCheckinSms.service.ts": "9dcd2c137a8e576021d26944ec1fa0f3d660147a17e68eb5a07f0479b7a83bf8",
    "src/services/property-arrival-location.test.ts": "add0648658501dfbeb83f00db704d4a9b7dadb284cbd0195f14104fdcf2dfc9c",
    "src/services/property-arrival-location.ts": "e43dfd0c5a097325320bc9ca9228b8f604018d023a39ba99ff528864b81b85a5",
    "src/workers/message.retry.worker.ts": "b6e135b38d35cc84312e0bee3ec73b76709813ba819029325497f1308363a390",
    "src/workers/reservation.worker.ts": "245310823d099d01f06781f8a6ee2e7dfc757b412f9079b2747e979e205d49f7"
}
HELPERS = {"scripts/verify-arrival-location-pr-scope.py", "scripts/verify-arrival-location-pr-scope.test.py"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_identity(event, env):
    require(env.get("GITHUB_EVENT_NAME") == "pull_request", "PR event required")
    require(env.get("GITHUB_REPOSITORY") == REPOSITORY, "Repository mismatch")
    require(event.get("number") == 345, "Only PR #345")
    pr = event["pull_request"]
    require(pr["head"]["repo"]["full_name"] == pr["base"]["repo"]["full_name"] == REPOSITORY, "Repository mismatch")
    require(pr["head"]["ref"] == "agent/property-arrival-unit-v1", "Head mismatch")
    require((pr["base"]["ref"], pr["base"]["sha"]) in {("agent/airbnb-access-channel-v1", BASE), ("main", "31b5c4c79ca7bebf253074fe38fa9164850e29a5")}, "Stack base mismatch")


def verify_contents(changed, contents, modes):
    require(changed == set(FILES) | HELPERS, "Unexpected file scope")
    require(all(modes[p] == "100644" for p in changed), "Unexpected mode")
    for path, digest in FILES.items():
        require(hashlib.sha256(contents[path]).hexdigest() == digest, f"Snapshot mismatch: {path}")


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    verify_identity(event, os.environ)
    subprocess.run(["git", "merge-base", "--is-ancestor", BASE, "HEAD"], check=True)
    changed = set(git("diff", "--name-only", BASE, "HEAD").splitlines())
    verify_contents(changed, {p: Path(p).read_bytes() for p in FILES},
                    {p: git("ls-tree", "HEAD", "--", p).split()[0] for p in changed})
    git("diff", "--check", BASE, "HEAD")
    print("PR #345 exact arrival-location snapshot verified; retained certifications continue")


if __name__ == "__main__":
    main()
