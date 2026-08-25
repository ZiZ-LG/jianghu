import { describe, expect, it } from 'vitest';

import {
  beijingEditorialDate,
  buildDailyReviewArtifacts,
  dailyReviewContext,
  parseDailyReviewCliArgs,
  resolveDraftPrAction,
  resolveReviewOutputPath,
  validateDailyIntakeWorkflow,
} from '../../scripts/stephen-daily-review';

function editorialDraft(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'ai',
    titleZh: '模型生成的候选标题',
    summaryZh: '模型生成的候选摘要',
    whyItMattersZh: '模型生成的重要性草稿',
    salesImplicationZh: '模型生成的销售影响草稿',
    roleOrgImplicationZh: '模型生成的岗位组织影响草稿',
    nextActionZh: '模型生成的下一步草稿',
    ...overrides,
  };
}

function intakeRecord(input: {
  readonly candidateId: string;
  readonly disposition?: 'candidate' | 'manual_review' | 'duplicate';
  readonly canonicalUrl?: string;
  readonly draft?: Record<string, unknown>;
}) {
  return {
    candidateId: input.candidateId,
    sourceId: 'openai-news-rss',
    originalTitle: `Original ${input.candidateId}`,
    canonicalUrl: input.canonicalUrl ?? `https://openai.com/index/${input.candidateId.toLowerCase()}`,
    publishedAt: '2026-08-24T07:00:00.000Z',
    fetchedAt: '2026-08-24T08:30:00.000Z',
    sourceSummary: `Source summary ${input.candidateId}`,
    evidenceExcerpt: `Evidence ${input.candidateId}`,
    eventKey: `event-${input.candidateId.toLowerCase()}`,
    contentFingerprint: `fingerprint-${input.candidateId.toLowerCase()}`,
    riskSignals: ['ordinary_product_fact'],
    riskLevel: 'low',
    sourceConflict: false,
    disposition: input.disposition ?? 'candidate',
    reasons: [],
    ruleVersion: 'stephen-intake-v2',
    provenance: {
      protocol: 'rss2',
      feedUrl: 'https://openai.com/news/rss.xml',
      contentType: 'application/rss+xml',
      originalGuid: input.candidateId,
    },
    editorialDraft: input.draft ?? editorialDraft(),
  };
}

function decision(
  itemId: string,
  disposition: 'manual_review' | 'rejected' | 'duplicate' | 'auto_ready',
  riskLevel: 'low' | 'medium' | 'high',
) {
  return {
    itemId,
    sourceId: 'openai-news-rss',
    riskLevel,
    automaticEligibility: riskLevel === 'low',
    disposition,
    reasons: disposition === 'manual_review'
      ? [`${riskLevel} risk requires manual review`, 'automatic publishing is disabled']
      : ['candidate fields are incomplete or invalid'],
    fieldErrors: disposition === 'rejected' ? ['summary.zh is required'] : [],
    audit: {
      sourceFingerprint: `fingerprint-${itemId.toLowerCase()}`,
      ruleVersion: 'stephen-editorial-v1',
      processedAt: '2026-08-24T08:30:00.000Z',
      releaseVersion: 'unreleased',
      rollbackState: 'available',
    },
  };
}

function dailyReport() {
  const proposed = intakeRecord({
    candidateId: 'ED-PROPOSED',
    draft: editorialDraft({
      riskLevel: 'low',
      editorialStatus: 'approved',
      publicationState: 'published',
    }),
  });
  const highRisk = intakeRecord({
    candidateId: 'ED-HIGH',
    disposition: 'manual_review',
  });
  const rejected = intakeRecord({ candidateId: 'ED-REJECTED' });
  const duplicate = intakeRecord({
    candidateId: 'ED-DUPLICATE',
    disposition: 'duplicate',
  });
  return {
    task: 'SAAS-605',
    fetchedAt: '2026-08-24T08:30:00.000Z',
    controls: {
      autoPublishingEnabled: false,
      stopSwitchEngaged: true,
      ruleVersion: 'stephen-editorial-v1',
      releaseVersion: 'unreleased',
    },
    aiMode: 'configured',
    stats: {
      sourcesConfigured: 2,
      sourcesSucceeded: 2,
      sourcesFailed: 0,
      scanned: 4,
      candidates: 2,
      manualReview: 1,
      duplicates: 1,
    },
    scans: [{
      sourceId: 'openai-news-rss',
      feedUrl: 'https://openai.com/news/rss.xml',
      channelTitle: 'OpenAI News',
      scanned: 4,
      candidates: 2,
      manualReview: 1,
      duplicates: 1,
      governance: {
        autoReady: 0,
        manualReview: 2,
        rejected: 1,
        decisions: [
          decision('ED-PROPOSED', 'manual_review', 'medium'),
          decision('ED-HIGH', 'manual_review', 'high'),
          decision('ED-REJECTED', 'rejected', 'high'),
        ],
      },
      records: [proposed, highRisk, rejected, duplicate],
    }, {
      sourceId: 'google-cloud-ai-blog',
      feedUrl: 'https://cloudblog.withgoogle.com/products/ai-machine-learning/rss/',
      channelTitle: 'Google Cloud AI Blog',
      scanned: 0,
      candidates: 0,
      manualReview: 0,
      duplicates: 0,
      governance: {
        autoReady: 0,
        manualReview: 0,
        rejected: 0,
        decisions: [],
      },
      records: [],
    }],
    failures: [],
  };
}

