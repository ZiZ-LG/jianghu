export type DailyReviewMode = 'fixture' | 'live';

export interface DailyReviewContextInput {
  readonly editorialDate: string;
  readonly mode: DailyReviewMode;
}

export interface DailyReviewContext {
  readonly editorialDate: string;
  readonly mode: DailyReviewMode;
  readonly branchName: string;
  readonly manifestPath: string;
  readonly ledgerPath: string;
  readonly prTitle: string;
}

export type DailyReviewRiskLevel = 'low' | 'medium' | 'high';

export interface DailyEditorialDraft {
  readonly mode: 'ai' | 'deterministic_fallback';
  readonly fallbackReason?: 'ai_not_configured' | 'ai_unavailable';
  readonly titleZh: string;
  readonly summaryZh: string;
  readonly whyItMattersZh: string;
  readonly salesImplicationZh: string;
  readonly roleOrgImplicationZh: string;
  readonly nextActionZh: string;
}

export interface DailyReviewCandidate {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly originalTitle: string;
  readonly canonicalUrl: string;
  readonly publishedAt: string;
  readonly fetchedAt: string;
  readonly sourceSummary: string;
  readonly evidenceExcerpt: string;
  readonly eventKey: string;
  readonly contentFingerprint: string;
  readonly riskLevel: DailyReviewRiskLevel;
  readonly riskReasons: readonly string[];
  readonly editorialDraft: DailyEditorialDraft;
  readonly reviewState: 'pending_owner_review';
  readonly publicationState: 'not_published';
}

export interface DailyReviewSummary {
  readonly sourcesConfigured: number;
  readonly sourcesScanned: number;
  readonly sourcesFailed: number;
  readonly newDiscoveries: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly manualReview: number;
  readonly proposed: number;
}

export interface DailyReviewManifest {
  readonly schemaVersion: 1;
  readonly task: 'SAAS-606';
  readonly editorialDate: string;
  readonly generatedAt: string;
  readonly reviewState: 'pending_owner_review';
  readonly publicationState: 'not_published';
  readonly controls: {
    readonly autoPublishingEnabled: false;
    readonly stopSwitchEngaged: true;
  };
  readonly candidates: readonly DailyReviewCandidate[];
}

export interface DailyReviewLedgerRun {
  readonly fetchedAt: string;
  readonly summary: DailyReviewSummary;
}

export interface DailyReviewLedger {
  readonly schemaVersion: 1;
  readonly task: 'SAAS-606';
  readonly editorialDate: string;
  readonly seenCandidateIds: readonly string[];
  readonly runs: readonly DailyReviewLedgerRun[];
}

export interface DailyReviewArtifacts {
  readonly context: DailyReviewContext;
  readonly summary: DailyReviewSummary;
  readonly manifest: DailyReviewManifest;
  readonly ledger: DailyReviewLedger;
  readonly prBody: string;
}

export interface BuildDailyReviewArtifactsInput {
  readonly report: unknown;
  readonly editorialDate: string;
  readonly mode: DailyReviewMode;
  readonly existingManifest?: unknown;
  readonly existingLedger?: unknown;
}

export type DraftPrAction =
  | { readonly action: 'create' }
  | {
    readonly action: 'update' | 'skip_closed';
    readonly number: number;
    readonly url: string;
  };

export type DailyReviewCliCommand =
  | {
    readonly command: 'context';
    readonly editorialDate: string;
    readonly mode: DailyReviewMode;
  }
  | {
    readonly command: 'generate';
    readonly reportPath: string;
    readonly editorialDate: string;
    readonly mode: DailyReviewMode;
    readonly outputRoot: string;
    readonly bodyFile: string;
  }
  | {
    readonly command: 'resolve-pr';
    readonly prsFile: string;
  }
  | {
    readonly command: 'validate-workflow';
    readonly workflowFile: string;
  };

interface ParsedIntakeRecord {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly originalTitle: string;
  readonly canonicalUrl: string | null;
  readonly publishedAt: string | null;
  readonly fetchedAt: string;
  readonly sourceSummary: string;
  readonly evidenceExcerpt: string;
  readonly eventKey: string;
  readonly contentFingerprint: string;
  readonly disposition: 'candidate' | 'manual_review' | 'duplicate';
  readonly editorialDraft?: DailyEditorialDraft;
}

interface ParsedDecision {
  readonly itemId: string;
  readonly riskLevel: DailyReviewRiskLevel;
  readonly disposition: 'manual_review' | 'rejected' | 'duplicate' | 'auto_ready';
  readonly reasons: readonly string[];
}

interface ParsedReport {
  readonly fetchedAt: string;
  readonly sourcesConfigured: number;
  readonly sourcesFailed: number;
  readonly sourcesScanned: number;
  readonly records: readonly ParsedIntakeRecord[];
  readonly decisions: readonly ParsedDecision[];
}

function requireDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('editorialDate must use a real YYYY-MM-DD date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('editorialDate must use a real YYYY-MM-DD date');
  }
}

