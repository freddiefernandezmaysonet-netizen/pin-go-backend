"""PR #376's exact reviewed scope; runtime certification steps remain enabled.

The manifest pins changed product, schema, migration and workflow bytes. It is
reviewed code, not a generated allowlist at CI runtime. Extra files and changed
bytes fail. Unchanged MFA/provider/transport files cannot enter this exception.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

CONTROLS = {
    "scripts/verify-my-cleanings-pr-scope.py",
    "scripts/verify-my-cleanings-pr-scope.test.py",
    "scripts/my-cleanings-pr-scope.json",
}


def check(changed, hashes, expected):
    if set(changed) != set(expected) | CONTROLS:
        raise ValueError(f"Exact file scope mismatch: {sorted(set(changed) ^ (set(expected) | CONTROLS))}")
    for path, digest in expected.items():
        if hashes.get(path) != digest:
            raise ValueError(f"Reviewed content mismatch: {path}")


def git(*args):
    return subprocess.check_output(["git", *args])


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    pr = event["pull_request"]
    repo = "freddiefernandezmaysonet-netizen/pin-go-backend"
    if (os.environ.get("GITHUB_EVENT_NAME") != "pull_request"
            or event["number"] != 376
            or pr["head"]["repo"]["full_name"] != repo
            or pr["base"]["repo"]["full_name"] != repo
            or pr["head"]["ref"] != "agent/cleaner-account-access-v1"
            or pr["base"]["ref"] != "main"):
        raise ValueError("Only same-repository cleaner PR #376 to main is permitted")
    base = pr["base"]["sha"]
    if base != "ba9cd60ea3a1365dd155e3d438043e84dd61e716":
        raise ValueError("Main changed; integrate and review a new scope manifest first")
    if subprocess.run(["git", "cat-file", "-e", base], capture_output=True).returncode:
        git("fetch", "--no-tags", "origin", base)
    changed = git("diff", "--name-only", base, "HEAD").decode().splitlines()
    expected = json.loads(Path("scripts/my-cleanings-pr-scope.json").read_text())
    hashes = {p: hashlib.sha256(git("show", f"HEAD:{p}")).hexdigest() for p in expected}
    check(changed, hashes, expected)
    git("diff", "--check", base, "HEAD")
    print("PR #376 exact files and reviewed content verified; runtime suites remain enabled")


if __name__ == "__main__":
    main()
