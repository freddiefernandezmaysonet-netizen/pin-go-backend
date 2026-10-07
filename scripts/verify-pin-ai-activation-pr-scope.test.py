import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("scope", Path(__file__).with_name("verify-pin-ai-activation-pr-scope.py"))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)

class ScopeTest(unittest.TestCase):
    def event(self):
        return {"number": 371, "pull_request": {
            "head": {"ref": "agent/pin-ai-property-activation-v1", "repo": {"full_name": scope.REPO}},
            "base": {"ref": "main", "repo": {"full_name": scope.REPO}}}}

    def test_exact_identity(self):
        scope.validate_event(self.event(), "pull_request")
        for key, value in [("number", 370), ("head", "fork/other"), ("base", "fork/other")]:
            event = copy.deepcopy(self.event())
            if key == "number": event[key] = value
            else: event["pull_request"][key]["repo"]["full_name"] = value
            with self.assertRaises(ValueError): scope.validate_event(event, "pull_request")
        with self.assertRaises(ValueError): scope.validate_event(self.event(), "workflow_dispatch")
        event = self.event(); event["pull_request"]["head"]["ref"] = "main"
        with self.assertRaises(ValueError): scope.validate_event(event, "pull_request")

    def test_missing_and_unexpected_files_are_rejected(self):
        scope.validate_changes(set(scope.ALLOWED))
        with self.assertRaises(ValueError): scope.validate_changes(set())
        with self.assertRaises(ValueError): scope.validate_changes(scope.ALLOWED | {"src/pms/unreviewed.ts"})
        with self.assertRaises(ValueError): scope.validate_changes(scope.ALLOWED - {"prisma/schema.prisma"})

    def test_reviewed_schema_migrations_and_worker_bytes(self):
        root = Path(__file__).resolve().parent.parent
        for path in scope.PINNED:
            data = (root / path).read_bytes()
            scope.validate_bytes(path, data)
            with self.assertRaises(ValueError): scope.validate_bytes(path, data + b"\n")

if __name__ == "__main__":
    unittest.main()