function invalidCliArguments(): never {
  throw new Error('invalid SAAS-606 CLI arguments');
}

function parseCliOptions(values: readonly string[]) {
  if (values.length % 2 !== 0) invalidCliArguments();
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || !value || options.has(key)) invalidCliArguments();
    options.set(key, value);
  }
  return options;
}

function requireExactOptions(
  options: ReadonlyMap<string, string>,
  expected: readonly string[],
) {
  if (options.size !== expected.length
    || expected.some((key) => !options.has(key))) invalidCliArguments();
}

function cliMode(value: string | undefined): DailyReviewMode {
  if (value !== 'fixture' && value !== 'live') invalidCliArguments();
  return value;
}

export function parseDailyReviewCliArgs(argv: readonly string[]): DailyReviewCliCommand {
  const [command, ...optionValues] = argv;
  const options = parseCliOptions(optionValues);
  if (command === 'context') {
    requireExactOptions(options, ['--date', '--mode']);
    const editorialDate = options.get('--date')!;
    const mode = cliMode(options.get('--mode'));
    try {
      dailyReviewContext({ editorialDate, mode });
    } catch {
      invalidCliArguments();
    }
    return { command, editorialDate, mode };
  }
  if (command === 'generate') {
    requireExactOptions(options, [
      '--report',
      '--date',
      '--mode',
      '--output-root',
      '--body-file',
    ]);
    const reportPath = options.get('--report')!;
    const editorialDate = options.get('--date')!;
    const mode = cliMode(options.get('--mode'));
    const outputRoot = options.get('--output-root')!;
    const bodyFile = options.get('--body-file')!;
    if (!reportPath || !outputRoot || !bodyFile) invalidCliArguments();
    try {
      dailyReviewContext({ editorialDate, mode });
      resolveReviewOutputPath(outputRoot, bodyFile);
    } catch {
      invalidCliArguments();
    }
    return {
      command,
      reportPath,
      editorialDate,
      mode,
      outputRoot,
      bodyFile,
    };
  }
  if (command === 'resolve-pr') {
    requireExactOptions(options, ['--prs-file']);
    const prsFile = options.get('--prs-file')!;
    if (!prsFile) invalidCliArguments();
    return { command, prsFile };
  }
  if (command === 'validate-workflow') {
    requireExactOptions(options, ['--workflow']);
    const workflowFile = options.get('--workflow')!;
    if (!workflowFile) invalidCliArguments();
    return { command, workflowFile };
  }
  return invalidCliArguments();
}

