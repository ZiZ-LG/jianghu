import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('ci_validation', Path(__file__).with_name('ci_validation.py'))
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)
NOW = 1792783000


def manifest(run_id=10):
    return {
        'schema': 1, 'repository': 'ZiZ-LG/jianghu', 'event': 'pull_request',
        'run_id': run_id, 'attempt': 1, 'created_epoch': NOW - 3600,
        'head_sha': 'a' * 40, 'base_sha': 'b' * 40, 'branch': 'codex/test',
        'head_repository': 'ZiZ-LG/jianghu', 'pr': 57, 'mode': 'full',
        'full_source': None, 'fingerprint': 'same-inputs',
        'documents_valid': True,
        'documents': {p: {'mode': '100644', 'oid': 'old-doc'} for p in v.DOCS},
    }


def current():
    x = manifest(20)
    x.update(head_sha='c' * 40, created_epoch=NOW)
    x['documents'] = {p: {'mode': '100644', 'oid': 'new-doc'} for p in v.DOCS}
    return x


class API:
    def __init__(self):
        self.records = {10: manifest()}
        self.runs = {10: {
            'id': 10, 'status': 'completed', 'conclusion': 'success',
            'path': '.github/workflows/ci.yml', 'updated_at': '2026-10-23T18:00:00Z',
            'run_attempt': 1, 'head_sha': 'a' * 40, 'event': 'pull_request',
            'head_branch': 'codex/test',
        }}
        self.job_rows = {10: [
            {'name': n, 'status': 'completed', 'conclusion': 'success'}
            for n in v.REQUIRED | {'validation-plan', 'validation-gate'}]}
        self.previous = 10
        self.calls = []

    def latest(self, branch, exclude, head=None):
        self.calls.append(('latest', branch, head))
        return self.runs.get(self.previous)

    def full_run(self, run_id):
        self.calls.append(('run', run_id))
        return self.runs[run_id]

    def manifest(self, run):
        self.calls.append(('manifest', run['id']))
        return copy.deepcopy(self.records[run['id']])

    def jobs(self, run):
        return self.job_rows[run['id']]


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.api = API()
        self.c = current()

    def choose(self, ancestor=True):
        return v.decide(self.c, self.api, NOW, lambda *_: ancestor)

    def test_document_descendant_uses_real_full_execution(self):
        r = self.choose()
        self.assertEqual(r['mode'], 'reuse')
        self.assertEqual(r['full_source'], 10)
        self.assertEqual(r['head_sha'], self.c['head_sha'])

    def test_all_required_tests_have_to_succeed(self):
        for name in v.REQUIRED:
            for status, conclusion in [('in_progress', None), ('completed', 'failure'),
                                       ('completed', 'skipped'), ('completed', 'cancelled')]:
                with self.subTest(name=name, status=status, conclusion=conclusion):
                    self.api = API()
                    row = next(x for x in self.api.job_rows[10] if x['name'] == name)
                    row.update(status=status, conclusion=conclusion)
                    self.assertEqual(self.choose()['mode'], 'full')

    def test_workflow_result_is_required_even_if_jobs_green(self):
        for status, conclusion in [('in_progress', None), ('completed', 'failure'),
                                   ('queued', None), ('completed', 'cancelled')]:
            self.api = API()
            self.api.runs[10].update(status=status, conclusion=conclusion)
            self.assertEqual(self.choose()['mode'], 'full')

    def test_no_older_green_fallback_after_latest_failure(self):
        self.api.runs[10]['conclusion'] = 'failure'
        self.assertEqual(self.choose()['mode'], 'full')
        self.assertNotIn(('latest', 'main', self.c['base_sha']), self.api.calls)

    def test_exact_attempt_and_artifact_identity(self):
        for key, value in [('run_id', 9), ('attempt', 2), ('head_sha', 'd' * 40),
                           ('repository', 'somewhere/else'), ('event', 'push'),
                           ('branch', 'other'), ('schema', 0)]:
            self.api = API()
            self.api.records[10][key] = value
            with self.subTest(key=key):
                self.assertEqual(self.choose()['mode'], 'full')

    def test_prior_attempt_success_does_not_cover_new_attempt(self):
        self.api.runs[10]['run_attempt'] = 2
        self.assertEqual(self.choose()['mode'], 'full')

    def test_changed_input_base_pr_or_head_repository_requires_full(self):
        for key, value in [('fingerprint', 'different-code'), ('base_sha', 'e' * 40),
                           ('pr', 58), ('head_repository', 'fork/jianghu')]:
            self.api = API()
            self.api.records[10][key] = value
            with self.subTest(key=key):
                self.assertEqual(self.choose()['mode'], 'full')
        self.api = API()
        self.assertEqual(self.choose(ancestor=False)['mode'], 'full')

    def test_unknown_or_nonregular_docs_require_full(self):
        self.c['documents_valid'] = False
        self.assertEqual(self.choose()['mode'], 'full')
        self.c = current()
        self.api.records[10]['documents_valid'] = False
        self.assertEqual(self.choose()['mode'], 'full')

    def test_missing_duplicate_and_extra_jobs_require_full(self):
        rows = self.api.job_rows[10]
        for changed in [rows[:-1], rows + [rows[0]], rows + [
            {'name': 'unknown-check', 'status': 'completed', 'conclusion': 'success'}]]:
            self.api.job_rows[10] = changed
            self.assertEqual(self.choose()['mode'], 'full')

    def test_stale_and_future_evidence_requires_full(self):
        for t in [NOW - v.MAX_AGE - 1, NOW + 1]:
            self.api.records[10]['created_epoch'] = t
            self.assertEqual(self.choose()['mode'], 'full')
        self.api = API()
        self.api.runs[10]['updated_at'] = '2026-10-22T18:00:00Z'
        self.assertEqual(self.choose()['mode'], 'full')

    def test_main_manual_unknown_event_and_rerun_always_full(self):
        for event in ['push', 'workflow_dispatch', 'merge_group', 'something-unknown']:
            self.c = current()
            self.c['event'] = event
            self.assertEqual(self.choose()['mode'], 'full')
            self.assertEqual(self.api.calls, [])
        self.c = current()
        self.c['attempt'] = 2
        self.assertEqual(self.choose()['mode'], 'full')

    def test_no_document_change_is_not_a_docs_only_shortcut(self):
        self.c['documents'] = manifest()['documents']
        self.assertEqual(self.choose()['mode'], 'full')

    def test_repeated_docs_keep_original_full_source_and_age(self):
        # The latest run may already reuse: verify it AND the original full run.
        self.api.records[11] = manifest(11)
        self.api.records[11].update(mode='reuse', full_source=10, head_sha='d' * 40,
                                    created_epoch=NOW - 300)
        self.api.runs[11] = dict(self.api.runs[10], id=11, head_sha='d' * 40)
        self.api.job_rows[11] = copy.deepcopy(self.api.job_rows[10])
        self.api.previous = 11
        self.assertEqual(self.choose()['full_source'], 10)
        self.api.runs[10]['conclusion'] = 'failure'
        self.assertEqual(self.choose()['mode'], 'full')
        self.api.runs[10]['conclusion'] = 'success'
        self.api.records[10]['created_epoch'] = NOW - v.MAX_AGE - 1
        self.assertEqual(self.choose()['mode'], 'full')

    def test_reused_execution_cannot_be_promoted_to_full(self):
        self.api.records[10].update(mode='reuse', full_source=10)
        self.assertEqual(self.choose()['mode'], 'full')

    def test_api_error_or_missing_archive_requires_full(self):
        for error in [ValueError('missing'), KeyError('missing'),
                      subprocess.TimeoutExpired('gh', 30), zipfile.BadZipFile('bad')]:
            with patch.object(self.api, 'manifest', side_effect=error):
                self.assertEqual(self.choose()['mode'], 'full')

    def test_exact_base_main_can_cover_a_new_docs_pr(self):
        self.api.records[10].update(event='push', branch='main', pr=None,
                                    head_sha=self.c['base_sha'])
        self.api.runs[10].update(event='push', head_branch='main',
                                 head_sha=self.c['base_sha'])
        with patch.object(self.api, 'latest', side_effect=[None, self.api.runs[10]]):
            self.assertEqual(self.choose()['mode'], 'reuse')
        self.api.records[10]['head_sha'] = 'f' * 40
        self.api.runs[10]['head_sha'] = 'f' * 40
        self.assertEqual(self.choose()['mode'], 'full')


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = Path.cwd()
        os.chdir(self.temp.name)
        subprocess.run(['git', 'init', '-q'], check=True)
        for p in v.DOCS:
            f = Path(p)
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text('中文说明\n')
        Path('app.ts').write_text('original code\n')
        self.commit()

    def tearDown(self):
        os.chdir(self.old)
        self.temp.cleanup()

    def commit(self):
        subprocess.run(['git', 'add', '.'], check=True)
        subprocess.run(['git', '-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid',
                        'commit', '-qm', 'fixture'], check=True)

    def test_only_allowlisted_document_changes_preserve_input_hash(self):
        before = v.inventory()
        Path(next(iter(v.DOCS))).write_text('更新状态\n')
        self.commit()
        after = v.inventory()
        self.assertEqual(before['fingerprint'], after['fingerprint'])
        self.assertNotEqual(before['documents'], after['documents'])
        self.assertTrue(after['documents_valid'])

    def test_unknown_markdown_and_file_mode_are_inputs(self):
        before = v.inventory()
        Path('README.md').write_text('Unknown input\n')
        self.commit()
        self.assertNotEqual(before['fingerprint'], v.inventory()['fingerprint'])
        before = v.inventory()
        Path('app.ts').chmod(0o755)
        self.commit()
        self.assertNotEqual(before['fingerprint'], v.inventory()['fingerprint'])

    def test_symlink_binary_deleted_and_executable_docs_are_not_reusable(self):
        p = Path(next(iter(v.DOCS)))
        for kind in ['symlink', 'binary', 'deleted', 'executable']:
            with self.subTest(kind=kind):
                subprocess.run(['git', 'reset', '--hard', '-q', 'HEAD'], check=True)
                if kind == 'symlink':
                    p.unlink()
                    p.symlink_to('../app.ts')
                elif kind == 'binary':
                    p.write_bytes(b'\0not-document')
                elif kind == 'deleted':
                    p.unlink()
                else:
                    p.chmod(0o755)
                subprocess.run(['git', 'add', '-A'], check=True)
                # Inspect the index via a temporary tree, no commit needed.
                tree = v.git('write-tree').decode().strip()
                self.assertFalse(v.inventory(tree)['documents_valid'])


