import { describe, expect, it } from 'vitest';

import { seedCandidates } from './items';
import { approvedKnowledgeItems } from './publicItems';
import { sourceRegistry, validateSourceRegistry } from './sources';
import { knowledgeTools } from './tools';
import { knowledgeTopics } from './topics';
import { validateSeedCandidates } from './validate';

describe('Stephen source governance', () => {
  it('keeps the first release within ten active, independently identified public sources', () => {
    expect(sourceRegistry).toHaveLength(10);
    expect(sourceRegistry.filter((source) => source.active)).toHaveLength(10);

    const ids = sourceRegistry.map((source) => source.id);
    const homepages = sourceRegistry.map((source) => source.homepage);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(homepages).size).toBe(homepages.length);
    expect(() => validateSourceRegistry(sourceRegistry)).not.toThrow();
  });

  it('rejects unsafe, inactive or full-text redistribution sources', () => {
    const valid = sourceRegistry[0];
    type SourceInput = Parameters<typeof validateSourceRegistry>[0][number];
    const replaceFirst = (replacement: SourceInput) => [
      replacement,
      ...sourceRegistry.slice(1),
    ];

    expect(() => validateSourceRegistry(replaceFirst({ ...valid, homepage: 'http://example.com' })))
      .toThrow('source homepage must use HTTPS');
    expect(() => validateSourceRegistry(replaceFirst({ ...valid, active: false })))
      .toThrow('first-release source must be active');
    expect(() => validateSourceRegistry(replaceFirst({
      ...valid,
      redistributionPolicy: 'full_text_allowed',
    })))
      .toThrow('full-text redistribution is not allowed');
  });
});

describe('SAAS-602 seed review collection', () => {
  it('contains exactly 30 review-only candidates with the approved category mix', () => {
    expect(seedCandidates).toHaveLength(30);
    expect(approvedKnowledgeItems).toEqual([]);
    expect(() => validateSeedCandidates(seedCandidates)).not.toThrow();

    const categoryCounts = Object.fromEntries(
      ['ai_technology', 'enterprise_sales_method', 'ai_role_change', 'org_adoption']
        .map((category) => [
          category,
          seedCandidates.filter((item) => item.seedCategory === category).length,
        ]),
    );
    expect(categoryCounts).toEqual({
      ai_technology: 10,
      enterprise_sales_method: 8,
      ai_role_change: 6,
      org_adoption: 6,
    });

    for (const item of seedCandidates) {
      expect(item.editorialStatus).toBe('candidate');
      expect(item.publicationMode).toBe('manual');
      expect(item.seedContent).toBe(true);
      expect(item.review.status).toBe('pending_owner_review');
      expect(item.title.zh.trim().length).toBeGreaterThan(0);
      expect(item.summary.zh.trim().length).toBeGreaterThan(0);
      expect(item.whyItMatters.zh.trim().length).toBeGreaterThan(0);
      expect(item.salesImplication.zh.trim().length).toBeGreaterThan(0);
      expect(item.roleOrgImplication.zh.trim().length).toBeGreaterThan(0);
      expect(item.nextAction.zh.trim().length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.evidence.every((evidence) =>
        sourceRegistry.some((source) => source.id === evidence.sourceId))).toBe(true);
    }
  });

  it('meets three-domain, cross-domain, action and freshness coverage', () => {
    for (const domain of ['ai_technology', 'enterprise_sales', 'role_org'] as const) {
      expect(seedCandidates.filter((item) => item.domains.includes(domain)).length)
        .toBeGreaterThanOrEqual(10);
    }
    expect(seedCandidates.filter((item) => item.domains.length >= 2).length)
      .toBeGreaterThanOrEqual(12);
    expect(seedCandidates.filter((item) => item.toolIds.length > 0).length)
      .toBeGreaterThanOrEqual(12);
    expect(seedCandidates.filter((item) => item.review.changeWindow === 'within_30_days').length)
      .toBeGreaterThanOrEqual(6);
    expect(seedCandidates.filter((item) =>
      ['within_30_days', 'within_90_days'].includes(item.review.changeWindow)).length)
      .toBeGreaterThanOrEqual(12);
  });

  it('defines six complete cross-domain topics and eight complete action tools', () => {
    expect(knowledgeTopics).toHaveLength(6);
    expect(knowledgeTools).toHaveLength(8);

    const itemIds = new Set(seedCandidates.map((item) => item.id));
    const toolIds = new Set(knowledgeTools.map((tool) => tool.id));
    for (const topic of knowledgeTopics) {
      expect(topic.title.zh.trim().length).toBeGreaterThan(0);
      expect(topic.problemDefinition.zh.trim().length).toBeGreaterThan(0);
      expect(topic.keyChanges.zh.trim().length).toBeGreaterThan(0);
      expect(topic.salesJudgment.zh.trim().length).toBeGreaterThan(0);
      expect(topic.roleOrgImpact.zh.trim().length).toBeGreaterThan(0);
      expect(topic.itemIds.length).toBeGreaterThan(0);
      expect(topic.itemIds.every((id) => itemIds.has(id))).toBe(true);
      expect(topic.toolIds.every((id) => toolIds.has(id))).toBe(true);
    }
    for (const tool of knowledgeTools) {
      expect(tool.title.zh.trim().length).toBeGreaterThan(0);
      expect(tool.scenario.zh.trim().length).toBeGreaterThan(0);
      expect(tool.inputPrompts.length).toBeGreaterThanOrEqual(3);
      expect(tool.templateMarkdown).toContain('# ');
      expect(tool.exampleMarkdown).toContain('# ');
      expect(tool.completionCriteria.length).toBeGreaterThanOrEqual(3);
      expect(tool.outputFormat).toBe('markdown');
    }
  });
});