export function resolveReviewOutputPath(outputRoot: string, relativePath: string) {
  const normalizedRoot = outputRoot.replace(/\/+$/, '');
  const rootSegments = normalizedRoot.split('/').slice(1);
  const segments = relativePath.split('/');
  if (!outputRoot.startsWith('/')
    || normalizedRoot === ''
    || outputRoot.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(outputRoot)
    || rootSegments.some((segment) => segment === '' || segment === '.' || segment === '..')
    || relativePath.startsWith('/')
    || relativePath.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(relativePath)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('output path must stay within output-root');
  }
  return `${normalizedRoot}/${relativePath}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireSafeHttpsUrl(value: unknown, label: string) {
  const text = requireString(value, label);
  if (!text.startsWith('https://')) {
    throw new Error(`${label} must use HTTPS`);
  }
  if (/[<>\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`${label} must be a safe HTTPS URL`);
  }
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:'
      || parsed.hostname === ''
      || parsed.username !== ''
      || parsed.password !== '') {
      throw new Error('unsafe URL components');
    }
    return parsed.href;
  } catch {
    throw new Error(`${label} must be a safe HTTPS URL`);
  }
}

function requireIsoTimestamp(value: unknown, label: string) {
  const timestamp = requireString(value, label);
  if (!timestamp.includes('T') || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireStringArray(value: unknown, label: string) {
  return requireArray(value, label).map((entry, index) => (
    requireString(entry, `${label}[${index}]`)
  ));
}

function parseEditorialDraft(value: unknown): DailyEditorialDraft | undefined {
  if (value === undefined) return undefined;
  const draft = requireRecord(value, 'editorialDraft');
  if (draft.mode !== 'ai' && draft.mode !== 'deterministic_fallback') {
    throw new Error('editorialDraft.mode is invalid');
  }
  const fallbackReason = draft.fallbackReason;
  if (fallbackReason !== undefined
    && fallbackReason !== 'ai_not_configured'
    && fallbackReason !== 'ai_unavailable') {
    throw new Error('editorialDraft.fallbackReason is invalid');
  }
  return {
    mode: draft.mode,
    ...(fallbackReason ? { fallbackReason } : {}),
    titleZh: requireString(draft.titleZh, 'editorialDraft.titleZh'),
    summaryZh: requireString(draft.summaryZh, 'editorialDraft.summaryZh'),
    whyItMattersZh: requireString(
      draft.whyItMattersZh,
      'editorialDraft.whyItMattersZh',
    ),
    salesImplicationZh: requireString(
      draft.salesImplicationZh,
      'editorialDraft.salesImplicationZh',
    ),
    roleOrgImplicationZh: requireString(
      draft.roleOrgImplicationZh,
      'editorialDraft.roleOrgImplicationZh',
    ),
    nextActionZh: requireString(draft.nextActionZh, 'editorialDraft.nextActionZh'),
  };
}

function parseIntakeRecord(value: unknown, sourceName: string): ParsedIntakeRecord {
  const record = requireRecord(value, 'intake record');
  if (record.disposition !== 'candidate'
    && record.disposition !== 'manual_review'
    && record.disposition !== 'duplicate') {
    throw new Error('intake record disposition is invalid');
  }
  const canonicalUrl = record.canonicalUrl === null
    ? null
    : requireString(record.canonicalUrl, 'intake record canonicalUrl');
  const publishedAt = record.publishedAt === null
    ? null
    : requireIsoTimestamp(record.publishedAt, 'intake record publishedAt');
  return {
    candidateId: requireString(record.candidateId, 'intake record candidateId'),
    sourceId: requireString(record.sourceId, 'intake record sourceId'),
    sourceName,
    originalTitle: requireString(record.originalTitle, 'intake record originalTitle'),
    canonicalUrl,
    publishedAt,
    fetchedAt: requireIsoTimestamp(record.fetchedAt, 'intake record fetchedAt'),
    sourceSummary: requireString(record.sourceSummary, 'intake record sourceSummary'),
    evidenceExcerpt: requireString(
      record.evidenceExcerpt,
      'intake record evidenceExcerpt',
    ),
    eventKey: requireString(record.eventKey, 'intake record eventKey'),
    contentFingerprint: requireString(
      record.contentFingerprint,
      'intake record contentFingerprint',
    ),
    disposition: record.disposition,
    editorialDraft: parseEditorialDraft(record.editorialDraft),
  };
}

function parseDecision(value: unknown): ParsedDecision {
  const decision = requireRecord(value, 'pipeline decision');
  if (decision.riskLevel !== 'low'
    && decision.riskLevel !== 'medium'
    && decision.riskLevel !== 'high') {
    throw new Error('pipeline decision riskLevel is invalid');
  }
  if (decision.disposition !== 'manual_review'
    && decision.disposition !== 'rejected'
    && decision.disposition !== 'duplicate'
    && decision.disposition !== 'auto_ready') {
    throw new Error('pipeline decision disposition is invalid');
  }
  return {
    itemId: requireString(decision.itemId, 'pipeline decision itemId'),
    riskLevel: decision.riskLevel,
    disposition: decision.disposition,
    reasons: requireStringArray(decision.reasons, 'pipeline decision reasons'),
  };
}

function parseReport(value: unknown): ParsedReport {
  const report = requireRecord(value, 'SAAS-605 report');
  if (report.task !== 'SAAS-605') throw new Error('report task must be SAAS-605');
  const controls = requireRecord(report.controls, 'report controls');
  if (controls.autoPublishingEnabled !== false || controls.stopSwitchEngaged !== true) {
    throw new Error(
      'SAAS-606 requires automatic publishing disabled and the stop switch engaged',
    );
  }
  const stats = requireRecord(report.stats, 'report stats');
  const scans = requireArray(report.scans, 'report scans');
  const failures = requireArray(report.failures, 'report failures');
  const records: ParsedIntakeRecord[] = [];
  const decisions: ParsedDecision[] = [];

  scans.forEach((scanValue, scanIndex) => {
    const scan = requireRecord(scanValue, `report scans[${scanIndex}]`);
    const sourceName = requireString(
      scan.channelTitle ?? scan.sourceId,
      `report scans[${scanIndex}].channelTitle`,
    );
    records.push(...requireArray(
      scan.records,
      `report scans[${scanIndex}].records`,
    ).map((record) => parseIntakeRecord(record, sourceName)));
    const governance = requireRecord(
      scan.governance,
      `report scans[${scanIndex}].governance`,
    );
    const autoReady = requireNonNegativeInteger(
      governance.autoReady,
      `report scans[${scanIndex}].governance.autoReady`,
    );
    const parsedDecisions = requireArray(
      governance.decisions,
      `report scans[${scanIndex}].governance.decisions`,
    ).map(parseDecision);
    if (autoReady > 0
      || parsedDecisions.some((decision) => decision.disposition === 'auto_ready')) {
      throw new Error('SAAS-606 does not accept auto-ready candidates');
    }
    decisions.push(...parsedDecisions);
  });

  const nonDuplicateRecordIds = records
    .filter((record) => record.disposition !== 'duplicate')
    .map((record) => record.candidateId);
  if (new Set(nonDuplicateRecordIds).size !== nonDuplicateRecordIds.length) {
    throw new Error('report contains duplicate non-duplicate intake candidate IDs');
  }
  const decisionIds = decisions.map((decision) => decision.itemId);
  if (new Set(decisionIds).size !== decisionIds.length) {
    throw new Error('report contains duplicate pipeline decision IDs');
  }
  const recordIds = new Set(records.map((record) => record.candidateId));
  if (decisions.some((decision) => !recordIds.has(decision.itemId))) {
    throw new Error('pipeline decision is missing its intake record');
  }
  const sourcesConfigured = requireNonNegativeInteger(
    stats.sourcesConfigured,
    'report stats.sourcesConfigured',
  );
  const sourcesSucceeded = requireNonNegativeInteger(
    stats.sourcesSucceeded,
    'report stats.sourcesSucceeded',
  );
  const sourcesFailed = requireNonNegativeInteger(
    stats.sourcesFailed,
    'report stats.sourcesFailed',
  );
  if (sourcesConfigured !== scans.length + failures.length
    || sourcesSucceeded !== scans.length
    || sourcesFailed !== failures.length) {
    throw new Error('report source totals are inconsistent');
  }

  return {
    fetchedAt: requireIsoTimestamp(report.fetchedAt, 'report fetchedAt'),
    sourcesConfigured,
    sourcesFailed: failures.length,
    sourcesScanned: scans.length,
    records,
    decisions,
  };
}

function parseReviewCandidate(value: unknown): DailyReviewCandidate {
  const candidate = requireRecord(value, 'existing review candidate');
  if (candidate.riskLevel !== 'low'
    && candidate.riskLevel !== 'medium'
    && candidate.riskLevel !== 'high') {
    throw new Error('existing review candidate riskLevel is invalid');
  }
  if (candidate.reviewState !== 'pending_owner_review'
    || candidate.publicationState !== 'not_published') {
    throw new Error('existing review candidate must remain pending and unpublished');
  }
  const canonicalUrl = requireSafeHttpsUrl(
    candidate.canonicalUrl,
    'existing review candidate canonicalUrl',
  );
  const editorialDraft = parseEditorialDraft(candidate.editorialDraft);
  if (!editorialDraft) throw new Error('existing review candidate editorialDraft is required');
  return {
    candidateId: requireString(
      candidate.candidateId,
      'existing review candidate candidateId',
    ),
    sourceId: requireString(candidate.sourceId, 'existing review candidate sourceId'),
    sourceName: requireString(candidate.sourceName, 'existing review candidate sourceName'),
    originalTitle: requireString(
      candidate.originalTitle,
      'existing review candidate originalTitle',
    ),
    canonicalUrl,
    publishedAt: requireIsoTimestamp(
      candidate.publishedAt,
      'existing review candidate publishedAt',
    ),
    fetchedAt: requireIsoTimestamp(
      candidate.fetchedAt,
      'existing review candidate fetchedAt',
    ),
    sourceSummary: requireString(
      candidate.sourceSummary,
      'existing review candidate sourceSummary',
    ),
    evidenceExcerpt: requireString(
      candidate.evidenceExcerpt,
      'existing review candidate evidenceExcerpt',
    ),
    eventKey: requireString(candidate.eventKey, 'existing review candidate eventKey'),
    contentFingerprint: requireString(
      candidate.contentFingerprint,
      'existing review candidate contentFingerprint',
    ),
    riskLevel: candidate.riskLevel,
    riskReasons: requireStringArray(
      candidate.riskReasons,
      'existing review candidate riskReasons',
    ),
    editorialDraft,
    reviewState: 'pending_owner_review',
    publicationState: 'not_published',
  };
}

function parseExistingManifest(
  value: unknown,
  context: DailyReviewContext,
): DailyReviewManifest | undefined {
  if (value === undefined) return undefined;
  const manifest = requireRecord(value, 'existing review manifest');
  if (manifest.schemaVersion !== 1 || manifest.task !== 'SAAS-606') {
    throw new Error('existing review manifest schema is invalid');
  }
  if (manifest.editorialDate !== context.editorialDate) {
    throw new Error('existing review manifest date does not match the branch date');
  }
  if (manifest.reviewState !== 'pending_owner_review'
    || manifest.publicationState !== 'not_published') {
    throw new Error('existing review manifest must remain pending and unpublished');
  }
  const controls = requireRecord(manifest.controls, 'existing review manifest controls');
  if (controls.autoPublishingEnabled !== false || controls.stopSwitchEngaged !== true) {
    throw new Error('existing review manifest publication controls are unsafe');
  }
  const candidates = requireArray(
    manifest.candidates,
    'existing review manifest candidates',
  ).map(parseReviewCandidate);
  if (uniqueIds(candidates.map((candidate) => candidate.candidateId)).length
    !== candidates.length) {
    throw new Error('existing review manifest contains duplicate candidate IDs');
  }
  return {
    schemaVersion: 1,
    task: 'SAAS-606',
    editorialDate: context.editorialDate,
    generatedAt: requireIsoTimestamp(
      manifest.generatedAt,
      'existing review manifest generatedAt',
    ),
    reviewState: 'pending_owner_review',
    publicationState: 'not_published',
    controls: {
      autoPublishingEnabled: false,
      stopSwitchEngaged: true,
    },
    candidates,
  };
}

function parseSummary(value: unknown): DailyReviewSummary {
  const summary = requireRecord(value, 'existing ledger summary');
  return {
    sourcesConfigured: requireNonNegativeInteger(
      summary.sourcesConfigured,
      'existing ledger summary sourcesConfigured',
    ),
    sourcesScanned: requireNonNegativeInteger(
      summary.sourcesScanned,
      'existing ledger summary sourcesScanned',
    ),
    sourcesFailed: requireNonNegativeInteger(
      summary.sourcesFailed,
      'existing ledger summary sourcesFailed',
    ),
    newDiscoveries: requireNonNegativeInteger(
      summary.newDiscoveries,
      'existing ledger summary newDiscoveries',
    ),
    duplicates: requireNonNegativeInteger(
      summary.duplicates,
      'existing ledger summary duplicates',
    ),
    rejected: requireNonNegativeInteger(
      summary.rejected,
      'existing ledger summary rejected',
    ),
    manualReview: requireNonNegativeInteger(
      summary.manualReview,
      'existing ledger summary manualReview',
    ),
    proposed: requireNonNegativeInteger(
      summary.proposed,
      'existing ledger summary proposed',
    ),
  };
}

function parseExistingLedger(
  value: unknown,
  context: DailyReviewContext,
): DailyReviewLedger | undefined {
  if (value === undefined) return undefined;
  const ledger = requireRecord(value, 'existing discovery ledger');
  if (ledger.schemaVersion !== 1 || ledger.task !== 'SAAS-606') {
    throw new Error('existing discovery ledger schema is invalid');
  }
  if (ledger.editorialDate !== context.editorialDate) {
    throw new Error('existing discovery ledger date does not match the branch date');
  }
  const seenCandidateIds = uniqueIds(requireStringArray(
    ledger.seenCandidateIds,
    'existing discovery ledger seenCandidateIds',
  ));
  const runs = requireArray(ledger.runs, 'existing discovery ledger runs')
    .map((runValue) => {
      const run = requireRecord(runValue, 'existing discovery ledger run');
      return {
        fetchedAt: requireIsoTimestamp(
          run.fetchedAt,
          'existing discovery ledger run fetchedAt',
        ),
        summary: parseSummary(run.summary),
      };
    });
  if (uniqueIds(runs.map((run) => run.fetchedAt)).length !== runs.length) {
    throw new Error('existing discovery ledger contains duplicate runs');
  }
  return {
    schemaVersion: 1,
    task: 'SAAS-606',
    editorialDate: context.editorialDate,
    seenCandidateIds,
    runs,
  };
}

function uniqueIds(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function proposedCandidate(
  record: ParsedIntakeRecord,
  decision: ParsedDecision,
): DailyReviewCandidate {
  const canonicalUrl = requireSafeHttpsUrl(
    record.canonicalUrl,
    'proposed candidate URL',
  );
  if (!record.publishedAt) {
    throw new Error('proposed candidate publishedAt is required');
  }
  if (!record.editorialDraft) {
    throw new Error('proposed candidate editorialDraft is required');
  }
  return {
    candidateId: record.candidateId,
    sourceId: record.sourceId,
    sourceName: record.sourceName,
    originalTitle: record.originalTitle,
    canonicalUrl,
    publishedAt: record.publishedAt,
    fetchedAt: record.fetchedAt,
    sourceSummary: record.sourceSummary,
    evidenceExcerpt: record.evidenceExcerpt,
    eventKey: record.eventKey,
    contentFingerprint: record.contentFingerprint,
    riskLevel: decision.riskLevel,
    riskReasons: decision.reasons,
    editorialDraft: record.editorialDraft,
    reviewState: 'pending_owner_review',
    publicationState: 'not_published',
  };
}

function markdownText(value: string, maximum: number) {
  const bounded = value.replace(/\s+/g, ' ').trim().slice(0, maximum);
  return bounded
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~])/g, '\\$1');
}

function renderPrBody(
  context: DailyReviewContext,
  summary: DailyReviewSummary,
  manifest: DailyReviewManifest,
) {
  const lines = [
    `# ${context.prTitle}`,
    '',
    '> 这是 GitHub Draft PR 人工审核队列。AI 只生成候选文案；风险、审核和发布状态不由 AI 决定。',
    '> SAAS-606 不会修改正式公开集合，也不会触发生产部署。',
    ...(context.mode === 'fixture'
      ? ['> **fixture 验收：** 本 PR 只用于流程验收，base 必须是 SAAS-606 功能分支。']
      : []),
    '',
    '## 扫描摘要',
    '',
    '| 指标 | 数量 |',
    '|---|---:|',
    `| 扫描来源数 | ${summary.sourcesScanned} / ${summary.sourcesConfigured} |`,
    `| 失败来源数 | ${summary.sourcesFailed} |`,
    `| 新发现数 | ${summary.newDiscoveries} |`,
    `| 重复数 | ${summary.duplicates} |`,
    `| 拒绝数 | ${summary.rejected} |`,
    `| manual_review 数 | ${summary.manualReview} |`,
    `| 拟发布条目数 | ${summary.proposed} |`,
    '',
    '## 项目所有者审核方式',
    '',
    `1. 打开 \`${context.manifestPath}\`，逐条核对原文、候选摘要和风险提示。`,
    '2. 不合格条目请删除 `review-manifest.json` 中对应的完整对象；发现 ledger 保留该 ID，后续同日运行不会把它重新加回。',
    '3. 保留条目仍是 `pending_owner_review / not_published`。本 Draft PR 不能代表批准或发布。',
    '',
    '## 拟发布条目',
    '',
  ];
  if (manifest.candidates.length === 0) {
    lines.push('本次没有拟发布条目。');
  } else {
    manifest.candidates.forEach((candidate) => {
      const reasons = candidate.riskReasons
        .slice(0, 3)
        .map((reason) => markdownText(reason, 160))
        .join('；');
      lines.push(
        `- [ ] **${markdownText(candidate.candidateId, 80)}** · **${markdownText(candidate.editorialDraft.titleZh, 180)}**`,
        `  - 原文：[${markdownText(candidate.sourceName, 120)}](<${candidate.canonicalUrl}>) · ${candidate.publishedAt.slice(0, 10)}`,
        `  - 风险：\`${candidate.riskLevel}\` · ${reasons}`,
        `  - 候选摘要：${markdownText(candidate.editorialDraft.summaryZh, 240)}`,
        `  - 文案模式：\`${candidate.editorialDraft.mode}\`；审核状态：\`pending_owner_review\`；发布状态：\`not_published\``,
        '',
      );
    });
  }
  lines.push(
    '## 风险提示',
    '',
    '- 原文链接、日期、公司自述和数字口径必须由项目所有者核验。',
    '- `medium` / `high` 风险候选不得因为工作流成功而自动公开。',
    '- 删除候选只影响本 Draft PR，不删除 discovery ledger 的审计记录。',
    '',
  );
  const body = lines.join('\n');
  if (body.length >= 60_000) throw new Error('Draft PR body exceeds the safe size limit');
  return body;
}