describe('SAAS-606 daily review identity', () => {
  it('uses the Asia/Shanghai calendar day across the UTC boundary', () => {
    expect(beijingEditorialDate(new Date('2026-08-24T15:59:59.000Z')))
      .toBe('2026-08-24');
    expect(beijingEditorialDate(new Date('2026-08-24T16:00:00.000Z')))
      .toBe('2026-08-25');
    expect(beijingEditorialDate(new Date('2026-08-24T23:30:00.000Z')))
      .toBe('2026-08-25');
  });

  it('reuses one stable branch and candidate path for both runs on the same day', () => {
    const morning = dailyReviewContext({
      editorialDate: '2026-08-25',
      mode: 'live',
    });
    const afternoon = dailyReviewContext({
      editorialDate: '2026-08-25',
      mode: 'live',
    });

    expect(morning).toEqual(afternoon);
    expect(morning.branchName).toBe('codex/stephen-daily-2026-08-25');
    expect(morning.manifestPath)
      .toBe('app/stephen/review-candidates/2026-08-25/review-manifest.json');
    expect(morning.ledgerPath)
      .toBe('app/stephen/review-candidates/2026-08-25/discovery-ledger.json');
  });

  it('isolates fixture acceptance branches from daily live branches', () => {
    const fixture = dailyReviewContext({
      editorialDate: '2026-08-25',
      mode: 'fixture',
    });

    expect(fixture.branchName).toBe('codex/stephen-daily-test-2026-08-25');
    expect(fixture.prTitle).toBe('[TEST][自我修养] 2026-08-25 每日候选审核');
  });

  it.each(['2026-02-30', '2026-8-25', '../2026-08-25', '']) (
    'rejects an unsafe or nonexistent editorial date: %s',
    (editorialDate) => {
      expect(() => dailyReviewContext({ editorialDate, mode: 'live' }))
        .toThrow('editorialDate must use a real YYYY-MM-DD date');
    },
  );
});

