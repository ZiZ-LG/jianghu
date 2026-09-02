import { describe, expect, it } from 'vitest';
import {
  matterPortfolioErrorMessage,
  parseMatterPortfolio,
  parseMatterPortfolioSource,
} from './matterPortfolio';
import {
  MATTER_PORTFOLIO_FIXTURE,
  MATTER_PORTFOLIO_SOURCE_REF,
} from '../testFixtures/matterPortfolio';

describe('SAAS-209 Matter portfolio client boundary', () => {
  it('strictly parses the read model without accepting a score or provider extra', () => {
    expect(parseMatterPortfolio(MATTER_PORTFOLIO_FIXTURE)).toEqual(MATTER_PORTFOLIO_FIXTURE);
    expect(() => parseMatterPortfolio({
      ...MATTER_PORTFOLIO_FIXTURE,
      aggregateScore: 91,
    })).toThrow();
    expect(() => parseMatterPortfolio({
      ...MATTER_PORTFOLIO_FIXTURE,
      entries: [{
        ...MATTER_PORTFOLIO_FIXTURE.entries[0],
        attentionItems: [{
          ...MATTER_PORTFOLIO_FIXTURE.entries[0]!.attentionItems[0],
          providerExplanation: 'untrusted extra',
        }],
      }],
    })).toThrow();
    expect(() => parseMatterPortfolio({
      ...MATTER_PORTFOLIO_FIXTURE,
      entries: [{
        ...MATTER_PORTFOLIO_FIXTURE.entries[0],
        methodologyStage: null,
        pipelineStage: 'LEGACY_PIPELINE',
        engageStage: 'LEGACY_ENGAGE',
        primaryDPersonId: 'LEGACY_PRIMARY_D',
        ADURC: 'LEGACY_ADURC',
      }],
    })).toThrow();
    const withoutMethodology = parseMatterPortfolio({
      ...MATTER_PORTFOLIO_FIXTURE,
      entries: [{ ...MATTER_PORTFOLIO_FIXTURE.entries[0], methodologyStage: null }],
    });
    expect(withoutMethodology.entries[0]!.methodologyStage).toBeNull();
    expect(JSON.stringify(withoutMethodology)).not.toContain('LEGACY_');
  });

  it('preserves the exact requested provider, parent and source revision on drill-down', () => {
    const request = {
      providerKey: 'core.today' as const,
      customerId: 'customer-209',
      matterId: 'matter-209',
      sourceRef: MATTER_PORTFOLIO_SOURCE_REF,
    };
    const source = {
      sourceRef: MATTER_PORTFOLIO_SOURCE_REF,
      customerId: request.customerId,
      matterId: request.matterId,
      label: '当前事项',
      detail: '正式事项版本 5',
    };
    expect(parseMatterPortfolioSource(source, request)).toEqual(source);
    expect(() => parseMatterPortfolioSource({ ...source, customerId: 'other-customer' }, request))
      .toThrow('Matter portfolio source parent mismatch');
    expect(() => parseMatterPortfolioSource({
      ...source,
      sourceRef: { ...source.sourceRef, version: 6 },
    }, request)).toThrow('Matter portfolio source revision mismatch');
  });

  it('maps stale and inaccessible source errors without leaking response bodies', () => {
    expect(matterPortfolioErrorMessage({ code: 'matter_portfolio_source_changed' }))
      .toBe('来源已变化，请刷新事项组合后重试。');
    expect(matterPortfolioErrorMessage({ code: 'matter_portfolio_not_found' }))
      .toBe('来源不存在或当前无权查看。');
    expect(matterPortfolioErrorMessage({ code: 'unexpected', message: 'SECRET_BODY' }))
      .toBe('事项组合暂不可用，请稍后重试。');
  });
});
