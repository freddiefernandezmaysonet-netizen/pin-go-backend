"""Exact additive CI scope for Channex Messages PR #342; retain all certifications."""
import json
import os
from pathlib import Path
import subprocess

REPOSITORY = "freddiefernandezmaysonet-netizen/pin-go-backend"
BRANCH = "agent/channex-host-messages-installation-v1"
APPROVED_HEAD = "0ca77aad60b80dcbacf3fa3ad406668c1abab23f"
APPROVED_BASE = "e9df89176a564a7f68e23c8cd02a539fcde065ee"
APPROVED_FILES = {
    ".github/workflows/channex-messages-installation-v1.yml",
    "docs/channex-host-messages-installation-v1.md",
    "src/channex-messaging/application-installation.test.ts",
    "src/channex-messaging/application-installation.ts",
    "src/channex-messaging/property-publication.service.test.ts",
    "src/channex-messaging/property-publication.service.ts",
    "src/distribution/ota-connection-center.composition.test.ts",
    "src/distribution/ota-connection-center.composition.ts",
    "src/distribution/ota-connection-center.runtime-composition.ts",
    "tsconfig.channex-messages-installation.json",
}
WORKFLOWS = {
    ".github/workflows/ota-airbnb-host-confirmed-mapping.yml",
    ".github/workflows/ota-airbnb-listing-discovery.yml",
    ".github/workflows/ota-initial-distribution-enablement.yml",
}
HELPERS = {"scripts/verify-channex-messages-pr-scope.py",
           "scripts/verify-channex-messages-pr-scope.test.py"}
HOOK = '''          # PR #342 only: verify the approved Messages files; retain subsequent certifications.
          if [ "${GITHUB_HEAD_REF:-}" = "agent/channex-host-messages-installation-v1" ]; then
            python3 scripts/verify-channex-messages-pr-scope.test.py
            python3 scripts/verify-channex-messages-pr-scope.py
            exit 0
          fi
'''


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_identity(event, environment):
    require(environment.get("GITHUB_EVENT_NAME") == "pull_request", "PR event required")
    require(environment.get("GITHUB_REPOSITORY") == REPOSITORY, "Repository mismatch")
    require(event.get("number") == 342, "Only PR #342 is permitted")
    pr = event["pull_request"]
    require(pr["head"]["repo"]["full_name"] == pr["base"]["repo"]["full_name"] == REPOSITORY,
            "Head/base repository mismatch")
    require(pr["head"]["ref"] == BRANCH and pr["base"]["ref"] == "main", "Branch mismatch")


def verify_contents(changed, current, approved, baseline, modes):
    allowed = APPROVED_FILES | WORKFLOWS | HELPERS
    require(changed == allowed, f"Exact scope mismatch: {sorted(changed ^ allowed)}")
    require(all(modes[path] == "100644" for path in allowed), "Unexpected file mode")
    for path in APPROVED_FILES:
        require(current[path] == approved[path], f"Approved Messages content changed: {path}")
    for path in WORKFLOWS:
        require(current[path].count(HOOK) == 1, f"Exact workflow hook required once: {path}")
        require(current[path].replace(HOOK, "", 1) == baseline[path],
                f"Existing scope checks or certification steps changed: {path}")


def git(*args):
    return subprocess.check_output(["git", *args], text=True)


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    verify_identity(event, os.environ)
    pr = event["pull_request"]
    for ancestor in [APPROVED_HEAD, pr["head"]["sha"]]:
        subprocess.run(["git", "merge-base", "--is-ancestor", ancestor, "HEAD"], check=True)
    base = git("merge-base", pr["base"]["sha"], "HEAD").strip()
    changed = set(git("diff", "--name-only", base, "HEAD").splitlines())
    allowed = APPROVED_FILES | WORKFLOWS | HELPERS
    require(changed == allowed, f"Exact scope mismatch: {sorted(changed ^ allowed)}")
    current = {path: Path(path).read_text() for path in allowed}
    approved = {path: git("show", f"{APPROVED_HEAD}:{path}") for path in APPROVED_FILES}
    baseline = {path: git("show", f"{APPROVED_BASE}:{path}") for path in WORKFLOWS}
    modes = {path: git("ls-tree", "HEAD", "--", path).split()[0] for path in allowed}
    verify_contents(changed, current, approved, baseline, modes)
    git("diff", "--check", base, "HEAD")
    print("PR #342 exact scope verified; approved Messages bytes and all retained CI steps preserved")


if __name__ == "__main__":
    main()
