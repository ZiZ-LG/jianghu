import {
  MatterPortfolioReadModelSchema,
  MatterPortfolioSourceRequestSchema,
  TodaySourceViewSchema,
  type MatterPortfolioReadModel,
  type MatterPortfolioSourceRequest,
  type TodaySourceView,
} from '@jianghu/domain-contracts';

export function parseMatterPortfolio(raw: unknown): MatterPortfolioReadModel {
  return MatterPortfolioReadModelSchema.parse(raw);
}

export function parseMatterPortfolioSource(
  raw: unknown,
  expected: MatterPortfolioSourceRequest,
): TodaySourceView {
  const request = MatterPortfolioSourceRequestSchema.parse(expected);
  const source = TodaySourceViewSchema.parse(raw);
  if (source.customerId !== request.customerId || source.matterId !== request.matterId) {
    throw new Error('Matter portfolio source parent mismatch');
  }
  const actual = source.sourceRef;
  const wanted = request.sourceRef;
  if (actual.entityKind !== wanted.entityKind
    || actual.entityId !== wanted.entityId
    || actual.version !== wanted.version
    || actual.scheduleVersion !== wanted.scheduleVersion) {
    throw new Error('Matter portfolio source revision mismatch');
  }
  return source;
}

export function matterPortfolioErrorMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? Reflect.get(error, 'code')
    : null;
  if (code === 'matter_portfolio_source_changed') {
    return '来源已变化，请刷新事项组合后重试。';
  }
  if (code === 'matter_portfolio_not_found') {
    return '来源不存在或当前无权查看。';
  }
  return '事项组合暂不可用，请稍后重试。';
}