describe('SAAS-606 deterministic owner-review boundary', () => {
  it('derives counts and risk from SAAS-605 while ignoring AI approval fields', () => {
    const artifacts = buildDailyReviewArtifacts({
      report: dailyReport(),
      editorialDate: '2026-08-24',
      mode: 'fixture',
    });

    expect(artifacts.summary).toEqual({
      sourcesConfigured: 2,
      sourcesScanned: 2,
      sourcesFailed: 0,
      newDiscoveries: 3,
      duplicates: 1,
      rejected: 1,
      manualReview: 2,
      proposed: 2,
    });
    expect(artifacts.manifest.reviewState).toBe('pending_owner_review');
    expect(artifacts.manifest.publicationState).toBe('not_published');
    expect(artifacts.manifest.candidates).toHaveLength(2);
    expect(artifacts.manifest.candidates[0]).toMatchObject({
      candidateId: 'ED-HIGH',
      riskLevel: 'high',
      reviewState: 'pending_owner_review',
      publicationState: 'not_published',
    });
    expect(artifacts.manifest.candidates[1]).toMatchObject({
      candidateId: 'ED-PROPOSED',
      riskLevel: 'medium',
      reviewState: 'pending_owner_review',
      publicationState: 'not_published',
    });
    expect(artifacts.manifest.candidates[1].editorialDraft)
      .not.toHaveProperty('editorialStatus');
    expect(artifacts.manifest.candidates[1].editorialDraft)
      .not.toHaveProperty('riskLevel');
  });

  it.each([
    { autoPublishingEnabled: true, stopSwitchEngaged: true },
    { autoPublishingEnabled: false, stopSwitchEngaged: false },
  ])('fails closed when publication controls are open: %o', (unsafeControls) => {
    const report = dailyReport();
    report.controls = { ...report.controls, ...unsafeControls };

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('SAAS-606 requires automatic publishing disabled and the stop switch engaged');
  });

  it('rejects an auto-ready decision instead of turning it into a review candidate', () => {
    const report = dailyReport();
    report.scans[0].governance.decisions[0] = decision(
      'ED-PROPOSED',
      'auto_ready',
      'low',
    );
    report.scans[0].governance.autoReady = 1;

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('SAAS-606 does not accept auto-ready candidates');
  });

  it('rejects an unsafe proposed source URL', () => {
    const report = dailyReport();
    report.scans[0].records[0] = intakeRecord({
      candidateId: 'ED-PROPOSED',
      canonicalUrl: 'http://openai.com/index/unsafe',
    });

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('proposed candidate URL must use HTTPS');
  });

  it.each([
    'https://openai.com/index/safe>\n\n# injected-heading',
    'https://user:password@openai.com/index/credential-leak',
  ])('rejects a proposed URL that can escape or expose data in PR Markdown: %s', (canonicalUrl) => {
    const report = dailyReport();
    report.scans[0].records[0] = intakeRecord({
      candidateId: 'ED-PROPOSED',
      canonicalUrl,
    });

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('proposed candidate URL must be a safe HTTPS URL');
  });

  it('fails closed instead of silently overwriting duplicate candidate IDs', () => {
    const report = dailyReport();
    report.scans[1].records = [intakeRecord({ candidateId: 'ED-PROPOSED' })];

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('report contains duplicate non-duplicate intake candidate IDs');
  });

  it('keeps the governable record when a later RSS entry is its duplicate', () => {
    const report = dailyReport();
    report.scans[0].records.push(intakeRecord({
      candidateId: 'ED-PROPOSED',
      disposition: 'duplicate',
    }));

    const artifacts = buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    });

    expect(artifacts.manifest.candidates.map((candidate) => candidate.candidateId))
      .toContain('ED-PROPOSED');
    expect(artifacts.summary.duplicates).toBe(2);
  });

  it('fails closed instead of accepting conflicting decisions for one candidate', () => {
    const report = dailyReport();
    report.scans[0].governance.decisions.push(
      decision('ED-PROPOSED', 'rejected', 'high'),
    );

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('report contains duplicate pipeline decision IDs');
  });

  it('rejects source totals that would make the PR summary misleading', () => {
    const report = dailyReport();
    report.stats.sourcesConfigured = 3;

    expect(() => buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'live',
    })).toThrow('report source totals are inconsistent');
  });
});