export function resolveDraftPrAction(value: readonly unknown[]): DraftPrAction {
  if (value.length === 0) return { action: 'create' };
  if (value.length !== 1) {
    throw new Error('multiple review PRs match the same head and base');
  }
  const pr = requireRecord(value[0], 'review PR');
  const number = requireNonNegativeInteger(pr.number, 'review PR number');
  const url = requireString(pr.url, 'review PR URL');
  if (!url.startsWith('https://github.com/')) throw new Error('review PR URL is invalid');
  if (pr.state === 'OPEN') {
    if (pr.isDraft !== true) throw new Error('existing review PR is no longer a Draft');
    return { action: 'update', number, url };
  }
  if (pr.state === 'CLOSED' || pr.state === 'MERGED') {
    return { action: 'skip_closed', number, url };
  }
  throw new Error('review PR state is invalid');
}

function topLevelBlock(workflow: string, key: string) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start < 0) return [];
  const block: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line && !/^\s/.test(line)) break;
    block.push(line);
  }
  return block;
}

export function validateDailyIntakeWorkflow(workflow: string) {
  if (/^\s*pull_request_target\s*:/m.test(workflow)) {
    throw new Error('pull_request_target is forbidden');
  }
  if (!/^\s{2}workflow_dispatch\s*:/m.test(workflow)) {
    throw new Error('workflow_dispatch is required');
  }
  const schedules = [...workflow.matchAll(
    /^\s*-\s*cron:\s*['"]([^'"]+)['"]\s*$/gm,
  )].map((match) => match[1]);
  const expectedSchedules = ['30 23 * * *', '30 8 * * *'];
  if (schedules.length !== expectedSchedules.length
    || expectedSchedules.some((schedule) => !schedules.includes(schedule))) {
    throw new Error('workflow schedules must represent Beijing 07:30 and 16:30');
  }
  if (!/^\s{2}review:\s*\n\s{4}if:\s*github\.event_name != 'schedule' \|\| vars\.STEPHEN_DAILY_SCHEDULE_ENABLED == '1'\s*\n\s{4}runs-on:/m
    .test(workflow)) {
    throw new Error('scheduled production runs must require explicit opt-in');
  }
  const runners = [...workflow.matchAll(/^\s*runs-on:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  if (runners.length !== 1 || runners[0] !== 'ubuntu-latest') {
    throw new Error('workflow runner must be ubuntu-latest');
  }
  const permissionEntries = topLevelBlock(workflow, 'permissions')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const expectedPermissions = ['contents: write', 'pull-requests: write'];
  if (permissionEntries.length !== expectedPermissions.length
    || expectedPermissions.some((entry) => !permissionEntries.includes(entry))) {
    throw new Error('workflow permissions must be minimal');
  }
  if (!/^concurrency:\s*$/m.test(workflow)
    || !/^\s+group:\s*stephen-daily-candidate-review\s*$/m.test(workflow)
    || !/^\s+cancel-in-progress:\s*false\s*$/m.test(workflow)) {
    throw new Error('workflow must serialize daily candidate runs');
  }
  if (!/^\s+timeout-minutes:\s*(?:[1-9]|[1-5][0-9]|60)\s*$/m.test(workflow)) {
    throw new Error('workflow timeout must be between 1 and 60 minutes');
  }
  const actions = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)]
    .map((match) => match[1]);
  if (actions.length !== 2
    || !actions.includes('actions/checkout@v4')
    || !actions.includes('actions/setup-node@v4')) {
    throw new Error('workflow may only use checkout and setup-node actions');
  }
  for (const name of [
    'EDITORIAL_AI_BASE_URL',
    'EDITORIAL_AI_MODEL',
    'EDITORIAL_AI_API_KEY',
  ]) {
    const secretPattern = new RegExp(
      `${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`,
    );
    if (!secretPattern.test(workflow)
      || new RegExp(`inputs\\.${name}`).test(workflow)) {
      throw new Error('editorial AI configuration must come from GitHub Secrets');
    }
    const secretExpansion = new RegExp(
      `(?:echo|printf)[^\\n]*\\$\\{?${name}\\}?`,
    );
    if (secretExpansion.test(workflow)) {
      throw new Error('workflow commands must not print secrets');
    }
  }
  if (/^\s*(?:env|printenv)(?:\s|$)/m.test(workflow)
    || /\bset\s+(?:-x|-o\s+xtrace)\b/.test(workflow)) {
    throw new Error('workflow commands must not print secrets');
  }
  for (const command of [
    'npm ci --install-links',
    'npx tsc --noEmit -p stephen/tsconfig.json',
    'npx tsc --noEmit -p stephen/tsconfig.editorial.json',
    'npx vitest run --root stephen',
    'npm run build:stephen',
  ]) {
    if (!workflow.includes(command)) {
      throw new Error(`workflow validation command is missing: ${command}`);
    }
  }
  if (!workflow.includes('gh pr create --draft')) {
    throw new Error('workflow must create a Draft PR');
  }
  if (!workflow.includes('gh pr edit')) {
    throw new Error('workflow must update the existing Draft PR');
  }
  if (!workflow.includes(
    "if: steps.pr_state.outputs.action == 'create' && steps.generate.outputs.proposed_count != '0'",
  )) {
    throw new Error('workflow must not create an empty Draft PR');
  }
  if (!workflow.includes(
    'if ! node --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts > "$RUNNER_TEMP/saas-605-report.json"; then',
  )) {
    throw new Error('workflow must preserve bounded partial source reports');
  }
  if (!workflow.includes(
    'git add -- ":(top)$MANIFEST_PATH" ":(top)$LEDGER_PATH"',
  )) {
    throw new Error('workflow must stage candidate files from the repository root');
  }
  if (!workflow.includes(
    'git diff --name-only -z "origin/$TARGET_BASE...origin/$CANDIDATE_BRANCH"',
  ) || !workflow.includes(
    '"$changed_path" != "$allowed_manifest" && "$changed_path" != "$allowed_ledger"',
  )) {
    throw new Error('candidate branch may only change its review manifest and ledger');
  }
  if (!workflow.includes(
    '"$mode" == "live" && ( "$target_base" != "$DEFAULT_BRANCH" || "$CURRENT_REF" != "$DEFAULT_BRANCH" )',
  )) {
    throw new Error('live mode must run from and target the default branch');
  }
  if (!workflow.includes(
    'git ls-tree "origin/$CANDIDATE_BRANCH" -- "$saas606_allowed_file"',
  ) || !workflow.includes(
    '"$saas606_mode" != "100644" || "$saas606_type" != "blob"',
  )) {
    throw new Error('candidate review files must be regular non-executable blobs');
  }
  if (!/GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/.test(workflow)) {
    throw new Error('workflow must use the repository GITHUB_TOKEN');
  }
  if (/upload-artifact|actions:\s*write|write-all|GH_PAT|PERSONAL_ACCESS_TOKEN/i
    .test(workflow)) {
    throw new Error('workflow permissions must be minimal');
  }
  return {
    schedules,
    runner: runners[0],
    permissions: permissionEntries,
  };
}

