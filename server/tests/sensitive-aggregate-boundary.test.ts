import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(resolve(process.cwd(), 'src', name), 'utf8');

describe('CORE-204 shared aggregate boundary', () => {
  it('keeps CuratedSummary generation on formal non-sensitive sources', () => {
    const curated = source('curated.ts');
    expect(curated).not.toMatch(/prisma\.(note|transcript|candidate|sourceArtifact|sensitiveResourceGrant)\.(find|aggregate|groupBy)/);
    expect(curated).toContain('prisma.visitNote.findMany');
  });

  it('keeps team and common CRM read models off sensitive repositories', () => {
    for (const file of ['today.ts', 'crmContext.ts']) {
      expect(source(file), file).not.toMatch(/prisma\.(note|transcript|candidate|sourceArtifact|sensitiveResourceGrant)\.(find|aggregate|groupBy)/);
    }
  });

  it('keeps sensitive body reads in serializable ACL snapshots bound to aclVersion', () => {
    for (const file of ['state.ts', 'recording.ts', 'suggest.ts', 'mcpServer.ts', 'jobs.ts']) {
      const content = source(file);
      expect(content, file).toContain('Prisma.TransactionIsolationLevel.Serializable');
      expect(content, file).toContain('aclVersion');
    }
  });

  it('keeps Candidate endpoint names behind metadata ACL checks', () => {
    const scope = source('suggestionScope.ts');
    expect(scope.indexOf('db.candidate.findMany')).toBeLessThan(scope.indexOf('db.personSuggestion.findMany'));
    expect(scope).toContain('createSensitiveAccessEvaluator');
    expect(scope).toContain('authorizeMany');
    expect(scope).toContain('candidateDescriptor');
  });

  it('checks Feishu duplicate ACL before branching on private Transcript status', () => {
    const recording = source('recording.ts');
    const autoPull = recording.slice(
      recording.indexOf('async function pullFeishuAuto'),
      recording.indexOf('async function pullFeishuByToken'),
    );
    expect(autoPull.indexOf("transcriptDescriptor(current), 'manage'"))
      .toBeLessThan(autoPull.indexOf("current.status !== 'active'"));
    expect(autoPull).toContain('runSerializableTransaction(prisma');
  });

  it('keeps Transcript redact and delete authorization with their CAS write in one transaction', () => {
    const recording = source('recording.ts');
    const redact = recording.slice(
      recording.indexOf("app.post('/api/recording/redact'"),
      recording.indexOf("app.delete('/api/recording/transcripts/:id'"),
    );
    const remove = recording.slice(
      recording.indexOf("app.delete('/api/recording/transcripts/:id'"),
      recording.indexOf('// ── 文件上传'),
    );
    for (const section of [redact, remove]) {
      expect(section).toContain('runSerializableTransaction(prisma');
      expect(section).toMatch(/requireTranscriptAccessMetadata\(\s*tx/);
    }
    expect(redact).toContain('tx.transcript.updateMany');
    expect(remove).toContain('tx.transcript.deleteMany');
  });

  it('does not re-resolve deployment policy inside the field proposal producer', () => {
    const proposals = source('proposals.ts');
    expect(proposals).not.toContain('deploymentProductAccess()');
    expect(proposals).toContain('capabilityPolicy?: CapabilityPolicy');
    expect(proposals).toContain('receipt.created && capabilityPolicy');
  });

  it('keeps ResearchBriefSnapshot commit encrypted, serializable, and outside formal CRM writers', () => {
    const service = source('researchBriefs/service.ts');
    expect(service).toContain('Prisma.TransactionIsolationLevel.Serializable');
    expect(service).toContain('resolveEffectiveResourceScope');
    expect(service).toContain('authorizeSensitiveResource');
    expect(service).toContain('payloadEnc: enc(');
    expect(service).toContain('tx.researchBriefSnapshot.create');
    expect(service).toContain('tx.auditEvent.create');
    expect(service).not.toMatch(/tx\.(account|opportunity|person|edge|evidenceEvent|planAction|interaction|candidate|reviewBatch|curatedSummary)\.(create|update|upsert|delete)/);
    expect(service).not.toMatch(/researchBriefSnapshot\.(update|upsert|delete)/);
  });

  it('keeps SAAS-204 ResearchBrief routes read-only and disconnected from providers and Agent runs', () => {
    const routes = source('researchBriefs/routes.ts');
    expect(routes).toContain("app.get('/api/research-briefs'");
    expect(routes).toContain("app.get('/api/research-briefs/:id'");
    expect(routes).not.toMatch(/app\.(post|put|patch|delete)\('/);
    expect(routes).not.toMatch(/callLLM|qcc|feishu|agentRun|AgentRun|fetch\(/i);
  });
});
