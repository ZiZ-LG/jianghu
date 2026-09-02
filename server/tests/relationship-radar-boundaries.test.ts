import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');

describe('SAAS-212 relationship radar authority boundaries', () => {
  it('contains no aggregate score, methodology fallback, AI provider, or formal producer write', async () => {
    const [contract, model, rules, handler, commit, service] = await Promise.all([
      read('packages/domain-contracts/src/relationshipRadar.ts'),
      read('server/src/relationshipRadar/model.ts'),
      read('server/src/relationshipRadar/rules.ts'),
      read('server/src/relationshipRadar/handler.ts'),
      read('server/src/relationshipRadar/commit.ts'),
      read('server/src/relationshipRadar/service.ts'),
    ]);
    const runtime = [contract, model, rules, handler, commit, service].join('\n');
    expect(runtime).not.toMatch(/totalScore|aggregateScore|relationshipScore/i);
    expect(runtime).not.toMatch(/primaryDPersonId|engageStage|pipelineStage|customerType|G64111|ADURC/);
    expect(runtime).not.toMatch(/callLLM|loadAiConfig|apiKey|prompt|rawResponse/);
    expect(commit).toContain('relationshipRadarSnapshot.create');
    expect(commit).not.toMatch(/\.(?:account|opportunity|person|edge|evidenceEvent|planAction|stakeholderFocus)\.(?:create|update|delete|upsert)/);
    const databaseMutation = /\bdb\.[a-zA-Z][a-zA-Z0-9]*\.(?:create|update|delete|upsert)\s*\(/;
    expect(handler).not.toMatch(databaseMutation);
    expect(service).not.toMatch(databaseMutation);
  });

  it('keeps the browser draft behind an explicit human submit path', async () => {
    const panel = await read('app/src/components/RelationshipRadarPanel.tsx');
    expect(panel).toContain('打开下一步草稿');
    expect(panel).toContain('提交为正式下一步');
    expect(panel).toContain("source: 'relationship_radar_human_review'");
    expect(panel).not.toMatch(/useEffect\([^)]*api\.commitment/s);
    expect(panel).not.toContain('useMemo');
    expect(panel).not.toContain('[customer, matter]');
    expect(panel).not.toContain('primaryDPersonId');
    expect(panel).not.toContain('pipelineStage');
  });
});