export function beijingEditorialDate(instant: Date) {
  if (Number.isNaN(instant.getTime())) throw new Error('instant must be a valid date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  return `${valueByType.get('year')}-${valueByType.get('month')}-${valueByType.get('day')}`;
}

export function dailyReviewContext(input: DailyReviewContextInput): DailyReviewContext {
  requireDateOnly(input.editorialDate);
  if (input.mode !== 'fixture' && input.mode !== 'live') {
    throw new Error('mode must be fixture or live');
  }
  const testMarker = input.mode === 'fixture' ? '-test' : '';
  const titleMarker = input.mode === 'fixture' ? '[TEST]' : '';
  const directory = `app/stephen/review-candidates/${input.editorialDate}`;
  return {
    editorialDate: input.editorialDate,
    mode: input.mode,
    branchName: `codex/stephen-daily${testMarker}-${input.editorialDate}`,
    manifestPath: `${directory}/review-manifest.json`,
    ledgerPath: `${directory}/discovery-ledger.json`,
    prTitle: `${titleMarker}[自我修养] ${input.editorialDate} 每日候选审核`,
  };
}

export function buildDailyReviewArtifacts(
  input: BuildDailyReviewArtifactsInput,
): DailyReviewArtifacts {
  const context = dailyReviewContext(input);
  const report = parseReport(input.report);
  const existingManifest = parseExistingManifest(input.existingManifest, context);
  const existingLedger = parseExistingLedger(input.existingLedger, context);
  if ((existingManifest === undefined) !== (existingLedger === undefined)) {
    throw new Error('existing manifest and ledger must be supplied together');
  }
  const previouslySeen = new Set(existingLedger?.seenCandidateIds ?? []);
  if (existingManifest?.candidates.some(
    (candidate) => !previouslySeen.has(candidate.candidateId),
  )) {
    throw new Error('existing manifest candidate is missing from the discovery ledger');
  }
  const recordById = new Map<string, ParsedIntakeRecord>();
  report.records.forEach((record) => {
    const existing = recordById.get(record.candidateId);
    if (!existing
      || (existing.disposition === 'duplicate' && record.disposition !== 'duplicate')) {
      recordById.set(record.candidateId, record);
    }
  });
  const duplicateIds = uniqueIds(report.records
    .filter((record) => record.disposition === 'duplicate')
    .map((record) => record.candidateId));
  const newIds = uniqueIds(report.records
    .filter((record) => record.disposition !== 'duplicate')
    .map((record) => record.candidateId));
  const rejectedIds = uniqueIds(report.decisions
    .filter((decision) => decision.disposition === 'rejected')
    .map((decision) => decision.itemId));
  const manualReviewIds = uniqueIds([
    ...report.records
      .filter((record) => record.disposition === 'manual_review')
      .map((record) => record.candidateId),
    ...report.decisions
      .filter((decision) => decision.disposition === 'manual_review')
      .map((decision) => decision.itemId),
  ]);
  const latestCandidates = report.decisions
    .filter((decision) => decision.disposition === 'manual_review')
    .map((decision) => {
      const record = recordById.get(decision.itemId);
      if (!record || record.disposition === 'duplicate') {
        throw new Error(`manual-review decision is missing intake record: ${decision.itemId}`);
      }
      return proposedCandidate(record, decision);
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const candidatesById = new Map(
    (existingManifest?.candidates ?? [])
      .map((candidate) => [candidate.candidateId, candidate]),
  );
  latestCandidates.forEach((candidate) => {
    if (!previouslySeen.has(candidate.candidateId)) {
      candidatesById.set(candidate.candidateId, candidate);
    }
  });
  const candidates = [...candidatesById.values()]
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const latestSummary: DailyReviewSummary = {
    sourcesConfigured: report.sourcesConfigured,
    sourcesScanned: report.sourcesScanned,
    sourcesFailed: report.sourcesFailed,
    newDiscoveries: newIds.length,
    duplicates: duplicateIds.length,
    rejected: rejectedIds.length,
    manualReview: manualReviewIds.length,
    proposed: candidates.length,
  };
  const summary = latestSummary;
  const manifest: DailyReviewManifest = {
    schemaVersion: 1,
    task: 'SAAS-606',
    editorialDate: input.editorialDate,
    generatedAt: report.fetchedAt,
    reviewState: 'pending_owner_review',
    publicationState: 'not_published',
    controls: {
      autoPublishingEnabled: false,
      stopSwitchEngaged: true,
    },
    candidates,
  };
  const ledger: DailyReviewLedger = {
    schemaVersion: 1,
    task: 'SAAS-606',
    editorialDate: input.editorialDate,
    seenCandidateIds: uniqueIds([
      ...(existingLedger?.seenCandidateIds ?? []),
      ...report.records.map((record) => record.candidateId),
    ]),
    runs: existingLedger?.runs.some((run) => run.fetchedAt === report.fetchedAt)
      ? existingLedger.runs
      : [...(existingLedger?.runs ?? []), { fetchedAt: report.fetchedAt, summary }],
  };
  return {
    context,
    summary,
    manifest,
    ledger,
    prBody: renderPrBody(context, summary, manifest),
  };
}
