import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECKS = Object.freeze(['docs', 'domain-contracts', 'app', 'server',
  'g64111', 'pde-kernel', 'dependency-audit', 'production-images',
  'postgres-operations', 'legacy-postgres-operations']);

const explanatory = /^(?:AGENTS\.md|CLAUDE\.md|README\.md|docs\/(?:ADR-\d+-[^/]+\.md|研发协作协议v1\.md|商业版开发待办清单v1\.md|designs\/[^/]+\.md|superpowers\/plans\/[^/]+\.md))$/;
const legacy = /^(?:scripts\/test-postgres-ops-integration\.sh|server\/prisma\/postgres\/legacy\/|server\/scripts\/deploy-postgres-migrations\.sh|deploy-company-bootstrap-int501\.sh)/;
const dependency = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|\.npmrc)$/;
const shaPattern = /^[a-f0-9]{40}$/;

export function selectChecks(paths, { forceFull = false, legacyRequested = false } = {}) {
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p ||
      p.startsWith('/') || p.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f\x7f]/.test(p))) {
    throw new Error('Invalid candidate paths');
  }
  if (typeof forceFull !== 'boolean' || typeof legacyRequested !== 'boolean') throw new Error('Invalid selection mode');
  const checks = Object.fromEntries(CHECKS.map(name => [name, name === 'docs']));
  const reasons = [];
  let full = forceFull || paths.length === 0;
  if (full) reasons.push(forceFull ? 'Full verification event' : 'Unknown/empty candidate impact');
  checks['legacy-postgres-operations'] = legacyRequested;
  for (const path of paths) {
    if (legacy.test(path)) checks['legacy-postgres-operations'] = true;
    if (explanatory.test(path)) continue;
    if (dependency.test(path)) {
      full = true;
      reasons.push(`Dependency and consumers: ${path}`);
    } else if (/^app\/(?:src|public)\//.test(path) && !/^app\/public\/stephen\//.test(path)) {
      checks.app = true;
      reasons.push(`Frontend regression and build: ${path}`);
    } else if (/^server\/(?:src|tests)\//.test(path)) {
      for (const name of ['app', 'domain-contracts', 'server', 'production-images', 'postgres-operations']) checks[name] = true;
      reasons.push(`Backend, consumers and persistence: ${path}`);
    } else {
      // Includes shared packages, consumed Markdown, schema, CI/ops and every
      // unclassified path. New subsystems must never silently get docs-only CI.
      full = true;
      reasons.push(`Critical/shared or unclassified impact: ${path}`);
    }
  }
  if (full) for (const name of CHECKS) if (name !== 'legacy-postgres-operations') checks[name] = true;
  return { full, forceFull, legacyRequested, checks, reasons };
}

export function candidatePaths(cwd, baseSha, headSha) {
  if (!shaPattern.test(baseSha) || !shaPattern.test(headSha)) throw new Error('Expected exact base/head SHA');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const mergeBase = git('merge-base', baseSha, headSha).trim();
  if (!shaPattern.test(mergeBase)) throw new Error('Candidate merge base missing');
  const paths = git('diff', '--no-renames', '--name-only', '-z', mergeBase, headSha, '--').split('\0').filter(Boolean).sort();
  return { mergeBase, paths };
}

export function eventRequiresFull(event) {
  if (!['pull_request', 'push', 'workflow_dispatch', 'schedule'].includes(event)) throw new Error('Unknown CI event');
  return event !== 'pull_request';
}

export function resolveBase(cwd, explicitSha) {
  if (explicitSha) {
    if (!shaPattern.test(explicitSha)) throw new Error('Invalid event base SHA');
    return explicitSha;
  }
  // Manual branch verification still records the entire candidate against main.
  // fetch-depth: 0 provides this ref; a missing ref is a failure, not an empty diff.
  return execFileSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
    { cwd, encoding: 'utf8' }).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const headSha = process.env.CI_HEAD_SHA;
  const baseSha = resolveBase(process.cwd(), process.env.CI_BASE_SHA);
  const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (checkedOut !== headSha) throw new Error('Checkout does not match candidate SHA');
  const candidate = candidatePaths(process.cwd(), baseSha, headSha);
  const plan = { schemaVersion: 1, headSha, baseSha, ...candidate,
    ...selectChecks(candidate.paths, { forceFull: eventRequiresFull(process.env.GITHUB_EVENT_NAME),
      legacyRequested: process.env.CI_LEGACY === 'true' }) };
  const json = JSON.stringify(plan);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `selection=${json}\n`);
    for (const name of CHECKS) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${plan.checks[name]}\n`);
  }
  if (process.env.CI_SELECTION_FILE) writeFileSync(process.env.CI_SELECTION_FILE, `${json}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## CORE-215 check selection\n\n- Candidate: \`${headSha}\`\n- Base: \`${baseSha}\`\n- Merge base: \`${plan.mergeBase}\`\n- Scope: ${plan.full ? 'complete current baseline' : 'affected modules'}\n- Required: ${CHECKS.filter(k => plan.checks[k]).join(', ')}\n- Candidate paths: ${plan.paths.length}\n\nMain push always requires complete current verification before the unchanged shared release trigger can accept CI success.\n`);
  console.log(json);
}