describe('SAAS-606 same-day Draft PR review state', () => {
  it('does not restore an owner-deleted candidate on the second same-day run', () => {
    const first = buildDailyReviewArtifacts({
      report: dailyReport(),
      editorialDate: '2026-08-24',
      mode: 'live',
    });
    const ownerEditedManifest = {
      ...first.manifest,
      candidates: first.manifest.candidates.filter(
        (candidate) => candidate.candidateId !== 'ED-HIGH',
      ),
    };
    const secondReport = dailyReport();
    secondReport.fetchedAt = '2026-08-24T12:30:00.000Z';
    secondReport.scans[0].records = [
      ...secondReport.scans[0].records,
      intakeRecord({ candidateId: 'ED-NEW' }),
    ];
    secondReport.scans[0].governance.decisions = [
      ...secondReport.scans[0].governance.decisions,
      decision('ED-NEW', 'manual_review', 'medium'),
    ];

    const second = buildDailyReviewArtifacts({
      report: secondReport,
      editorialDate: '2026-08-24',
      mode: 'live',
      existingManifest: ownerEditedManifest,
      existingLedger: first.ledger,
    });

    expect(second.manifest.candidates.map((candidate) => candidate.candidateId))
      .toEqual(['ED-NEW', 'ED-PROPOSED']);
    expect(second.ledger.seenCandidateIds).toContain('ED-HIGH');
    expect(second.ledger.seenCandidateIds).toContain('ED-NEW');
    expect(second.ledger.runs).toHaveLength(2);
    expect(second.summary.proposed).toBe(2);
  });

  it('is idempotent when the same fetched report is retried', () => {
    const first = buildDailyReviewArtifacts({
      report: dailyReport(),
      editorialDate: '2026-08-24',
      mode: 'live',
    });
    const retry = buildDailyReviewArtifacts({
      report: dailyReport(),
      editorialDate: '2026-08-24',
      mode: 'live',
      existingManifest: first.manifest,
      existingLedger: first.ledger,
    });

    expect(retry.manifest).toEqual(first.manifest);
    expect(retry.ledger).toEqual(first.ledger);
  });

  it('renders the complete review summary, safe source links and risk warnings', () => {
    const report = dailyReport();
    report.scans[0].records[0] = {
      ...report.scans[0].records[0],
      originalTitle: '[Release](javascript:alert(1)) <script>alert(2)</script>',
    };
    const artifacts = buildDailyReviewArtifacts({
      report,
      editorialDate: '2026-08-24',
      mode: 'fixture',
    });

    expect(artifacts.prBody).toContain('扫描来源数');
    expect(artifacts.prBody).toContain('新发现数');
    expect(artifacts.prBody).toContain('重复数');
    expect(artifacts.prBody).toContain('拒绝数');
    expect(artifacts.prBody).toContain('manual_review 数');
    expect(artifacts.prBody).toContain('拟发布条目数');
    expect(artifacts.prBody).toContain('https://openai.com/index/ed-proposed');
    expect(artifacts.prBody).toContain('风险：`high`');
    expect(artifacts.prBody).toContain('fixture 验收');
    expect(artifacts.prBody).toContain('删除 `review-manifest.json` 中对应的完整对象');
    expect(artifacts.prBody).toContain('不会修改正式公开集合');
    expect(artifacts.prBody).toContain('**ED-PROPOSED**');
    expect(artifacts.prBody).not.toContain('ED\\-PROPOSED');
    expect(artifacts.prBody).not.toContain('<script>');
    expect(artifacts.prBody.length).toBeLessThan(60_000);
  });

  it('creates once, updates the same open Draft, and skips a closed same-day PR', () => {
    expect(resolveDraftPrAction([])).toEqual({ action: 'create' });
    expect(resolveDraftPrAction([{
      number: 42,
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    }])).toEqual({
      action: 'update',
      number: 42,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    });
    expect(resolveDraftPrAction([{
      number: 42,
      state: 'MERGED',
      isDraft: false,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    }])).toEqual({
      action: 'skip_closed',
      number: 42,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    });
  });

  it('fails closed for a non-Draft or ambiguous matching PR', () => {
    expect(() => resolveDraftPrAction([{
      number: 42,
      state: 'OPEN',
      isDraft: false,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    }])).toThrow('existing review PR is no longer a Draft');
    expect(() => resolveDraftPrAction([{
      number: 42,
      state: 'OPEN',
      isDraft: true,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/42',
    }, {
      number: 43,
      state: 'CLOSED',
      isDraft: true,
      url: 'https://github.com/ZiZ-LG/jianghu/pull/43',
    }])).toThrow('multiple review PRs match the same head and base');
  });
});

