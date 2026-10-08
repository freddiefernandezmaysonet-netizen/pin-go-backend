import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("scope", Path(__file__).with_name("verify-my-cleanings-pr-scope.py"))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def test_accepts_exact_reviewed_scope(self):
        scope.check(scope.CONTROLS | {"reviewed"}, {"reviewed": "digest"}, {"reviewed": "digest"})

    def test_rejects_unreviewed_auth_provider_or_migration(self):
        for path in ["src/auth/mfa-login.routes.ts", "src/services/ttlock/ttlock.brain.ts", "prisma/migrations/unreviewed/migration.sql"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                scope.check(scope.CONTROLS | {"reviewed", path}, {"reviewed": "digest"}, {"reviewed": "digest"})

    def test_rejects_modified_or_missing_reviewed_bytes(self):
        for hashes in [{}, {"reviewed": "tampered"}]:
            with self.assertRaises(ValueError):
                scope.check(scope.CONTROLS | {"reviewed"}, hashes, {"reviewed": "digest"})

    def test_rejects_removed_reviewed_file(self):
        with self.assertRaises(ValueError):
            scope.check(scope.CONTROLS, {}, {"reviewed": "digest"})


if __name__ == "__main__":
    unittest.main()
