// @ts-expect-error Vitest runs in Node; the browser app intentionally does not load global Node typings.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const siteUrl = new URL('../../public/stephen/index.html', import.meta.url);
const nginxUrl = new URL('../../../deploy/stephen.nginx.conf', import.meta.url);

function readRequiredFile(url: URL) {
  const exists = existsSync(url);
  expect(exists, `missing ${url.pathname}`).toBe(true);
  return exists ? readFileSync(url, 'utf8') : '';
}

function extract(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern);
  expect(match, `missing ${label} data block`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Stephen self-cultivation site', () => {
  it('locks the approved SAAS-601 content and product boundaries', async () => {
    const domain = await import('../../stephen/src/domain');

    expect(domain.KNOWLEDGE_PATH_DAYS).toEqual([1, 7, 30, 90]);
    expect(domain.LEGACY_FIELDBOOK_PATH_DAYS).toEqual([3, 7, 14, 30]);
    expect(domain.FIRST_RELEASE_REQUIREMENTS).toEqual({
      knowledgeItems: 30,
      topics: 6,
      tools: 8,
      homepageItems: { min: 3, max: 5 },
      weeklyUpdates: { min: 3, max: 5 },
      fullChineseRequired: true,
      englishBodyRequired: false,
      seedReview: 'manual',
      toolOutputs: ['editable', 'copy', 'markdown_download'],
    });
    expect(domain.INTEGRATION_BOUNDARIES).toEqual({
      crmWrite: false,
      portfolioGenerator: false,
      publicProfile: false,
      cloudToolStorage: false,
    });
  });

  it('publishes only approved Chinese-complete items under the risk gate', async () => {
    const { validateKnowledgeItems } = await import('../../stephen/src/content/validate');
    const validItem = {
      id: 'ai-sales-001',
      slug: 'ai-sales-value-proof',
      title: { zh: 'AI 项目如何证明业务价值' },
      summary: { zh: '从可核验事实走向可执行动作。' },
      kind: 'explainer',
      domains: ['ai_technology', 'enterprise_sales'],
      topicSlugs: ['ai-poc-scale'],
      audience: ['transitioning_seller'],
      publishedAt: '2026-08-23T08:00:00.000Z',
      updatedAt: '2026-08-23T08:00:00.000Z',
      freshness: 'current',
      whyItMatters: { zh: '帮助销售把技术变化翻译成客户价值。' },
      salesImplication: { zh: '应先确认业务指标和决策链。' },
      roleOrgImplication: { zh: '岗位需要同时理解技术与组织采用。' },
      nextAction: { zh: '用 15 分钟写出一条价值假设。' },
      evidence: [{
        id: 'evidence-001',
        sourceId: 'official-source',
        title: 'Official source',
        publisher: 'Example',
        url: 'https://example.com/source',
        publishedAt: '2026-08-22T08:00:00.000Z',
        level: 'official',
        language: 'en',
        allowlisted: true,
      }],
      relatedItemIds: [],
      editorialStatus: 'approved',
      riskLevel: 'low',
      publicationMode: 'manual',
      seedContent: true,
      audit: {
        sourceFingerprint: 'sha256:example',
        ruleVersion: 'saas-601-v1',
        processedAt: '2026-08-23T08:05:00.000Z',
        releaseVersion: 'seed-v1',
        rollbackState: 'available',
      },
    } as const;

    expect(() => validateKnowledgeItems([validItem])).not.toThrow();
    expect(() => validateKnowledgeItems([{ ...validItem, domains: [] }]))
      .toThrow('domains must not be empty');
    expect(() => validateKnowledgeItems([{ ...validItem, evidence: [] }]))
      .toThrow('evidence must not be empty');
    expect(() => validateKnowledgeItems([{ ...validItem, editorialStatus: 'candidate' }]))
      .toThrow('public collection contains non-approved item');
    expect(() => validateKnowledgeItems([{ ...validItem, title: { zh: '' } }]))
      .toThrow('Chinese content is required');
    expect(() => validateKnowledgeItems([{ ...validItem, title: { zh: '中文完整' } }]))
      .not.toThrow();
    expect(() => validateKnowledgeItems([{ ...validItem,
      publicationMode: 'allowlisted_low_risk_auto' }]))
      .toThrow('seed content requires manual approval');
    expect(() => validateKnowledgeItems([{ ...validItem,
      seedContent: false,
      riskLevel: 'medium',
      publicationMode: 'allowlisted_low_risk_auto' }]))
      .toThrow('automatic publication requires low risk');
    expect(() => validateKnowledgeItems([{ ...validItem,
      seedContent: false,
      publicationMode: 'allowlisted_low_risk_auto',
      evidence: [{ ...validItem.evidence[0], allowlisted: false }] }]))
      .toThrow('automatic publication requires allowlisted evidence');
    expect(() => validateKnowledgeItems([{ ...validItem,
      seedContent: false,
      publicationMode: 'allowlisted_low_risk_auto' }]))
      .not.toThrow();
  });

  it('preserves the complete source curriculum and interactive fieldbook', () => {
    const html = readRequiredFile(siteUrl);
    const syllabus = extract(html, /const syllabus = \[(.*?)\n\s*\];\n\n\s*const glossary/s, 'syllabus');
    const glossary = extract(html, /const glossary = \[(.*?)\n\s*\];\n\n\s*const plans/s, 'glossary');
    const plans = extract(html, /const plans = \{(.*?)\n\s*\};\n\n\s*const questions/s, 'plans');
    const questions = extract(html, /const questions = \[(.*?)\n\s*\];\n\n\s*function loadState/s, 'questions');

    expect(syllabus.match(/\bcode: "M\d{2}"/g)).toHaveLength(8);
    expect(glossary.match(/^\s*\["/gm)).toHaveLength(32);
    expect(plans.match(/\bid: "(?:3|7|14|30)-\d+"/g)).toHaveLength(45);
    expect(questions.match(/\bid: "S\d{2}"/g)).toHaveLength(22);
    expect(questions.match(/\bid: "M\d{2}"/g)).toHaveLength(6);

    for (const sectionId of [
      'definition',
      'profile',
      'literacy',
      'preparation',
      'answering',
      'questions',
      'interview-day',
      'future',
      'sources',
    ]) {
      expect(html).toContain(`id="${sectionId}"`);
    }

    expect(html).toContain('id="glossarySearch"');
    expect(html).toContain('id="nextQuestion"');
    expect(html).toContain('id="themeToggle"');
    expect(html).toContain('id="printButton"');
    expect(html).toContain('ai-sales-interview-fieldbook-v2');
  });

  it('connects the fieldbook to the Jianghu ecosystem and filing identity', () => {
    const html = readRequiredFile(siteUrl);

    expect(html).toContain('href="https://lake2ocean.top"');
    expect(html).toContain('href="https://crm.lake2ocean.top"');
    expect(html).toContain('href="https://beian.miit.gov.cn/"');
    expect(html).toContain('京ICP备2026046195号-2');
    expect(html).toContain('自在创造（北京）智慧科技有限公司');
    expect(html).toContain('<link rel="canonical" href="https://stephen.lake2ocean.top/">');
  });

  it('defines an isolated HTTPS static host with no API surface', () => {
    const nginx = readRequiredFile(nginxUrl);

    expect(nginx).toContain('server_name stephen.lake2ocean.top;');
    expect(nginx).toContain('return 301 https://stephen.lake2ocean.top$request_uri;');
    expect(nginx).toContain('/etc/letsencrypt/live/stephen.lake2ocean.top/fullchain.pem');
    expect(nginx).toContain('root /usr/share/nginx/jianghu/stephen;');
    expect(nginx).toMatch(/location \^~ \/api\/\s*\{\s*return 404;/);
  });
});
