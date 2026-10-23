#!/usr/bin/env python3
"""Exercise the real operator against disposable Docker networks, never a DB.

A test-only Docker CLI shim reserves addresses / injects a single failed network
call or unhealthy worker. All successful commands still use the real daemon.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
PREFIX = 'crm-release-test-' + uuid.uuid4().hex[:10]
LABEL = 'crm.release.integration=' + PREFIX
REAL_DOCKER = shutil.which('docker')
CREATED = []
NETWORKS = []
IMAGE = PREFIX + ':fixture'
ROOT = Path(tempfile.mkdtemp(prefix=PREFIX + '-'))
ENV = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')


def run(*args, **kw):
    p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=kw.pop('timeout', 120), **kw)
    if p.returncode:
        raise RuntimeError('{} failed: {}'.format(args[0], p.stderr.decode()[-1500:]))
    return p.stdout


def docker(*args):
    return run(REAL_DOCKER, *args)


def inspect(name):
    return json.loads(docker('inspect', name))[0]


def release(root, action, *args, expect_success=True):
    p = subprocess.run([sys.executable, str(HERE / 'crm-api-release.py'), '--root', str(root),
                        action] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env=ENV, timeout=180)
    if expect_success and p.returncode:
        raise RuntimeError(p.stderr.decode()[-1800:])
    if not expect_success:
        assert p.returncode != 0, 'injected failure was silently accepted'
        return p
    return json.loads(p.stdout)


def response(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.read().decode()


def await_marker(url, marker):
    for _ in range(20):
        try:
            if response(url) == marker:
                return
        except Exception:
            pass
        time.sleep(1)
    raise AssertionError('proxy marker did not converge: ' + marker)


def scenario(label, mode):
    name = PREFIX + '-' + label
    back, front = name + '-back', name + '-front'
    ingress = name + '-ingress'
    for net in [back, front]:
        docker('network', 'create', '--internal', '--label', LABEL, net)
        NETWORKS.append(net)
    docker('network', 'create', '--label', LABEL,
           '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false',
           '--opt', 'com.docker.network.bridge.enable_icc=false', ingress)
    NETWORKS.append(ingress)
    old, edge, holder = name + '-old', name + '-edge', name + '-holder'
    dsn = 'postgres://synthetic-only.invalid/' + name
    docker('create', '--name', old, '--network', back, '--network-alias', 'server',
           '--label', LABEL, '--restart', 'unless-stopped', '--memory', '96m',
           '-e', 'DATABASE_URL=' + dsn, IMAGE)
    CREATED.append(old)
    docker('network', 'connect', '--alias', 'crm-api-production', front, old)
    docker('start', old)
    oldid = inspect(old)['Id']
    oldmarker = inspect(old)['Config']['Hostname']
    oldip = inspect(old)['NetworkSettings']['Networks'][front]['IPAddress']
    config = ROOT / (label + '-nginx.conf')
    config.write_text('events {}\nhttp { upstream api { zone api 64k; resolver 127.0.0.11 valid=1s ipv6=off; '
                      'server crm-api-production:3001 resolve; } server { listen 80; location / { '
                      'proxy_pass http://api; proxy_connect_timeout 1s; proxy_read_timeout 2s; } } }\n')
    docker('create', '--name', edge, '--network', front, '--label', LABEL, '--memory', '48m',
           '-p', '127.0.0.1::80', '-v', str(config) + ':/etc/nginx/nginx.conf:ro',
           '--entrypoint', 'nginx', 'nginx:1.31-alpine', '-g', 'daemon off;')
    CREATED.append(edge)
    docker('network', 'connect', ingress, edge)
    docker('start', edge)
    edgeid = inspect(edge)['Id']
    bindings = inspect(edge)['NetworkSettings']['Ports']['80/tcp']
    assert bindings and len(bindings) == 1 and bindings[0]['HostIp'] == '127.0.0.1', bindings
    url = 'http://127.0.0.1:' + bindings[0]['HostPort']
    await_marker(url + '/marker', oldmarker)
    docker('create', '--name', holder, '--network', front, '--label', LABEL, '--memory', '32m',
           '--entrypoint', 'sleep', IMAGE, '600')
    CREATED.append(holder)
    docker('network', 'disconnect', front, holder)
    tx = ROOT / (label + '-state')
    plan = {'oldContainer': oldid, 'oldImage': inspect(old)['Image'], 'newImage': inspect(old)['Image'],
            'newName': name + '-new', 'networks': [back, front],
            'healthURL': url + '/api/health/ready', 'leaseSeconds': (30 if mode == 'activation-expiry' else 60) if 'expiry' in mode else 180,
            'protectedContainers': {edge: edgeid}, 'protectedPaths': [str(config)]}
    planfile = ROOT / (label + '-plan.json')
    planfile.write_text(json.dumps(plan))
    state = release(tx, 'prepare', '--plan', str(planfile))
    new = state['apiId']
    CREATED.append(new)
    fixture = {'new': new, 'old': oldid, 'front': front, 'holder': holder,
               'mode': mode, 'unhealthyFile': str(ROOT / 'unhealthy')}
    (ROOT / 'injection.json').write_text(json.dumps(fixture))
    if mode in ['network-failure', 'unhealthy', 'activation-expiry']:
        began = time.monotonic()
        release(tx, 'activate', expect_success=False)
        if mode == 'activation-expiry':
            assert time.monotonic() - began < 65, 'in-flight lease failed to bound recovery'
        state = release(tx, 'status')
        assert state['phase'] == 'ROLLED_BACK' and not state['pending']
        assert state['observed']['workers'] == [{'id': oldid, 'image': plan['oldImage']}]
        await_marker(url + '/marker', oldmarker)
    else:
        state = release(tx, 'activate')
        assert state['phase'] == 'AWAITING_ACCEPTANCE' and state['pending']
        assert state['observed']['workers'] == [{'id': new, 'image': plan['newImage']}]
        await_marker(url + '/marker', plan['newName'])
        newip = inspect(new)['NetworkSettings']['Networks'][front]['IPAddress']
        if mode == 'reserve-address':
            assert newip != oldip, 'the native test must actually change the address'
            receipt = {k: state[k] for k in ['apiId', 'lease', 'planDigest', 'publisherDigest']}
            receipt.update(publicPassed=True, browserPassed=True, protectedPassed=True,
                           screenshotsInspected=True, checkedAtEpoch=time.time())
            # This is a synthetic CLI boundary receipt; it makes no production/browser claim.
            receiptfile = ROOT / (label + '-receipt.json')
            receiptfile.write_text(json.dumps(receipt))
            final = release(tx, 'finalize', '--lease', state['lease'], '--receipt', str(receiptfile))
            assert final['phase'] == 'FINALIZED' and not final['pending']
            state = release(tx, 'rollback', '--lease', state['lease'])
            assert state['phase'] == 'ROLLED_BACK' and not state['pending']
            rollbackip = inspect(oldid)['NetworkSettings']['Networks'][front]['IPAddress']
            assert rollbackip != newip, 'rollback must also exercise real DNS address change'
            await_marker(url + '/marker', oldmarker)
        elif mode == 'finalize-expiry':
            docker('cp', str(ROOT / 'unhealthy'), new + ':/tmp/unhealthy')
            receipt = {k: state[k] for k in ['apiId', 'lease', 'planDigest', 'publisherDigest']}
            receipt.update(publicPassed=True, browserPassed=True, protectedPassed=True,
                           screenshotsInspected=True, checkedAtEpoch=time.time())
            receiptfile = ROOT / (label + '-receipt.json')
            receiptfile.write_text(json.dumps(receipt))
            # Leave less time than ready's intrinsic 50-round limit. Passing
            # must demonstrate lease expiry, not merely an ordinary health error.
            time.sleep(max(0, state['deadline'] - time.time() - 5))
            began = time.monotonic()
            failure = release(tx, 'finalize', '--lease', state['lease'], '--receipt', str(receiptfile), expect_success=False)
            state = release(tx, 'status')
            assert state['phase'] == 'ROLLED_BACK' and not state['pending']
            assert time.time() >= state['deadline'], 'finalize did not exercise actual lease expiry'
            assert b'lease expired' in failure.stderr or b'timed out' in failure.stderr
            assert time.monotonic() - began < 40, 'finalize lock prevented bounded recovery'
            await_marker(url + '/marker', oldmarker)
        else:
            # The detached watchdog must restore service without another CLI write.
            until = time.time() + 70
            while time.time() < until:
                state = release(tx, 'status')
                if state['phase'] == 'ROLLED_BACK':
                    break
                time.sleep(1)
            assert state['phase'] == 'ROLLED_BACK' and not state['pending']
            await_marker(url + '/marker', oldmarker)
    assert not inspect(new)['State']['Running'] and inspect(oldid)['State']['Running']
    assert all(not inspect(cid)['HostConfig'].get('PortBindings') for cid in [oldid, new])
    assert set(inspect(oldid)['NetworkSettings']['Networks']) == {back, front}
    assert inspect(oldid)['Config']['Entrypoint'] == ['npm']
    print(json.dumps({'scenario': label, 'passed': True, 'oldId': oldid, 'newId': new,
                      'phase': state['phase'], 'pending': state['pending'],
                      'automaticIPAM': True, 'productionCredentialsOrDBUsed': False}), flush=True)


def main():
    endpoint = docker('context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}').decode().strip()
    assert endpoint.startswith('unix://'), 'test requires a local Unix Docker socket'
    ENV['CRM_RELEASE_DOCKER_SOCKET'] = endpoint[len('unix://'):]
    build = ROOT / 'build'
    build.mkdir()
    (build / 'worker.py').write_text('''import http.server,json,os,socket
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  bad=self.path=="/api/health/ready" and os.path.exists("/tmp/unhealthy")
  self.send_response(503 if bad else 200);self.end_headers()
  body=socket.gethostname() if self.path=="/marker" else '{"ok":true}'
  self.wfile.write(body.encode())
 def log_message(self,*a):pass
http.server.HTTPServer(("0.0.0.0",3001),Handler).serve_forever()
''')
    (build / 'npm').write_text('#!/bin/sh\nexec python3 /worker.py\n')
    (build / 'Dockerfile').write_text('FROM python:3.13-alpine\nCOPY worker.py /worker.py\nCOPY npm /usr/local/bin/npm\nRUN chmod 755 /usr/local/bin/npm\nENTRYPOINT ["npm"]\nCMD ["run","start"]\n')
    docker('build', '--platform', 'linux/amd64', '--label', LABEL, '-t', IMAGE, str(build))
    # This wrapper is only in the disposable test PATH, never shipped as an operator hook.
    bindir = ROOT / 'bin'
    bindir.mkdir()
    shim = bindir / 'docker'
    shim.write_text('''#!PYTHON
import json,os,subprocess,sys,pathlib
real=REAL
conf=pathlib.Path(CONF)
a=sys.argv[1:]
if conf.exists():
 c=json.loads(conf.read_text())
 if a[:2]==['network','connect'] and a[-2]==c['front']:
  target=a[-1]
  if target==c['new'] and c['mode']=='network-failure':
   c['mode']='done';conf.write_text(json.dumps(c));sys.exit(42)
  if c['mode']=='reserve-address':
   if target==c['new']:
    subprocess.check_call([real,'network','connect',c['front'],c['holder']],stdout=subprocess.DEVNULL)
    subprocess.check_call([real,'start',c['holder']],stdout=subprocess.DEVNULL)
   elif target==c['old']:
    subprocess.check_call([real,'stop','-t','2',c['holder']],stdout=subprocess.DEVNULL)
    subprocess.check_call([real,'network','disconnect',c['front'],c['holder']],stdout=subprocess.DEVNULL)
 if a[:1]==['start'] and a[-1]==c['new'] and c['mode'] in ['unhealthy','activation-expiry']:
  subprocess.check_call([real,'cp',c['unhealthyFile'],c['new']+':/tmp/unhealthy'])
os.execv(real,[real]+a)
'''.replace('PYTHON', sys.executable).replace('REAL', repr(REAL_DOCKER)).replace('CONF', repr(str(ROOT / 'injection.json'))))
    shim.chmod(0o700)
    (ROOT / 'unhealthy').touch()
    ENV['PATH'] = str(bindir) + os.pathsep + ENV['PATH']
    for label, mode in [('addresses', 'reserve-address'), ('failure', 'network-failure'),
                        ('unhealthy', 'unhealthy'), ('expiry', 'expiry'),
                        ('activation-expiry', 'activation-expiry'), ('finalize-expiry', 'finalize-expiry')]:
        scenario(label, mode)
    print('CRM_API_RELEASE_DOCKER_INTEGRATION_OK=1', flush=True)


if __name__ == '__main__':
    try:
        main()
    finally:
        # Restrict cleanup to exact IDs/names created by this unique fixture run.
        for name in reversed(CREATED):
            p = subprocess.run([REAL_DOCKER, 'inspect', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if p.returncode == 0:
                c = json.loads(p.stdout)[0]
                if c['Config'].get('Labels', {}).get('crm.release.integration') == PREFIX:
                    subprocess.run([REAL_DOCKER, 'rm', '-f', c['Id']], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                elif name in CREATED and c['Config'].get('Labels', {}).get('crm.release.transaction', '').startswith(str(ROOT)):
                    subprocess.run([REAL_DOCKER, 'rm', '-f', c['Id']], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for name in NETWORKS:
            subprocess.run([REAL_DOCKER, 'network', 'rm', name], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if REAL_DOCKER:
            subprocess.run([REAL_DOCKER, 'image', 'rm', IMAGE], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        shutil.rmtree(str(ROOT), ignore_errors=True)