class GateTests(unittest.TestCase):
    def needs(self, mode):
        n = {k: {'result': 'success'} for k in
             ['domain-contracts', 'app', 'server', 'g64111', 'pde-kernel',
              'dependency-audit', 'production-images', 'postgres-operations', 'crm-release']}
        n['validation-plan'] = {'result': 'success', 'outputs': {'mode': mode}}
        return n

    def test_every_required_check_must_succeed_in_both_modes(self):
        for mode in ['full', 'reuse']:
            n = self.needs(mode)
            self.assertTrue(v.gate(n))
            for name in n:
                for result in ['skipped', 'failure', 'cancelled', None]:
                    x = copy.deepcopy(n)
                    x[name]['result'] = result
                    self.assertFalse(v.gate(x), (mode, name, result))

    def test_unknown_missing_or_extra_gate_inputs_fail(self):
        self.assertFalse(v.gate(self.needs('unknown')))
        n = self.needs('full')
        n.pop('app')
        self.assertFalse(v.gate(n))
        n = self.needs('full')
        n['unexpected'] = {'result': 'success'}
        self.assertFalse(v.gate(n))

    def test_required_check_guard_fails_when_plan_is_missing(self):
        env = dict(os.environ, PLAN_MODE='reuse', PLAN_RESULT='failure')
        p = subprocess.run(['python3', str(Path(v.__file__)), 'guard'],
                           env=env, capture_output=True)
        self.assertNotEqual(p.returncode, 0)

    def test_reuse_guard_requires_same_repository_original_run_url(self):
        for url, expected in [
            ('https://github.com/ZiZ-LG/jianghu/actions/runs/10', 0),
            ('https://example.com/10', 1),
            ('https://github.com/other/repo/actions/runs/10', 1),
            ('', 1),
        ]:
            env = dict(os.environ, PLAN_MODE='reuse', PLAN_RESULT='success',
                       GITHUB_REPOSITORY='ZiZ-LG/jianghu', SOURCE_URL=url)
            p = subprocess.run(['python3', str(Path(v.__file__)), 'guard'],
                               env=env, capture_output=True)
            self.assertEqual(p.returncode == 0, expected == 0)


