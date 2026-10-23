"""State-transition regressions; no Docker daemon or real database is used."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('crm-api-release.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
OLD, NEW, PEER = 'a' * 64, 'b' * 64, 'c' * 64
OLDIMG, NEWIMG = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'transaction'
        self.root.mkdir()
        self.plan = {'oldContainer': OLD, 'oldImage': OLDIMG, 'newImage': NEWIMG,
                     'newName': 'crm-replacement', 'networks': ['back', 'front'],
                     'healthURL': 'https://crm.example.test/api/health/ready',
                     'protectedContainers': {'peer': PEER}, 'leaseSeconds': 600}
        self.r = m.Release(self.root, self.plan)
        self.log = []
        self.failure = None
        self.events = []
        cfg = {'Env': ['DATABASE_URL=postgres://synthetic.invalid/db'],
               'Entrypoint': ['npm'], 'Cmd': ['run', 'start']}
        self.original = {'back': {'Aliases': ['server'], 'IPAddress': '10.0.0.2',
                                 'IPAMConfig': {'IPv4Address': '10.0.0.2'}},
                         'front': {'Aliases': ['crm-api-production', 'server'],
                                   'IPAddress': '10.1.0.2', 'IPAMConfig': {}}}
        self.cs = {OLD: {'Id': OLD, 'Image': OLDIMG, 'Config': cfg, 'Mounts': [],
                         'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {}},
                         'State': {'Running': True}, 'NetworkSettings': {'Networks': copy.deepcopy(self.original)}},
                   NEW: {'Id': NEW, 'Image': NEWIMG, 'Config': copy.deepcopy(cfg), 'Mounts': [],
                         'HostConfig': {'RestartPolicy': {'Name': 'no'}, 'PortBindings': {}},
                         'State': {'Running': False}, 'NetworkSettings': {'Networks': {'back': {}}}}}
        self.r.save('baseline.private.json', self.cs[OLD])
        self.r.save('plan.private.json', self.plan)
        self.r.save('state.json', {'phase': 'PREPARED', 'pending': False, 'oldId': OLD,
                                  'apiId': NEW, 'oldImage': OLDIMG, 'image': NEWIMG,
                                  'protected': {'same': True}, 'planDigest': m.digest(self.plan),
                                  'publisherDigest': m.hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()})
        self.patches = [patch.object(m, 'command', self.command),
                        patch.object(self.r, 'inspect', lambda n: copy.deepcopy(self.cs[n])),
                        patch.object(self.r, 'protected', lambda: {'same': True}),
                        patch.object(self.r, 'ready', lambda cid: None),
                        patch.object(self.r, 'public_ready', lambda: None),
                        patch.object(self.r, 'arm_watchdog', lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def command(self, *a, **kw):
        self.log.append(a)
        if a[:3] == ('docker', 'ps', '-q'):
            return ' '.join(k for k, c in self.cs.items() if c['State']['Running']).encode()
        if a[:2] == ('docker', 'inspect'):
            return json.dumps([self.cs[n] for n in a[2:]]).encode()
        if a[:2] == ('docker', 'update'):
            self.cs[a[-1]]['HostConfig']['RestartPolicy']['Name'] = a[2].split('=')[1]
        elif a[:2] == ('docker', 'stop'):
            if self.failure == 'stop-new' and a[-1] == NEW:
                self.failure = None
                raise m.ReleaseError('injected stop failure')
            self.cs[a[-1]]['State']['Running'] = False
        elif a[:2] == ('docker', 'start'):
            self.assertFalse(any(c['State']['Running'] for c in self.cs.values()), 'two workers attempted')
            self.cs[a[-1]]['State']['Running'] = True
        elif a[:3] == ('docker', 'network', 'disconnect'):
            self.cs[a[-1]]['NetworkSettings']['Networks'].pop(a[3], None)
        elif a[:3] == ('docker', 'network', 'connect'):
            if self.failure == 'connect-new' and a[-1] == NEW:
                self.failure = None
                raise m.ReleaseError('injected network failure')
            if self.failure == 'connect-old' and a[-1] == OLD:
                self.failure = None
                raise m.ReleaseError('injected recovery failure')
            # Model the automatic-IPAM rejection that broke the first real release.
            self.assertNotIn('--ip', a)
            self.assertNotIn('--ip6', a)
            aliases = [a[i + 1] for i, x in enumerate(a[:-1]) if x == '--alias']
            self.cs[a[-1]]['NetworkSettings']['Networks'][a[-2]] = {
                'Aliases': aliases, 'IPAddress': '10.99.0.9'}
        else:
            self.fail('unexpected command ' + repr(a))
        self.events.append(sum(c['State']['Running'] for c in self.cs.values()))
        return b''

    def receipt(self, s):
        return dict({k: s[k] for k in ['apiId', 'lease', 'planDigest', 'publisherDigest']},
                    publicPassed=True, browserPassed=True, protectedPassed=True,
                    screenshotsInspected=True, checkedAtEpoch=s['readyAt'])

    def test_automatic_ipam_both_directions_keep_aliases_not_ip(self):
        s = self.r.activate()
        self.assertEqual(s['phase'], 'AWAITING_ACCEPTANCE')
        self.assertNotEqual(self.cs[NEW]['NetworkSettings']['Networks']['front']['IPAddress'],
                            self.original['front']['IPAddress'])
        for n in self.original:
            self.assertEqual(self.cs[NEW]['NetworkSettings']['Networks'][n]['Aliases'], self.original[n]['Aliases'])
        self.r.rollback(self.r.state(), 'test')
        connects = [a for a in self.log if a[:3] == ('docker', 'network', 'connect')]
        self.assertEqual(len(connects), 4)
        self.assertEqual(self.cs[OLD]['NetworkSettings']['Networks']['front']['Aliases'], self.original['front']['Aliases'])
        self.assertEqual(max(self.events), 1)
        self.assertIn(0, self.events)

    def test_single_worker_foreign_worker_blocks_before_mutation(self):
        self.cs[PEER] = copy.deepcopy(self.cs[OLD])
        self.cs[PEER]['Id'] = PEER
        with self.assertRaises(m.ReleaseError):
            self.r.activate()
        self.assertTrue(self.cs[OLD]['State']['Running'])
        self.assertFalse(any(a[:2] == ('docker', 'stop') for a in self.log))

    def test_partial_network_failure_restores_old(self):
        self.failure = 'connect-new'
        with self.assertRaises(m.ReleaseError):
            self.r.activate()
        s = self.r.state()
        self.assertEqual(s['phase'], 'ROLLED_BACK')
        self.assertFalse(s['pending'])
        self.r.one(OLD)
        self.assertFalse(self.cs[NEW]['State']['Running'])
        self.assertEqual(self.cs[OLD]['HostConfig']['RestartPolicy']['Name'], 'unless-stopped')

    def test_failed_new_readiness_stops_new_before_old(self):
        def ready(cid):
            if cid == NEW:
                raise m.ReleaseError('unhealthy')
        with patch.object(self.r, 'ready', ready):
            with self.assertRaises(m.ReleaseError):
                self.r.activate()
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)
        self.assertEqual(max(self.events), 1)

    def test_watchdog_spawn_failure_restores_restart_policy(self):
        with patch.object(self.r, 'arm_watchdog', side_effect=m.ReleaseError('no watchdog')):
            with self.assertRaises(m.ReleaseError):
                self.r.activate()
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)

    def test_stop_failure_never_starts_second_worker_and_can_recover(self):
        self.r.activate()
        self.failure = 'stop-new'
        with self.assertRaises(m.ReleaseError):
            self.r.rollback(self.r.state(), 'test')
        self.assertEqual(self.r.state()['phase'], 'ROLLBACK_FAILED')
        self.assertTrue(self.r.state()['pending'])
        self.r.one(NEW)
        self.r.rollback(self.r.state(), 'retry inspected state')
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)

    def test_recovery_connect_failure_remains_explicit_then_watchdog_recovers(self):
        self.r.activate()
        self.failure = 'connect-old'
        with self.assertRaises(m.ReleaseError):
            self.r.rollback(self.r.state(), 'test')
        s = self.r.state()
        self.assertEqual(s['phase'], 'ROLLBACK_FAILED')
        self.assertTrue(s['pending'])
        self.r.watchdog(s['lease'])
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)

    def test_expired_lease_real_watchdog_path_rolls_back(self):
        self.r.activate()
        s = self.r.state()
        s['deadline'] = 0
        self.r.save('state.json', s)
        self.r.watchdog(s['lease'])
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.assertFalse(self.r.state()['pending'])
        self.r.one(OLD)

    def test_backward_wall_clock_does_not_extend_monotonic_lease(self):
        self.r.activate()
        s = self.r.state()
        s['deadline'] = 10 ** 20
        s['monotonicDeadline'] = 0
        self.r.save('state.json', s)
        self.r.watchdog(s['lease'])
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')

    def test_stale_watchdog_cannot_rollback_new_lease(self):
        s = self.r.activate()
        self.r.watchdog('stale-lease')
        self.assertEqual(self.r.state()['phase'], 'AWAITING_ACCEPTANCE')
        self.r.one(NEW)

    def test_repeated_activation_and_replay_receipt_rejected(self):
        s = self.r.activate()
        with self.assertRaises(m.ReleaseError):
            self.r.activate()
        receipt = self.receipt(s)
        for key in ['apiId', 'lease', 'planDigest', 'publisherDigest']:
            invalid = dict(receipt, **{key: 'another-transaction'})
            with self.assertRaises(m.ReleaseError):
                self.r.finalize(s['lease'], invalid)
        self.r.finalize(s['lease'], receipt)
        self.assertFalse(self.r.state()['pending'])
        self.assertEqual(self.r.state()['phase'], 'FINALIZED')
        self.r.watchdog(s['lease'])
        self.r.one(NEW)

    def test_expiry_during_finalize_is_rechecked_after_health(self):
        s = self.r.activate()
        with patch.object(self.r, 'expired', side_effect=[False, True]):
            with self.assertRaises(m.ReleaseError):
                self.r.finalize(s['lease'], self.receipt(s))
        self.assertFalse(self.r.state()['pending'])
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)

    def test_finalize_observed_failures_immediately_restore_old(self):
        for method in ['ready', 'public_ready', 'one', 'protected_ok']:
            with self.subTest(method=method):
                s = self.r.activate()
                original = getattr(self.r, method)
                calls = []
                def fail_once(*args):
                    calls.append(args)
                    if len(calls) == 1:
                        raise m.ReleaseError('injected acceptance failure')
                    return original(*args)
                with patch.object(self.r, method, fail_once):
                    with self.assertRaises(m.ReleaseError):
                        self.r.finalize(s['lease'], self.receipt(s))
                self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
                self.assertFalse(self.r.state()['pending'])
                self.r.one(OLD)
                # Fresh private fixture for the next failure boundary.
                self.tearDown()
                self.setUp()

    def test_foreign_worker_after_activation_quiesces_only_owned_new_worker(self):
        self.r.activate()
        self.cs[PEER] = copy.deepcopy(self.cs[NEW])
        self.cs[PEER]['Id'] = PEER
        foreign = copy.deepcopy(self.cs[PEER])
        with self.assertRaises(m.ReleaseError):
            self.r.rollback(self.r.state(), 'foreign worker discovered')
        self.assertFalse(self.cs[NEW]['State']['Running'])
        self.assertFalse(self.cs[OLD]['State']['Running'])
        self.assertEqual(self.cs[PEER], foreign)
        self.assertEqual(self.r.state()['phase'], 'ROLLBACK_FAILED')
        self.assertTrue(self.r.state()['pending'])
        self.assertEqual(self.cs[NEW]['HostConfig']['RestartPolicy']['Name'], 'no')

    def test_inflight_calls_use_remaining_lease_and_expiry_blocks_next_mutation(self):
        s = self.r.activate()
        self.r.active_lease = s
        with patch.object(m.time, 'time', return_value=s['deadline'] - .25), \
             patch.object(m, 'command', return_value=b'') as cmd:
            self.r.run('docker', 'inspect', NEW)
            self.assertLessEqual(cmd.call_args[1]['timeout'], .25)
        with patch.object(m.time, 'monotonic', return_value=s['monotonicDeadline'] + 1), \
             patch.object(m, 'command') as cmd:
            with self.assertRaises(m.ReleaseError):
                self.r.run('docker', 'start', OLD)
            cmd.assert_not_called()
        self.r.active_lease = None

    def test_ambiguous_old_stop_cannot_be_falsely_marked_restored(self):
        original = self.command
        def ambiguous(*args, **kw):
            if args[:2] == ('docker', 'stop') and args[-1] == OLD:
                raise m.subprocess.TimeoutExpired('docker stop', 1)
            if args[:2] == ('docker', 'wait'):
                self.assertEqual(args[-1], OLD)
                # Daemon stop is outstanding: settle it before a restart.
                self.cs[OLD]['State']['Running'] = False
                return b'0'
            return original(*args, **kw)
        with patch.object(m, 'command', ambiguous):
            with self.assertRaises(m.subprocess.TimeoutExpired):
                self.r.activate()
        self.assertEqual(self.r.state()['phase'], 'ROLLED_BACK')
        self.r.one(OLD)

    def test_different_transaction_roots_share_operator_lock(self):
        global_file = Path(self.temp.name) / 'operator.lock'
        other = self.root.parent / 'another-transaction'
        other.mkdir()
        probe = ('import fcntl,sys; f=open(sys.argv[1],"a"); '
                 'fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)')
        with patch.object(m, 'GLOBAL_LOCK', global_file):
            with self.r.lock():
                result = m.subprocess.run([m.sys.executable, '-c', probe, str(global_file)],
                                          stdout=m.subprocess.PIPE, stderr=m.subprocess.PIPE)
                self.assertNotEqual(result.returncode, 0)
            result = m.subprocess.run([m.sys.executable, '-c', probe, str(global_file)],
                                      stdout=m.subprocess.PIPE, stderr=m.subprocess.PIPE)
            self.assertEqual(result.returncode, 0)

    def test_prior_pending_or_unreadable_transaction_blocks_nested_release(self):
        previous = self.root.parent / 'previous'
        previous.mkdir()
        self.cs[OLD]['Config']['Labels'] = {'crm.release.transaction': str(previous)}
        self.r.save('baseline.private.json', self.cs[OLD])
        for state in [None, 'invalid-json', {'apiId': OLD, 'phase': 'AWAITING_ACCEPTANCE', 'pending': True},
                      {'apiId': OLD, 'phase': 'ROLLBACK_FAILED', 'pending': True}]:
            path = previous / 'state.json'
            if state is not None:
                path.write_text(state if isinstance(state, str) else json.dumps(state))
            with self.assertRaises(m.ReleaseError):
                self.r.activate()
            self.assertTrue(self.cs[OLD]['State']['Running'])
            self.assertFalse(any(a[:2] == ('docker', 'stop') for a in self.log))
        path.write_text(json.dumps({'apiId': OLD, 'phase': 'FINALIZED', 'pending': False}))
        self.r.previous_finalized(self.cs[OLD])
        self.r.activate()
        self.r.one(NEW)

    def test_incomplete_acceptance_cannot_finalize(self):
        s = self.r.activate()
        receipt = self.receipt(s)
        receipt['screenshotsInspected'] = False
        with self.assertRaises(m.ReleaseError):
            self.r.finalize(s['lease'], receipt)
        self.assertTrue(self.r.state()['pending'])

    def test_protected_drift_blocks_before_stop(self):
        with patch.object(self.r, 'protected', return_value={'different': True}):
            with self.assertRaises(m.ReleaseError):
                self.r.activate()
        self.assertTrue(self.cs[OLD]['State']['Running'])

    def test_plan_or_publisher_drift_fails_closed(self):
        self.r.plan['newName'] = 'changed'
        with self.assertRaises(m.ReleaseError):
            self.r.state()
        self.r.plan['newName'] = 'crm-replacement'
        s = self.r.state()
        s['publisherDigest'] = 'changed'
        self.r.save('state.json', s)
        with self.assertRaises(m.ReleaseError):
            self.r.state()

    def test_mount_order_is_ignored_but_value_change_is_not(self):
        a = {'container': {'Mounts': [{'Destination': '/b', 'RW': False}, {'Destination': '/a', 'RW': False}]}}
        b = copy.deepcopy(a)
        b['container']['Mounts'].reverse()
        self.assertEqual(m.container_digest(a), m.container_digest(b))
        b['container']['Mounts'][0]['RW'] = True
        self.assertNotEqual(m.container_digest(a), m.container_digest(b))

    def test_private_state_and_no_database_or_migration_commands(self):
        self.r.activate()
        self.r.rollback(self.r.state(), 'test')
        self.assertEqual((self.root / 'baseline.private.json').stat().st_mode & 0o777, 0o600)
        for a in self.log:
            self.assertFalse(set(a) & {'psql', 'pg_dump', 'migrate', 'db:push', 'compose'})

    def test_health_url_disallows_cleartext_external_or_secret(self):
        for url in ['http://crm.example.test/api/health/ready',
                    'https://user:secret@crm.example.test/api/health/ready',
                    'https://crm.example.test/api/health/ready?key=secret']:
            with self.assertRaises(m.ReleaseError):
                m.validate_plan(dict(self.plan, healthURL=url))


if __name__ == '__main__':
    unittest.main(verbosity=2)
