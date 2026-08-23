import { describe, expect, it } from 'vitest';

import { seedCandidates } from './content/items';
import { knowledgeTopics } from './content/topics';
import {
  desktopNavigation,
  filterKnowledgeItems,
  getKnowledgeItemBySlug,
  getKnowledgeTopicBySlug,
  mobileNavigation,
  parseRoute,
  selectTodayItems,
  toKnowledgeCardModel,
} from './navigation';

describe('SAAS-602 Stephen navigation and selection', () => {
  it('parses every stable first-release path and returns an internal 404 for unknown paths', () => {
    expect(parseRoute('/')).toEqual({ name: 'today' });
    expect(parseRoute('/radar')).toEqual({ name: 'radar' });
    expect(parseRoute('/topics/')).toEqual({ name: 'topics' });
    expect(parseRoute('/topics/ai-poc-scale/')).toEqual({ name: 'topic', slug: 'ai-poc-scale' });
    expect(parseRoute('/tools/')).toEqual({ name: 'tools' });
    expect(parseRoute('/roles/')).toEqual({ name: 'roles' });
    expect(parseRoute('/learn/')).toEqual({ name: 'learn' });
    expect(parseRoute('/library/')).toEqual({ name: 'library' });
    expect(parseRoute('/digest/')).toEqual({ name: 'digest' });
    expect(parseRoute('/items/frontier-model-price-performance/')).toEqual({
      name: 'item',
      slug: 'frontier-model-price-performance',
    });
    expect(parseRoute('/does-not-exist/')).toEqual({ name: 'not_found' });
  });

  it('keeps four primary destinations on both desktop and mobile', () => {
    expect(desktopNavigation.map((item) => item.href)).toEqual([
      '/', '/radar/', '/tools/', '/library/',
    ]);
    expect(mobileNavigation.map((item) => item.href)).toEqual([
      '/', '/radar/', '/tools/', '/library/',
    ]);
  });

  it('selects at most five high-value items without padding and never publishes candidates by default', () => {
    expect(selectTodayItems(seedCandidates)).toEqual([]);

    const reviewSelection = selectTodayItems(seedCandidates, {
      includeCandidates: true,
      limit: 5,
    });
    expect(reviewSelection).toHaveLength(5);
    expect(reviewSelection.every((item) => item.editorialStatus === 'candidate')).toBe(true);

    const onlyTwo = selectTodayItems(seedCandidates.slice(0, 2), {
      includeCandidates: true,
      limit: 5,
    });
    expect(onlyTwo).toHaveLength(2);
  });

  it('supports explicit AND and OR domain filters', () => {
    const andResult = filterKnowledgeItems(seedCandidates, {
      domains: ['ai_technology', 'enterprise_sales'],
      mode: 'and',
    });
    expect(andResult.length).toBeGreaterThan(0);
    expect(andResult.every((item) =>
      item.domains.includes('ai_technology') && item.domains.includes('enterprise_sales')))
      .toBe(true);

    const orResult = filterKnowledgeItems(seedCandidates, {
      domains: ['ai_technology', 'role_org'],
      mode: 'or',
    });
    expect(orResult.length).toBeGreaterThan(andResult.length);
    expect(orResult.every((item) =>
      item.domains.includes('ai_technology') || item.domains.includes('role_org')))
      .toBe(true);
  });

  it('resolves known content and topics while missing slugs remain not found', () => {
    expect(getKnowledgeItemBySlug(seedCandidates, 'frontier-model-price-performance')?.id)
      .toBe('ST-001');
    expect(getKnowledgeItemBySlug(seedCandidates, 'missing-item')).toBeNull();
    expect(getKnowledgeTopicBySlug(knowledgeTopics, 'ai-poc-scale')?.slug)
      .toBe('ai-poc-scale');
    expect(getKnowledgeTopicBySlug(knowledgeTopics, 'missing-topic')).toBeNull();
  });

  it('builds card data with why-it-matters, action and traceable evidence', () => {
    const card = toKnowledgeCardModel(seedCandidates[0]);
    expect(card.whyItMatters.zh.trim().length).toBeGreaterThan(0);
    expect(card.nextAction.zh.trim().length).toBeGreaterThan(0);
    expect(card.evidenceHref).toMatch(/^https:\/\//);
    expect(card.itemHref).toBe('/items/frontier-model-price-performance/');
  });
});