class RunSelectionTests(unittest.TestCase):
    def test_old_rerun_success_cannot_hide_newer_created_failure(self):
        api = v.GitHub('ZiZ-LG/jianghu')
        old = {'id': 10, 'head_branch': 'codex/test',
               'created_at': '2026-10-23T17:00:00Z',
               'updated_at': '2026-10-23T19:00:00Z', 'conclusion': 'success'}
        new = {'id': 11, 'head_branch': 'codex/test',
               'created_at': '2026-10-23T18:00:00Z',
               'updated_at': '2026-10-23T18:30:00Z', 'conclusion': 'failure'}
        with patch.object(api, 'request', return_value={
                'total_count': 2, 'workflow_runs': [old, new]}):
            self.assertEqual(api.latest('codex/test', exclude=20)['id'], 11)

    def test_incomplete_inventory_cannot_be_used_to_pick_a_green_subset(self):
        api = v.GitHub('ZiZ-LG/jianghu')
        with patch.object(api, 'request', return_value={
                'total_count': 101, 'workflow_runs': []}):
            with self.assertRaises(ValueError):
                api.latest('codex/test', exclude=20)

    def test_only_exact_attempt_artifact_and_bounded_single_json_are_read(self):
        api = v.GitHub('ZiZ-LG/jianghu')
        run = {'id': 10, 'run_attempt': 2}
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('context.json', json.dumps({'bound': True}))
        a = {'id': 1, 'name': 'ci-validation-context-2', 'expired': False,
             'size_in_bytes': len(out.getvalue())}
        with patch.object(api, 'request', side_effect=[
            {'total_count': 1, 'artifacts': [a]}, out.getvalue()]):
            self.assertEqual(api.manifest(run), {'bound': True})
        for mutation in [{'expired': True}, {'name': 'ci-validation-context-1'},
                         {'size_in_bytes': 100001}]:
            bad = dict(a, **mutation)
            with patch.object(api, 'request', return_value={
                    'total_count': 1, 'artifacts': [bad]}):
                with self.assertRaises(ValueError):
                    api.manifest(run)
        malformed = io.BytesIO()
        with zipfile.ZipFile(malformed, 'w') as z:
            z.writestr('../context.json', '{}')
        with patch.object(api, 'request', side_effect=[
            {'total_count': 1, 'artifacts': [a]}, malformed.getvalue()]):
            with self.assertRaises(ValueError):
                api.manifest(run)


if __name__ == '__main__':
    unittest.main()
