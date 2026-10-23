#!/usr/bin/env python3
"""Choose full validation or explicitly proven documentation-only reuse."""
import argparse
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time
import zipfile

DOCS = frozenset([
    'docs/商业版开发待办清单v1.md',
    'docs/CRM-API发布与回滚.md',
])
REUSABLE = frozenset([
    'domain-contracts', 'app', 'server', 'g64111', 'pde-kernel',
    'postgres-operations', 'crm-release',
])
FRESH = frozenset(['production-images'] + [
    'dependency-audit ({})'.format(p) for p in
    ['app', 'server', 'packages/domain-contracts', 'packages/g64111',
     'packages/pde-kernel']
])
REQUIRED = REUSABLE | FRESH
MAX_AGE = 6 * 60 * 60
SCHEMA = 1


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.DEVNULL,
                                   timeout=30)


def inventory(ref='HEAD'):
    """Hash every tracked input except the two opt-in, non-executable documents."""
    rows = git('ls-tree', '-r', '-z', ref).split(b'\0')
    code, docs = [], {}
    valid = True
    for row in rows:
        if not row:
            continue
        meta, raw_path = row.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        mode, kind, oid = meta.decode().split()
        if path not in DOCS:
            code.append(row)
            continue
        docs[path] = {'mode': mode, 'oid': oid}
        if mode != '100644' or kind != 'blob':
            valid = False
            continue
        content = git('cat-file', 'blob', oid)
        try:
            content.decode('utf-8')
            valid = valid and b'\0' not in content and len(content) <= 2_000_000
        except UnicodeDecodeError:
            valid = False
    return {
        'fingerprint': hashlib.sha256(b'\0'.join(sorted(code))).hexdigest(),
        'documents': docs,
        'documents_valid': valid and set(docs) == DOCS,
    }


def context(event, env, now):
    p = event.get('pull_request') or {}
    head, base = p.get('head') or {}, p.get('base') or {}
    result = {
        'schema': SCHEMA,
        'repository': env['GITHUB_REPOSITORY'],
        'event': env['GITHUB_EVENT_NAME'],
        'run_id': int(env['GITHUB_RUN_ID']),
        'attempt': int(env.get('GITHUB_RUN_ATTEMPT', '1')),
        'created_epoch': now,
        'tested_sha': env['GITHUB_SHA'],
        'head_sha': head.get('sha', env['GITHUB_SHA']),
        'base_sha': base.get('sha'),
        'branch': head.get('ref', env.get('GITHUB_REF_NAME')),
        'head_repository': (head.get('repo') or {}).get('full_name'),
        'pr': p.get('number'),
        'mode': 'full',
        'reason': 'No verified reusable evidence',
        'full_source': None,
    }
    result.update(inventory())
    return result


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