describe('SAAS-606 fixture CLI contract', () => {
  it('parses context, generation and PR-resolution commands exactly', () => {
    expect(parseDailyReviewCliArgs([
      'context',
      '--date', '2026-08-24',
      '--mode', 'fixture',
    ])).toEqual({
      command: 'context',
      editorialDate: '2026-08-24',
      mode: 'fixture',
    });
    expect(parseDailyReviewCliArgs([
      'generate',
      '--report', 'stephen/scripts/fixtures/saas-606-intake-report.json',
      '--date', '2026-08-24',
      '--mode', 'fixture',
      '--output-root', '/tmp/saas-606',
      '--body-file', 'pr-body.md',
    ])).toEqual({
      command: 'generate',
      reportPath: 'stephen/scripts/fixtures/saas-606-intake-report.json',
      editorialDate: '2026-08-24',
      mode: 'fixture',
      outputRoot: '/tmp/saas-606',
      bodyFile: 'pr-body.md',
    });
    expect(parseDailyReviewCliArgs([
      'resolve-pr',
      '--prs-file', '/tmp/prs.json',
    ])).toEqual({
      command: 'resolve-pr',
      prsFile: '/tmp/prs.json',
    });
    expect(parseDailyReviewCliArgs([
      'validate-workflow',
      '--workflow', '../.github/workflows/stephen-daily-intake.yml',
    ])).toEqual({
      command: 'validate-workflow',
      workflowFile: '../.github/workflows/stephen-daily-intake.yml',
    });
  });

  it.each([
    { argv: [] },
    { argv: ['unknown'] },
    { argv: ['context', '--date', '2026-08-24'] },
    { argv: ['context', '--date', '2026-08-24', '--mode', 'fixture', '--extra', 'x'] },
    { argv: ['generate', '--report', 'report.json', '--date', '2026-08-24', '--mode', 'fixture'] },
    { argv: ['resolve-pr'] },
    { argv: ['validate-workflow'] },
  ])('rejects incomplete or unknown CLI input: $argv', ({ argv }) => {
    expect(() => parseDailyReviewCliArgs(argv)).toThrow('invalid SAAS-606 CLI arguments');
  });

  it('resolves only relative write paths within the selected output root', () => {
    expect(resolveReviewOutputPath(
      '/tmp/saas-606',
      'app/stephen/review-candidates/2026-08-24/review-manifest.json',
    )).toBe('/tmp/saas-606/app/stephen/review-candidates/2026-08-24/review-manifest.json');
    expect(() => resolveReviewOutputPath('/tmp/saas-606', '../outside.json'))
      .toThrow('output path must stay within output-root');
    expect(() => resolveReviewOutputPath('/tmp/saas-606', '/absolute.json'))
      .toThrow('output path must stay within output-root');
    expect(() => resolveReviewOutputPath('/tmp/saas-606', 'nested\\windows.json'))
      .toThrow('output path must stay within output-root');
    expect(() => resolveReviewOutputPath('/tmp/saas-606/../outside', 'file.json'))
      .toThrow('output path must stay within output-root');
    expect(() => resolveReviewOutputPath('/', 'file.json'))
      .toThrow('output path must stay within output-root');
  });
});

const validWorkflowContract = `
name: Stephen daily candidate review
on:
  schedule:
    - cron: '30 23 * * *'
    - cron: '30 8 * * *'
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: stephen-daily-candidate-review
  cancel-in-progress: false
jobs:
  review:
    if: github.event_name != 'schedule' || vars.STEPHEN_DAILY_SCHEDULE_ENABLED == '1'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: |
          if [[ "$mode" == "live" && ( "$target_base" != "$DEFAULT_BRANCH" || "$CURRENT_REF" != "$DEFAULT_BRANCH" ) ]]; then
            exit 1
          fi
      - run: |
          allowed_manifest="app/stephen/review-candidates/$EDITORIAL_DATE/review-manifest.json"
          allowed_ledger="app/stephen/review-candidates/$EDITORIAL_DATE/discovery-ledger.json"
          for saas606_allowed_file in "$allowed_manifest" "$allowed_ledger"; do
            git ls-tree "origin/$CANDIDATE_BRANCH" -- "$saas606_allowed_file"
            if [[ "$saas606_mode" != "100644" || "$saas606_type" != "blob" ]]; then
              exit 1
            fi
          done
          while IFS= read -r -d '' changed_path; do
            if [[ "$changed_path" != "$allowed_manifest" && "$changed_path" != "$allowed_ledger" ]]; then
              exit 1
            fi
          done < <(git diff --name-only -z "origin/$TARGET_BASE...origin/$CANDIDATE_BRANCH")
      - run: npm ci --install-links
      - run: npx tsc --noEmit -p stephen/tsconfig.json
      - run: npx tsc --noEmit -p stephen/tsconfig.editorial.json
      - run: npx vitest run --root stephen
      - run: npm run build:stephen
      - run: git add -- ":(top)$MANIFEST_PATH" ":(top)$LEDGER_PATH"
      - env:
          EDITORIAL_AI_BASE_URL: \${{ secrets.EDITORIAL_AI_BASE_URL }}
          EDITORIAL_AI_MODEL: \${{ secrets.EDITORIAL_AI_MODEL }}
          EDITORIAL_AI_API_KEY: \${{ secrets.EDITORIAL_AI_API_KEY }}
        run: |
          if ! node --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts > "$RUNNER_TEMP/saas-605-report.json"; then
            echo "one or more sources failed; continuing with the bounded partial report" >&2
          fi
      - env:
          GITHUB_TOKEN: \${{ github.token }}
        if: steps.pr_state.outputs.action == 'create' && steps.generate.outputs.proposed_count != '0'
        run: gh pr create --draft
      - run: gh pr edit 42
`;

