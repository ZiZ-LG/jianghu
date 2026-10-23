#!/usr/bin/env python3
"""CRM API-only replacement: automatic IPAM, one worker, leased rollback.

Plan/state live outside Git. No database command, migration, proxy edit or image
build is performed here. Python 3.6+ and the local Docker 26 API are supported.
"""
import argparse
import contextlib
import copy
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse
import uuid


GLOBAL_LOCK = Path.home() / '.crm-api-release.lock'


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    # Safety gates must also hold when Python is invoked with -O.
    if not condition:
        raise ReleaseError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def container_digest(rows):
    rows = copy.deepcopy(rows)
    for row in rows.values():
        row['Mounts'] = sorted(row['Mounts'], key=lambda m: m['Destination'])
    return digest(rows)


def command(*args, **kwargs):
    timeout = kwargs.pop('timeout', 45)
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=timeout, **kwargs)
    # Docker errors can include configuration values. Never echo them to callers.
    require(p.returncode == 0, '{} command failed (exit {})'.format(args[0], p.returncode))
    return p.stdout


class Docker(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=45)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(os.environ.get('CRM_RELEASE_DOCKER_SOCKET', '/var/run/docker.sock'))


def create_container(name, payload):
    c = Docker()
    try:
        c.request('POST', '/v1.45/containers/create?name=' + name,
                  json.dumps(payload).encode(), {'Content-Type': 'application/json'})
        r = c.getresponse()
        raw = r.read()
        require(r.status == 201, 'Docker create failed (status {})'.format(r.status))
        return json.loads(raw)['Id']
    finally:
        c.close()


def environment(c):
    return dict(v.split('=', 1) for v in c['Config'].get('Env') or [] if '=' in v)