class GitHub:
    """Use the runner's read-only token through gh; never print credentials/logs."""
    def __init__(self, repository):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
            raise ValueError('Invalid repository')
        self.repository = repository

    def request(self, endpoint, binary=False):
        p = subprocess.run(
            ['gh', 'api', 'repos/' + self.repository + '/' + endpoint],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if p.returncode:
            raise ValueError('GitHub evidence unavailable')
        return p.stdout if binary else json.loads(p.stdout)

    def latest(self, branch, exclude, head=None):
        from urllib.parse import urlencode
        query = {'branch': branch, 'per_page': 100}
        if head:
            query['head_sha'] = head
        data = self.request('actions/workflows/ci.yml/runs?' + urlencode(query))
        runs = data['workflow_runs']
        if data['total_count'] != len(runs):
            raise ValueError('Incomplete run inventory')
        rows = [r for r in runs if r['id'] != exclude and r['head_branch'] == branch]
        # Select the newest created run first, THEN refresh that run's latest
        # attempt. Rerunning an older ancestor must not hide a newer failure.
        return max(rows, key=lambda r: (timestamp(r['created_at']), r['id'])) if rows else None

    def full_run(self, run_id):
        return self.request('actions/runs/' + str(run_id))

    def jobs(self, run):
        data = self.request('actions/runs/{}/attempts/{}/jobs?per_page=100'.format(
            run['id'], run['run_attempt']))
        if data['total_count'] != len(data['jobs']):
            raise ValueError('Incomplete jobs evidence')
        return data['jobs']

    def manifest(self, run):
        data = self.request('actions/runs/{}/artifacts?per_page=100'.format(run['id']))
        if data['total_count'] != len(data['artifacts']):
            raise ValueError('Incomplete artifact inventory')
        name = 'ci-validation-context-' + str(run['run_attempt'])
        rows = [a for a in data['artifacts'] if a['name'] == name and not a['expired']]
        if len(rows) != 1:
            raise ValueError('Missing or ambiguous context artifact')
        a = rows[0]
        if a['size_in_bytes'] > 100_000:
            raise ValueError('Oversized context artifact')
        raw = self.request('actions/artifacts/{}/zip'.format(a['id']), binary=True)
        if len(raw) > 100_000:
            raise ValueError('Oversized context archive')
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            if z.namelist() != ['context.json']:
                raise ValueError('Unexpected context archive')
            entry = z.getinfo('context.json')
            if entry.file_size > 64_000:
                raise ValueError('Oversized context document')
            return json.loads(z.read(entry))


def compatible(current, previous, ancestor):
    if not previous.get('documents_valid') or not current.get('documents_valid'):
        return False
    if current.get('repository') != previous.get('repository'):
        return False
    if not current.get('fingerprint') or current['fingerprint'] != previous.get('fingerprint'):
        return False
    if set(previous.get('documents', {})) != DOCS:
        return False
    if previous.get('event') == 'push':
        return (previous.get('branch') == 'main'
                and previous.get('head_sha') == current.get('base_sha'))
    return (previous.get('event') == 'pull_request'
            and previous.get('pr') == current.get('pr')
            and previous.get('branch') == current.get('branch')
            and previous.get('head_repository') == current.get('head_repository')
            and previous.get('base_sha') == current.get('base_sha')
            and ancestor(previous['head_sha'], current['head_sha']))


def verified_record(api, run_id, current, now, ancestor, full=False):
    # Refresh exact latest attempt, never trust the list result's old conclusion.
    r = api.full_run(run_id)
    if (r['status'] != 'completed' or r['conclusion'] != 'success'
            or r['path'] != '.github/workflows/ci.yml'
            or not 0 <= now - timestamp(r['updated_at']) <= MAX_AGE):
        raise ValueError('Run incomplete, failed, wrong workflow or stale')
    m = api.manifest(r)
    if (m.get('schema') != SCHEMA or m.get('run_id') != r['id']
            or m.get('attempt') != r['run_attempt']
            or m.get('head_sha') != r['head_sha']
            or m.get('event') != r['event']
            or m.get('branch') != r['head_branch']
            or not 0 <= now - m.get('created_epoch', 0) <= MAX_AGE
            or not compatible(current, m, ancestor)):
        raise ValueError('Context binding or input equivalence mismatch')
    jobs = api.jobs(r)
    names = [j['name'] for j in jobs]
    if (len(names) != len(set(names))
            or set(names) != REQUIRED | {'validation-plan', 'validation-gate'}):
        raise ValueError('Missing or duplicate required jobs')
    mode = m.get('mode')
    if full and mode != 'full':
        raise ValueError('A reused result cannot serve as full test execution')
    if mode not in ['full', 'reuse']:
        raise ValueError('Unknown validation mode')
    for j in jobs:
        if j['status'] != 'completed' or j['conclusion'] != 'success':
            raise ValueError('Job incomplete, failed or unexpectedly skipped')
    return r, m


def decide(current, api, now, ancestor):
    result = dict(current)
    if (current['event'] != 'pull_request' or current['attempt'] != 1
            or not current.get('pr') or not current.get('base_sha')
            or not current.get('documents_valid')):
        result['reason'] = 'Main/manual/rerun/unknown scope requires full validation'
        return result
    try:
        latest = api.latest(current['branch'], current['run_id'])
        if latest is None:
            latest = api.latest('main', current['run_id'], head=current['base_sha'])
        if latest is None:
            raise ValueError('No previous run')
        r, prior = verified_record(api, latest['id'], current, now, ancestor)
        if prior['documents'] == current['documents']:
            raise ValueError('No verified documentation change')
        if prior['mode'] == 'full':
            source = r
        else:
            source_id = prior.get('full_source')
            if not isinstance(source_id, int) or source_id == r['id']:
                raise ValueError('Missing original full validation source')
            source, _ = verified_record(api, source_id, current, now, ancestor, full=True)
        result.update(mode='reuse', reason='Only allowlisted documentation differs; '
                      'original full test execution verified; fresh audits/images still run',
                      full_source=source['id'],
                      full_source_attempt=source['run_attempt'],
                      full_source_url='https://github.com/{}/actions/runs/{}'.format(
                          current['repository'], source['id']))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError,
            zipfile.BadZipFile):
        # Missing/failed/unknown evidence does not select an older green source.
        result.update(mode='full', reason='Evidence missing, failed, stale, '
                      'incomplete or not equivalent; full validation required',
                      full_source=None)
    return result


