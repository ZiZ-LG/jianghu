export type SourceKind =
  | 'official_product_news'
  | 'official_engineering_blog'
  | 'official_careers'
  | 'government_policy'
  | 'original_research'
  | 'corporate_research';

export type SourceAuthority =
  | 'vendor_official'
  | 'government_official'
  | 'academic_primary'
  | 'company_primary_research';

export type SourceCadence = 'twice_daily' | 'daily' | 'weekly' | 'quarterly';

export type SourceAutomaticEligibility =
  | 'eligible_low_risk_facts'
  | 'manual_review_only';

export interface SourceRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly homepage: string;
  readonly kind: SourceKind;
  readonly authority: SourceAuthority;
  readonly language: 'en' | 'multilingual';
  readonly cadence: SourceCadence;
  readonly redistributionPolicy: 'metadata_short_summary_link_only';
  readonly automaticEligibility: SourceAutomaticEligibility;
  readonly active: true;
  readonly lastVerifiedAt: string;
  readonly notes: string;
}

interface SourceRegistryInput {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly homepage?: unknown;
  readonly redistributionPolicy?: unknown;
  readonly active?: unknown;
  readonly lastVerifiedAt?: unknown;
}

export const sourceRegistry = [
  {
    id: 'openai-news-rss',
    name: 'OpenAI News RSS',
    homepage: 'https://openai.com/news/rss.xml',
    kind: 'official_product_news',
    authority: 'vendor_official',
    language: 'en',
    cadence: 'twice_daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    active: true,
    lastVerifiedAt: '2026-08-23T17:33:08.000Z',
    notes: '仅登记官方标题、日期、链接与自有短摘要；公司案例中的效果数字按企业自述标识。',
  },
  {
    id: 'anthropic-news',
    name: 'Anthropic Newsroom',
    homepage: 'https://www.anthropic.com/news',
    kind: 'official_product_news',
    authority: 'vendor_official',
    language: 'en',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    active: true,
    lastVerifiedAt: '2026-08-23T17:40:00.000Z',
    notes: '产品、公司与经济研究公告分开标注；不把厂商主张写成独立验证事实。',
  },
  {
    id: 'google-cloud-ai-blog',
    name: 'Google Cloud AI & Machine Learning Blog',
    homepage: 'https://cloud.google.com/blog/products/ai-machine-learning',
    kind: 'official_engineering_blog',
    authority: 'vendor_official',
    language: 'en',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    active: true,
    lastVerifiedAt: '2026-08-23T17:42:00.000Z',
    notes: '只自动处理官方产品和工程事实；客户案例、效果与方法建议进入人工复核。',
  },
  {
    id: 'aws-ai-blog-rss',
    name: 'AWS Artificial Intelligence Blog RSS',
    homepage: 'https://aws.amazon.com/blogs/machine-learning/feed/',
    kind: 'official_engineering_blog',
    authority: 'vendor_official',
    language: 'en',
    cadence: 'twice_daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    active: true,
    lastVerifiedAt: '2026-08-23T17:50:00.000Z',
    notes: 'RSS 只用于候选发现；架构建议、示例指标与合规表述必须保留 AWS 自述属性。',
  },
  {
    id: 'microsoft-worklab',
    name: 'Microsoft WorkLab',
    homepage: 'https://www.microsoft.com/en-us/worklab/',
    kind: 'corporate_research',
    authority: 'company_primary_research',
    language: 'en',
    cadence: 'weekly',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:44:00.000Z',
    notes: '组织与工作趋势内容必须标为 Microsoft 研究或企业案例，不自动外推为普遍结论。',
  },
  {
    id: 'anthropic-careers',
    name: 'Anthropic Careers',
    homepage: 'https://www.anthropic.com/careers/jobs',
    kind: 'official_careers',
    authority: 'vendor_official',
    language: 'en',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:48:00.000Z',
    notes: '岗位存在性可作为官方事实；能力趋势属于编辑归纳，必须注明核验日期。',
  },
  {
    id: 'nist-ai-rmf',
    name: 'NIST AI Risk Management Framework',
    homepage: 'https://www.nist.gov/itl/ai-risk-management-framework',
    kind: 'government_policy',
    authority: 'government_official',
    language: 'en',
    cadence: 'weekly',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:45:00.000Z',
    notes: '框架为自愿使用；不得改写为对所有企业强制适用的法律结论。',
  },
  {
    id: 'eu-ai-act',
    name: 'European Commission AI Act Portal',
    homepage: 'https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai',
    kind: 'government_policy',
    authority: 'government_official',
    language: 'multilingual',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:46:00.000Z',
    notes: '法律、适用范围与时间线一律高风险人工终审；产品不提供法律建议。',
  },
  {
    id: 'linkedin-economic-graph',
    name: 'LinkedIn Economic Graph',
    homepage: 'https://economicgraph.linkedin.com/research/work-change-report',
    kind: 'corporate_research',
    authority: 'company_primary_research',
    language: 'en',
    cadence: 'quarterly',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:47:00.000Z',
    notes: '引用研究口径与样本边界；不把平台数据趋势等同于全部劳动力市场。',
  },
  {
    id: 'stanford-ai-index-2026',
    name: 'Stanford HAI 2026 AI Index',
    homepage: 'https://hai.stanford.edu/ai-index/2026-ai-index-report',
    kind: 'original_research',
    authority: 'academic_primary',
    language: 'en',
    cadence: 'quarterly',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:49:00.000Z',
    notes: '只引用报告公开指标并保留章节口径；不转载图表、长段落或报告全文。',
  },
] as const satisfies readonly SourceRegistryEntry[];

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
}

export function validateSourceRegistry(sources: readonly SourceRegistryInput[]) {
  if (sources.length < 6 || sources.length > 10) {
    throw new Error('first release requires 6-10 sources');
  }

  const ids = new Set<string>();
  const homepages = new Set<string>();
  for (const source of sources) {
    requireNonEmpty(source.id, 'source id');
    requireNonEmpty(source.name, 'source name');
    requireNonEmpty(source.homepage, 'source homepage');
    requireNonEmpty(source.lastVerifiedAt, 'source lastVerifiedAt');

    let homepage: URL;
    try {
      homepage = new URL(source.homepage);
    } catch {
      throw new Error('source homepage must use HTTPS');
    }
    if (homepage.protocol !== 'https:') {
      throw new Error('source homepage must use HTTPS');
    }
    if (source.active !== true) {
      throw new Error('first-release source must be active');
    }
    if (source.redistributionPolicy !== 'metadata_short_summary_link_only') {
      throw new Error('full-text redistribution is not allowed');
    }
    if (Number.isNaN(Date.parse(source.lastVerifiedAt))) {
      throw new Error('source lastVerifiedAt must be an ISO timestamp');
    }
    if (ids.has(source.id)) {
      throw new Error(`duplicate source id: ${source.id}`);
    }
    if (homepages.has(homepage.href)) {
      throw new Error(`duplicate source homepage: ${homepage.href}`);
    }
    ids.add(source.id);
    homepages.add(homepage.href);
  }
}
