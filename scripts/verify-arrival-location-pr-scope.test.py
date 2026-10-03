import copy
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('scope', Path(__file__).with_name('verify-arrival-location-pr-scope.py'))
scope = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scope)

class ScopeTests(unittest.TestCase):
    def setUp(self):
        self.event = {'number':345, 'pull_request': {
            'head': {'ref':'agent/property-arrival-unit-v1', 'repo':{'full_name':scope.REPOSITORY}},
            'base': {'ref':'agent/airbnb-access-channel-v1', 'sha':scope.BASE, 'repo':{'full_name':scope.REPOSITORY}}}}
        self.env = {'GITHUB_EVENT_NAME':'pull_request', 'GITHUB_REPOSITORY':scope.REPOSITORY}
        self.changed = set(scope.FILES) | scope.HELPERS
        self.contents = {p:Path(p).read_bytes() for p in scope.FILES}
        self.modes = {p:'100644' for p in self.changed}

    def test_exact_identity_and_snapshot(self):
        scope.verify_identity(self.event, self.env)
        promoted = copy.deepcopy(self.event)
        promoted["pull_request"]["base"].update(ref="main", sha="31b5c4c79ca7bebf253074fe38fa9164850e29a5")
        scope.verify_identity(promoted, self.env)
        scope.verify_contents(self.changed, self.contents, self.modes)

    def test_other_pr_fork_branch_and_base_rejected(self):
        cases = [(['number'],346), (['pull_request','head','repo','full_name'],'other/repo'),
                 (['pull_request','head','ref'],'other'), (['pull_request','base','sha'],'other'),
                 (['pull_request','base','ref'],'main')]
        for keys,value in cases:
            event=copy.deepcopy(self.event); target=event
            for key in keys[:-1]: target=target[key]
            target[keys[-1]]=value
            with self.assertRaises(ValueError): scope.verify_identity(event,self.env)
        with self.assertRaises(ValueError): scope.verify_identity(self.event, {**self.env,'GITHUB_EVENT_NAME':'push'})

    def test_extra_missing_file_and_mode_rejected(self):
        for changed in [self.changed|{'src/services/ttlock/ttlock.brain.ts'}, self.changed-{'prisma/schema.prisma'}]:
            with self.assertRaises(ValueError): scope.verify_contents(changed,self.contents,self.modes)
        with self.assertRaises(ValueError): scope.verify_contents(self.changed,self.contents,{**self.modes,'prisma/schema.prisma':'120000'})

    def test_all_snapshot_mutations_rejected(self):
        for path in scope.FILES:
            with self.subTest(path=path), self.assertRaises(ValueError):
                scope.verify_contents(self.changed,{**self.contents,path:self.contents[path]+b'\n'},self.modes)

if __name__ == '__main__': unittest.main()
