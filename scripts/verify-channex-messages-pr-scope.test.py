"""Negative tests for the PR-specific CI scope verifier; no provider/database I/O."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("scope", Path(__file__).with_name("verify-channex-messages-pr-scope.py"))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)


class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.event = {"number": 342, "pull_request": {
            "head": {"repo": {"full_name": scope.REPOSITORY}, "ref": scope.BRANCH},
            "base": {"repo": {"full_name": scope.REPOSITORY}, "ref": "main"},
        }}
        self.environment = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": scope.REPOSITORY}
        self.allowed = scope.APPROVED_FILES | scope.WORKFLOWS | scope.HELPERS
        self.approved = {p: f"approved:{p}\n" for p in scope.APPROVED_FILES}
        self.baseline = {p: f"original scope checks:{p}\nretained certification commands\n" for p in scope.WORKFLOWS}
        self.current = {**self.approved, **{p: scope.HOOK + self.baseline[p] for p in scope.WORKFLOWS},
                        **{p: "helper\n" for p in scope.HELPERS}}
        self.modes = {p: "100644" for p in self.allowed}

    def verify(self, changed=None, current=None, modes=None):
        scope.verify_contents(self.allowed if changed is None else changed,
                              self.current if current is None else current,
                              self.approved, self.baseline, self.modes if modes is None else modes)

    def test_exact_scope_accepts_only_additive_hooks(self):
        scope.verify_identity(self.event, self.environment)
        self.verify()

    def test_other_pr_is_rejected(self):
        self.event["number"] = 343
        with self.assertRaisesRegex(ValueError, "Only PR"):
            scope.verify_identity(self.event, self.environment)

    def test_other_repo_fork_and_branch_are_rejected(self):
        for location, value in [("repo", "other/repo"), ("ref", "other-branch")]:
            event = copy.deepcopy(self.event)
            if location == "repo": event["pull_request"]["head"]["repo"]["full_name"] = value
            else: event["pull_request"]["head"]["ref"] = value
            with self.assertRaises(ValueError): scope.verify_identity(event, self.environment)

    def test_non_pr_event_and_other_destination_are_rejected(self):
        for key, value in [("GITHUB_EVENT_NAME", "push"), ("GITHUB_REPOSITORY", "other/repo")]:
            environment = {**self.environment, key: value}
            with self.assertRaises(ValueError): scope.verify_identity(self.event, environment)

    def test_added_or_missing_file_is_rejected(self):
        for changed in [self.allowed | {"src/server.ts"}, self.allowed - {next(iter(scope.APPROVED_FILES))}]:
            with self.assertRaisesRegex(ValueError, "Exact scope"):
                self.verify(changed=changed)

    def test_changed_approved_application_file_is_rejected(self):
        for path in scope.APPROVED_FILES:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Approved Messages"):
                self.verify(current={**self.current, path: self.current[path] + "unexpected change"})

    def test_deleted_or_modified_certification_command_is_rejected(self):
        for path in scope.WORKFLOWS:
            current = {**self.current, path: self.current[path].replace("retained certification commands", "exit 0")}
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "certification steps changed"):
                self.verify(current=current)

    def test_missing_duplicate_or_modified_hook_is_rejected(self):
        path = next(iter(scope.WORKFLOWS))
        for content in [self.baseline[path], scope.HOOK + self.current[path],
                        self.current[path].replace("exit 0", "exit 1", 1)]:
            with self.assertRaisesRegex(ValueError, "workflow hook"):
                self.verify(current={**self.current, path: content})

    def test_unexpected_file_mode_is_rejected(self):
        path = next(iter(self.allowed))
        with self.assertRaisesRegex(ValueError, "file mode"):
            self.verify(modes={**self.modes, path: "120000"})


if __name__ == "__main__":
    unittest.main()
