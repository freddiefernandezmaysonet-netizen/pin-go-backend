from __future__ import annotations

from pathlib import Path
import hashlib
import sys

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
BUNDLE = Path(__file__).resolve().parents[1]

EXPECTED_SHA1 = {
    "src/workers/reservation.worker.ts": "0a7d37bb5b8d23e109c043347e6fd74673c3ab81",
    "src/services/guest-journey-access-owner-cycle.service.test.ts": "e28f0ff13adac9d476a2c50762703ba6bbe8bc53",
    "src/e14/guest-access-worker-integration.e14.test.ts": "5fd2e4d4bd25d3c7de5a2b18139eb53818806451",
}

def git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()

def require_exact(path: Path, expected: str) -> str:
    if not path.exists():
        raise SystemExit(f"MISSING_BASE_FILE:{path}")
    data = path.read_bytes()
    actual = git_blob_sha1(data)
    if actual != expected:
        raise SystemExit(f"SOURCE_DRIFT:{path}:{actual}:expected:{expected}")
    return data.decode("utf-8")

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"REPLACEMENT_CARDINALITY:{label}:{count}")
    return text.replace(old, new, 1)

# Verify all existing files before writing anything. This is transactional at
# the source-file level: any drift aborts before the first mutation.
worker_path = ROOT / "src/workers/reservation.worker.ts"
e8_test_path = ROOT / "src/services/guest-journey-access-owner-cycle.service.test.ts"
e14_test_path = ROOT / "src/e14/guest-access-worker-integration.e14.test.ts"
worker = require_exact(worker_path, EXPECTED_SHA1[str(worker_path.relative_to(ROOT))])
require_exact(e8_test_path, EXPECTED_SHA1[str(e8_test_path.relative_to(ROOT))])
require_exact(e14_test_path, EXPECTED_SHA1[str(e14_test_path.relative_to(ROOT))])

fragments = BUNDLE / "patches/fragments"
worker = replace_once(worker, (fragments / "import.base").read_text(), (fragments / "import.new").read_text(), "worker-import")
worker = replace_once(worker, (fragments / "checkin.base").read_text(), (fragments / "checkin.new").read_text(), "worker-provisioning")
worker = replace_once(worker, (fragments / "checkout.base").read_text(), (fragments / "checkout.new").read_text(), "worker-revocation")

# Only after every base and replacement cardinality check has passed do writes occur.
worker_path.write_text(worker)
(ROOT / "src/services/guest-journey-access-owner-handoff.service.ts").write_text(
    (BUNDLE / "src/services/guest-journey-access-owner-handoff.service.ts").read_text()
)
e8_test_path.write_text(
    (BUNDLE / "src/services/guest-journey-access-owner-cycle.service.test.ts").read_text()
)
e14_test_path.write_text(
    (BUNDLE / "src/e14/guest-access-worker-integration.e14.test.ts").read_text()
)

print("access_cutover_transform=PASS")