def validate_plan(plan):
    require(re.fullmatch(r'[0-9a-f]{64}', plan.get('oldContainer', '')), 'pin the old container ID')
    for field in ['oldImage', 'newImage']:
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', plan.get(field, '')), 'pin image config digest')
    require(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', plan.get('newName', '')), 'invalid new name')
    require(15 <= plan.get('leaseSeconds', 600) <= 900, 'lease must be 15..900 seconds')
    require(plan.get('networks') and len(set(plan['networks'])) == len(plan['networks']), 'pin networks')
    require(not set(plan['networks']) & {'none', 'host', 'bridge'}, 'use named application networks')
    parsed = urlparse(plan.get('healthURL', ''))
    require(not parsed.username and not parsed.password and not parsed.query and not parsed.fragment,
            'health URL must not contain credentials or query')
    require(parsed.scheme == 'https' or (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'),
            'HTTPS required except isolated loopback tests')
    require(parsed.hostname and parsed.path == '/api/health/ready', 'pin CRM readiness path')
    require(plan.get('protectedContainers'), 'pin protected containers')
    require(plan['oldContainer'] not in plan['protectedContainers'].values(), 'API is not a protected peer')
    for cid in plan['protectedContainers'].values():
        require(re.fullmatch(r'[0-9a-f]{64}', cid), 'pin protected container IDs')
    for path in plan.get('protectedPaths', []):
        require(Path(path).is_absolute(), 'protected paths must be absolute')
    for cid, paths in plan.get('protectedContainerFiles', {}).items():
        require(cid in plan['protectedContainers'].values(), 'file owner must be protected')
        require(paths and all(p.startswith('/') and '\n' not in p for p in paths), 'invalid protected files')


class Release:
    def __init__(self, root, plan=None):
        self.root = Path(root).resolve()
        self.plan = plan if plan is not None else self.read('plan.private.json')
        validate_plan(self.plan)
        self.active_lease = None

    def budget(self, maximum):
        if self.active_lease is None:
            return maximum
        s = self.active_lease
        remaining = min(s['deadline'] - time.time(),
                        s['monotonicDeadline'] - time.monotonic())
        require(remaining > 0, 'activation lease expired')
        return min(maximum, remaining)

    def run(self, *args, **kwargs):
        kwargs['timeout'] = self.budget(kwargs.get('timeout', 45))
        return command(*args, **kwargs)

    def pause(self, seconds):
        time.sleep(self.budget(seconds))

    def inspect(self, name):
        return json.loads(self.run('docker', 'inspect', name))[0]

    def save(self, name, value):
        temp = self.root / (name + '.tmp')
        with temp.open('w') as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(value, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(str(temp), str(self.root / name))

    def read(self, name):
        return json.loads((self.root / name).read_text())

    @contextlib.contextmanager
    def daemon_lock(self):
        with GLOBAL_LOCK.open('a') as daemon:
            os.fchmod(daemon.fileno(), 0o600)
            fcntl.flock(daemon, fcntl.LOCK_EX)
            yield

    @contextlib.contextmanager
    def lock(self):
        # All transactions run by this Docker operator share the same lock.
        # Separate state roots must not race through zero-workers then start two.
        with self.daemon_lock(), (self.root / 'transaction.lock').open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            yield

    def phase(self, state, phase, **values):
        state.update(values)
        state.update(phase=phase, updatedAt=time.time())
        self.save('state.json', state)

    def state(self):
        s = self.read('state.json')
        require(s['planDigest'] == digest(self.plan), 'plan changed after prepare')
        require(s['publisherDigest'] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'publisher changed after prepare')
        return s

    def workers(self):
        ids = self.run('docker', 'ps', '-q').decode().split()
        dsn = environment(self.inspect(self.plan['oldContainer'])).get('DATABASE_URL')
        require(bool(dsn), 'old API must have a database connection')
        rows = json.loads(self.run('docker', 'inspect', *ids)) if ids else []
        return [{'id': c['Id'], 'image': c['Image']} for c in rows
                if environment(c).get('DATABASE_URL') == dsn]

    def one(self, cid):
        require([r['id'] for r in self.workers()] == [cid], 'expected exactly one approved worker')

    def zero(self):
        require(not self.workers(), 'another worker remains; refusing to start')

    def protected(self):
        rows = {}
        for name, cid in self.plan['protectedContainers'].items():
            c = self.inspect(cid)
            require(c['Name'].lstrip('/') == name, 'protected identity changed')
            rows[name] = {k: c[k] for k in ['Id', 'Image', 'RestartCount', 'Mounts', 'HostConfig', 'Config']}
            rows[name]['state'] = {k: c['State'][k] for k in ['Running', 'Status', 'StartedAt', 'FinishedAt', 'Pid']}
            rows[name]['networks'] = c['NetworkSettings']['Networks']
        files = {}
        for name in self.plan.get('protectedPaths', []):
            p = Path(name)
            require(p.exists() or p.is_symlink(), 'protected path missing')
            if p.is_symlink():
                files[name + ':link'] = os.readlink(str(p))
            paths = sorted(p.rglob('*')) if p.is_dir() else [p]
            for f in paths:
                if f.is_symlink():
                    files[str(f) + ':link'] = os.readlink(str(f))
                if f.is_file():
                    files[str(f)] = hashlib.sha256(f.read_bytes()).hexdigest()
        for cid, paths in self.plan.get('protectedContainerFiles', {}).items():
            files[cid] = self.run('docker', 'exec', cid, 'sha256sum', '--', *paths).decode()
        return {'containersDigest': container_digest(rows), 'files': files}

    def protected_ok(self, s):
        require(self.protected() == s['protected'], 'protected production state changed')

    def ready(self, cid):
        for _ in range(50):
            require(self.inspect(cid)['State']['Running'], 'API exited before readiness')
            p = subprocess.run(['docker', 'exec', cid, 'wget', '-qO-',
                                'http://127.0.0.1:3001/api/health/ready'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.budget(5))
            if p.returncode == 0 and p.stdout.strip() == b'{"ok":true}':
                return
            self.pause(1)
        raise ReleaseError('API readiness deadline')

    def public_ready(self):
        for _ in range(20):
            p = subprocess.run(['curl', '--noproxy', '*', '-fsS', '--max-time', '5',
                                self.plan['healthURL']], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, timeout=self.budget(7))
            if p.returncode == 0 and p.stdout.strip() == b'{"ok":true}':
                return
            self.pause(1)
        raise ReleaseError('public dynamic alias readiness deadline')

    def disconnect(self, cid):
        for name in list(self.inspect(cid)['NetworkSettings']['Networks']):
            require(name in self.plan['networks'], 'unexpected API network')
            self.run('docker', 'network', 'disconnect', name, cid)

    def connect_original(self, cid):
        original = self.read('baseline.private.json')['NetworkSettings']['Networks']
        for name in self.plan['networks']:
            args = ['docker', 'network', 'connect']
            # Automatic IPAM networks reject --ip even if inspect shows a subnet.
            # Preserve aliases, never transplant IPAMConfig, MAC or cached IPs.
            for alias in original[name].get('Aliases') or []:
                args += ['--alias', alias]
            self.run(*(args + [name, cid]))

    def previous_finalized(self, old):
        previous = (old['Config'].get('Labels') or {}).get('crm.release.transaction')
        if previous:
            try:
                state = json.loads((Path(previous) / 'state.json').read_text())
            except (OSError, ValueError):
                raise ReleaseError('previous publisher state missing or invalid')
            require(state.get('apiId') == old['Id'] and state.get('phase') == 'FINALIZED'
                    and state.get('pending') is False,
                    'previous transaction must be finalized before another release')

    def prepare(self):
        require(not self.root.exists(), 'state exists: inspect it; never recreate blindly')
        old = self.inspect(self.plan['oldContainer'])
        self.previous_finalized(old)
        require(old['Image'] == self.plan['oldImage'] and old['State']['Running'], 'old identity mismatch')
        require(old['Config']['Entrypoint'] == ['npm'] and old['Config']['Cmd'] == ['run', 'start'],
                'old rollback entrypoint must explicitly bypass migrations')
        require(not old['Mounts'] and not old['HostConfig'].get('PortBindings'), 'API must be private and unmounted')
        require(set(old['NetworkSettings']['Networks']) == set(self.plan['networks']), 'old network mismatch')
        self.one(old['Id'])
        image = self.inspect(self.plan['newImage'])
        require(image['Id'] == self.plan['newImage'] and image['Architecture'] == 'amd64', 'new image mismatch')
        require(image['Config']['Entrypoint'] == ['npm'] and image['Config']['Cmd'] == ['run', 'start'],
                'new image must bypass migrations')
        require(image['Config'].get('Env') == self.inspect(self.plan['oldImage'])['Config'].get('Env'),
                'image environment defaults changed')
        protected = self.protected()
        self.root.mkdir(parents=True, mode=0o700)
        self.save('plan.private.json', self.plan)
        self.save('baseline.private.json', old)
        s = {'phase': 'PREPARING', 'pending': False, 'oldId': old['Id'],
             'oldImage': old['Image'], 'image': image['Id'], 'protected': protected,
             'planDigest': digest(self.plan),
             'publisherDigest': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        self.save('state.json', s)
        payload = copy.deepcopy(old['Config'])
        payload.update(Image=image['Id'], Hostname=self.plan['newName'])
        payload['Labels'] = dict(payload.get('Labels') or {}, **{'crm.release.transaction': str(self.root)})
        payload['HostConfig'] = copy.deepcopy(old['HostConfig'])
        payload['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        payload['HostConfig']['NetworkMode'] = self.plan['networks'][0]
        payload['NetworkingConfig'] = {'EndpointsConfig': {self.plan['networks'][0]: {
            'Aliases': [self.plan['newName']]}}}
        cid = create_container(self.plan['newName'], payload)
        s['apiId'] = cid
        self.save('state.json', s)
        new = self.inspect(cid)
        require(not new['State']['Running'] and new['Image'] == image['Id'], 'new API must remain stopped')
        require(environment(new) == environment(old), 'formal application environment changed')
        self.protected_ok(s)
        self.one(old['Id'])
        self.phase(s, 'PREPARED')
        return self.status()

    def expired(self, s):
        return time.time() >= s['deadline'] or time.monotonic() >= s['monotonicDeadline']

    def arm_watchdog(self, s):
        with (self.root / 'watchdog.log').open('ab', buffering=0) as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()),
                                      '--root', str(self.root), 'watchdog', '--lease', s['lease']],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        s['watchdogPid'] = child.pid
        self.save('state.json', s)
        for _ in range(50):
            require(child.poll() is None, 'rollback watchdog exited before activation')
            if (self.root / ('watchdog-ready-' + s['lease'])).exists():
                return
            self.pause(.1)
        raise ReleaseError('rollback watchdog did not acknowledge startup')

    def activate(self):
        s = self.state()
        require(s['phase'] == 'PREPARED' and not s['pending'], 'activation already attempted')
        self.protected_ok(s)
        old = self.inspect(s['oldId'])
        self.previous_finalized(old)
        base = self.read('baseline.private.json')
        require(old['Config'] == base['Config'] and old['HostConfig'] == base['HostConfig'], 'old config drift')
        self.one(s['oldId'])
        seconds = self.plan.get('leaseSeconds', 600)
        self.phase(s, 'ACTIVATING', pending=True, lease=str(uuid.uuid4()),
                   deadline=time.time() + seconds, monotonicDeadline=time.monotonic() + seconds)
        try:
            self.active_lease = s
            self.arm_watchdog(s)
            self.run('docker', 'update', '--restart=no', s['oldId'])
            # Bound stop grace to the lease. Journal an ambiguous daemon stop so
            # recovery cannot declare success while a stop is still outstanding.
            remaining = self.budget(40)
            require(remaining > 3, 'insufficient lease for old worker stop')
            grace = min(25, max(1, int(remaining - 2)))
            self.phase(s, 'ACTIVATING', oldStopRequested=True, oldStopCompleted=False)
            self.run('docker', 'stop', '-t', str(grace), s['oldId'], timeout=remaining)
            self.phase(s, 'ACTIVATING', oldStopCompleted=True)
            self.zero()
            self.disconnect(s['oldId'])
            self.disconnect(s['apiId'])
            self.connect_original(s['apiId'])
            self.run('docker', 'update', '--restart=unless-stopped', s['apiId'])
            self.run('docker', 'start', s['apiId'])
            self.ready(s['apiId'])
            self.public_ready()
            self.one(s['apiId'])
            self.protected_ok(s)
            require(not self.expired(s), 'activation lease expired during readiness')
            self.phase(s, 'AWAITING_ACCEPTANCE', readyAt=time.time())
            return self.status()
        except BaseException:
            self.active_lease = None
            self.rollback(s, 'activation failed')
            raise
        finally:
            self.active_lease = None

    def rollback(self, s, reason):
        require(s['phase'] in ['ACTIVATING', 'AWAITING_ACCEPTANCE', 'FINALIZED',
                               'ROLLING_BACK', 'ROLLBACK_FAILED', 'ROLLED_BACK'], 'rollback state mismatch')
        if s['phase'] == 'ROLLED_BACK':
            self.one(s['oldId'])
            return self.status()
        self.phase(s, 'ROLLING_BACK', rollbackReason=reason)
        try:
            self.run('docker', 'update', '--restart=no', s['apiId'])
            if self.inspect(s['apiId'])['State']['Running']:
                self.run('docker', 'stop', '-t', '25', s['apiId'], timeout=40)
            require(not self.inspect(s['apiId'])['State']['Running'], 'new worker did not stop')
            # Quiesce our worker even if an unrelated worker appeared. Never
            # stop that foreign container or start another worker alongside it.
            require(all(r['id'] in [s['oldId'], s['apiId']] for r in self.workers()),
                    'foreign worker; owned replacement stopped, operator inspection required')
            self.disconnect(s['apiId'])
            old = self.inspect(s['oldId'])
            if old['State']['Running'] and s.get('oldStopRequested') and not s.get('oldStopCompleted'):
                self.run('docker', 'wait', s['oldId'], timeout=40)
                old = self.inspect(s['oldId'])
                require(not old['State']['Running'], 'ambiguous old stop has not settled')
            base = self.read('baseline.private.json')
            require(old['Image'] == s['oldImage'] and old['Config'] == base['Config'], 'old rollback config drift')
            if not old['State']['Running']:
                self.disconnect(s['oldId'])
                self.connect_original(s['oldId'])
                self.zero()
                policy = base['HostConfig']['RestartPolicy']['Name']
                self.run('docker', 'update', '--restart=' + policy, s['oldId'])
                self.run('docker', 'start', s['oldId'])
            else:
                self.run('docker', 'update', '--restart=' + base['HostConfig']['RestartPolicy']['Name'], s['oldId'])
            self.ready(s['oldId'])
            self.public_ready()
            self.one(s['oldId'])
            self.protected_ok(s)
            self.phase(s, 'ROLLED_BACK', pending=False, rollbackVerified=True)
            return self.status()
        except BaseException:
            self.phase(s, 'ROLLBACK_FAILED', pending=True)
            raise

    def finalize(self, lease, receipt):
        s = self.state()
        require(s['phase'] == 'AWAITING_ACCEPTANCE' and s['pending'], 'no pending acceptance')
        require(s['lease'] == lease and not self.expired(s), 'wrong or expired lease')
        for key in ['apiId', 'lease', 'planDigest', 'publisherDigest']:
            require(receipt.get(key) == s[key], 'acceptance receipt binding mismatch')
        require(all(receipt.get(k) is True for k in ['publicPassed', 'browserPassed', 'protectedPassed',
                                                     'screenshotsInspected']), 'acceptance incomplete')
        require(s['readyAt'] <= receipt.get('checkedAtEpoch', 0) <= time.time() + 5,
                'acceptance predates this activation')
        try:
            self.active_lease = s
            self.ready(s['apiId'])
            self.public_ready()
            self.one(s['apiId'])
            require(not self.inspect(s['oldId'])['State']['Running'], 'old worker running')
            require(environment(self.inspect(s['apiId'])) == environment(self.inspect(s['oldId'])),
                    'formal connection changed')
            self.protected_ok(s)
            require(not self.expired(s), 'lease expired during acceptance verification')
            self.save('acceptance.json', receipt)
            self.phase(s, 'FINALIZED', pending=False, finalizedAt=time.time())
            return self.status()
        except BaseException:
            self.active_lease = None
            self.rollback(s, 'acceptance verification failed')
            raise
        finally:
            self.active_lease = None

    def watchdog(self, lease):
        s = self.state()
        if s.get('lease') != lease or not s.get('pending'):
            return
        (self.root / ('watchdog-ready-' + lease)).touch(mode=0o600)
        failures = 0
        while True:
            with self.lock():
                s = self.state()
                if s.get('lease') != lease or not s.get('pending'):
                    return
                if self.expired(s) or s['phase'] == 'ROLLBACK_FAILED':
                    try:
                        self.rollback(s, 'activation lease expired or recovery incomplete')
                        return
                    except Exception:
                        failures += 1
                        if failures >= 3:
                            return  # ROLLBACK_FAILED remains explicit, never marked recovered.
            self.pause(1)

    def status(self):
        s = self.state()
        if 'apiId' not in s:
            return s
        new, old = self.inspect(s['apiId']), self.inspect(s['oldId'])
        return dict(s, observed={'newRunning': new['State']['Running'],
                                'oldRunning': old['State']['Running'],
                                'newImage': new['Image'], 'workers': self.workers(),
                                'networks': sorted(new['NetworkSettings']['Networks'])})


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, help='new private transaction directory')
    parser.add_argument('action', choices=['prepare', 'status', 'activate', 'rollback', 'finalize', 'watchdog'])
    parser.add_argument('--plan', help='external plan JSON, prepare only')
    parser.add_argument('--lease')
    parser.add_argument('--receipt', help='external acceptance JSON, finalize only')
    args = parser.parse_args()
    if args.action == 'prepare':
        require(args.plan is not None, 'prepare requires plan')
        r = Release(args.root, json.loads(Path(args.plan).read_text()))
        with r.daemon_lock():
            result = r.prepare()
    else:
        r = Release(args.root)
        if args.action == 'watchdog':
            require(args.lease is not None, 'watchdog requires exact lease')
            r.watchdog(args.lease)
            return
        with r.lock():
            if args.action == 'status':
                result = r.status()
            elif args.action == 'activate':
                result = r.activate()
            elif args.action == 'rollback':
                s = r.state()
                require(args.lease is not None and args.lease == s.get('lease'), 'rollback requires exact lease')
                result = r.rollback(s, 'explicit operator rollback')
            else:
                require(args.receipt is not None, 'finalize requires receipt')
                result = r.finalize(args.lease, json.loads(Path(args.receipt).read_text()))
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ReleaseError, subprocess.TimeoutExpired) as error:
        print('CRM_RELEASE_ERROR: ' + str(error), file=sys.stderr)
        sys.exit(1)