def is_ancestor(old, new):
    if not all(re.fullmatch('[0-9a-f]{40}', x or '') for x in [old, new]):
        return False
    return subprocess.run(['git', 'merge-base', '--is-ancestor', old, new],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=30).returncode == 0


def gate(needs):
    plan = needs.get('validation-plan', {})
    mode = plan.get('outputs', {}).get('mode')
    if plan.get('result') != 'success' or mode not in ['full', 'reuse']:
        return False
    job_ids = ['domain-contracts', 'app', 'server', 'g64111', 'pde-kernel',
               'dependency-audit', 'production-images', 'postgres-operations', 'crm-release']
    if set(needs) != set(job_ids) | {'validation-plan'}:
        return False
    for name in job_ids:
        if needs.get(name, {}).get('result') != 'success':
            return False
    return True


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['plan', 'gate', 'guard'])
    args = p.parse_args()
    if args.action == 'guard':
        mode = os.environ.get('PLAN_MODE')
        if os.environ.get('PLAN_RESULT') != 'success' or mode not in ['full', 'reuse']:
            raise SystemExit('Required check failed: validation plan is not valid')
        if mode == 'reuse':
            repo = os.environ['GITHUB_REPOSITORY']
            url = os.environ.get('SOURCE_URL', '')
            if not re.fullmatch(re.escape('https://github.com/' + repo)
                                + r'/actions/runs/[0-9]+', url):
                raise SystemExit('Required check failed: reuse has no bound original run')
            print('VERIFIED REUSE; these tests did not execute again. Original full run: ' + url)
        else:
            print('FULL: execute the original validation steps')
        return
    if args.action == 'gate':
        needs = json.loads(os.environ['NEEDS_JSON'])
        if not gate(needs):
            raise SystemExit('Validation gate failed: missing/failed/unexpected results')
        print('Validation gate passed; mode=' + needs['validation-plan']['outputs']['mode'])
        return
    now = time.time()
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    c = context(event, os.environ, now)
    chosen = decide(c, GitHub(c['repository']), now, is_ancestor)
    path = Path(os.environ['RUNNER_TEMP']) / 'ci-validation' / 'context.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(chosen, ensure_ascii=False, indent=2) + '\n')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
        f.write('mode=' + chosen['mode'] + '\n')
        f.write('context_path=' + str(path) + '\n')
        f.write('source_url=' + chosen.get('full_source_url', '') + '\n')
    summary = ('## CI validation: ' + chosen['mode'].upper() + '\n\n'
               + chosen['reason'] + '\n\nCurrent head: ' + chosen['head_sha'] + '\n')
    if chosen['mode'] == 'reuse':
        summary += ('\nOriginal full execution: ' + chosen['full_source_url']
                    + ' (attempt ' + str(chosen['full_source_attempt']) + ').\n'
                    '\nThe seven reusable jobs execute their required-check guard, but '
                    'skip their original test steps in this run. This is verified '
                    'reuse, not a claim that these tests ran again. All dependency audits '
                    'and production image builds execute fresh. Main always executes full validation.\n')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as f:
        f.write(summary)
    print(json.dumps({'mode': chosen['mode'], 'reason': chosen['reason'],
                      'full_source': chosen['full_source']}))


if __name__ == '__main__':
    main()