describe('SAAS-606 GitHub workflow safety contract', () => {
  it('accepts the approved schedules, runner, permissions and review commands', () => {
    expect(validateDailyIntakeWorkflow(validWorkflowContract)).toEqual({
      schedules: ['30 23 * * *', '30 8 * * *'],
      runner: 'ubuntu-latest',
      permissions: ['contents: write', 'pull-requests: write'],
    });
  });

  it.each([
    {
      label: 'paid runner',
      workflow: validWorkflowContract.replace('ubuntu-latest', 'macos-latest'),
      error: 'workflow runner must be ubuntu-latest',
    },
    {
      label: 'wrong Beijing schedule',
      workflow: validWorkflowContract.replace("'30 23 * * *'", "'30 7 * * *'"),
      error: 'workflow schedules must represent Beijing 07:30 and 16:30',
    },
    {
      label: 'scheduled production runs enabled by default',
      workflow: validWorkflowContract.replace(
        "    if: github.event_name != 'schedule' || vars.STEPHEN_DAILY_SCHEDULE_ENABLED == '1'\n",
        '',
      ),
      error: 'scheduled production runs must require explicit opt-in',
    },
    {
      label: 'untrusted pull request target',
      workflow: validWorkflowContract.replace('  workflow_dispatch:', '  pull_request_target:\n  workflow_dispatch:'),
      error: 'pull_request_target is forbidden',
    },
    {
      label: 'overbroad actions permission',
      workflow: validWorkflowContract.replace('  pull-requests: write', '  pull-requests: write\n  actions: write'),
      error: 'workflow permissions must be minimal',
    },
    {
      label: 'secret from dispatch input',
      workflow: validWorkflowContract.replace(
        '\${{ secrets.EDITORIAL_AI_API_KEY }}',
        '\${{ inputs.EDITORIAL_AI_API_KEY }}',
      ),
      error: 'editorial AI configuration must come from GitHub Secrets',
    },
    {
      label: 'non-draft PR',
      workflow: validWorkflowContract.replace('gh pr create --draft', 'gh pr create'),
      error: 'workflow must create a Draft PR',
    },
    {
      label: 'candidate paths relative to the app working directory',
      workflow: validWorkflowContract.replace(
        'git add -- ":(top)$MANIFEST_PATH" ":(top)$LEDGER_PATH"',
        'git add -- "$MANIFEST_PATH" "$LEDGER_PATH"',
      ),
      error: 'workflow must stage candidate files from the repository root',
    },
    {
      label: 'mutable candidate branch code executed with workflow permissions',
      workflow: validWorkflowContract.replace(
        'git diff --name-only -z "origin/$TARGET_BASE...origin/$CANDIDATE_BRANCH"',
        'git status --short',
      ),
      error: 'candidate branch may only change its review manifest and ledger',
    },
    {
      label: 'live mode allowed from a non-default workflow ref',
      workflow: validWorkflowContract.replace(
        '"$CURRENT_REF" != "$DEFAULT_BRANCH"',
        '"$CURRENT_REF" == ""',
      ),
      error: 'live mode must run from and target the default branch',
    },
    {
      label: 'candidate review files allowed to be symlinks or missing',
      workflow: validWorkflowContract.replace(
        'git ls-tree "origin/$CANDIDATE_BRANCH" -- "$saas606_allowed_file"',
        'git status --short',
      ),
      error: 'candidate review files must be regular non-executable blobs',
    },
    {
      label: 'partial source reports discarded after one RSS failure',
      workflow: validWorkflowContract.replace(
        'if ! node --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts',
        'node --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts',
      ),
      error: 'workflow must preserve bounded partial source reports',
    },
    {
      label: 'secret value printed by a shell command',
      workflow: `${validWorkflowContract}\n      - run: echo "$EDITORIAL_AI_API_KEY"\n`,
      error: 'workflow commands must not print secrets',
    },
    {
      label: 'empty Draft PR creation allowed',
      workflow: validWorkflowContract.replace(
        " && steps.generate.outputs.proposed_count != '0'",
        '',
      ),
      error: 'workflow must not create an empty Draft PR',
    },
  ])('rejects $label', ({ workflow, error }) => {
    expect(() => validateDailyIntakeWorkflow(workflow)).toThrow(error);
  });
});
