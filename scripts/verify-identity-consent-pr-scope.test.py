import importlib.util, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location("guard", Path(__file__).with_name("verify-identity-consent-pr-scope.py"))
guard = importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
class GuardTests(unittest.TestCase):
    def test_exact_snapshot(self): guard.validate_snapshot(guard.EXPECTED, guard.HASHES)
    def test_extra_file(self):
        with self.assertRaises(AssertionError): guard.validate_snapshot(guard.EXPECTED | {"src/workers/reservation.worker.ts"}, guard.HASHES)
    def test_changed_billing(self):
        hashes = dict(guard.HASHES); hashes["src/routes/public-booking.routes.ts"] = "wrong"
        with self.assertRaises(AssertionError): guard.validate_snapshot(guard.EXPECTED, hashes)
    def test_wrong_pull_request(self):
        repo = {"full_name": guard.REPO}
        event = {"pull_request": {"number": 371, "head": {"repo": repo, "ref": "agent/identity-check-host-consent-v1"}, "base": {"repo": repo, "ref": "main"}}}
        with self.assertRaises(AssertionError): guard.validate_event(event, {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": guard.REPO})
unittest.main()
