export type SourceKind =
  | 'official_product_news'
  | 'official_engineering_blog'
  | 'official_documentation'
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

export interface SourceRssIngestion {
  readonly protocol: 'rss2';
  readonly endpoint: string;
  readonly allowedEndpointHosts: readonly string[];
  readonly allowedItemHosts: readonly string[];
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxRedirects: number;
  readonly timeoutMs: number;
}

export interface SourceRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly homepage: string;
  readonly kind: SourceKind;
  readonly authority: SourceAuthority;
  readonly language: 'zh' | 'en' | 'multilingual';
  readonly originRegion: 'mainland_china' | 'international';
  readonly cadence: SourceCadence;
  readonly redistributionPolicy: 'metadata_short_summary_link_only';
  readonly automaticEligibility: SourceAutomaticEligibility;
  readonly ingestion?: SourceRssIngestion;
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
  readonly originRegion?: unknown;
  readonly ingestion?: unknown;
}

export const sourceRegistry = [
  {
    id: 'openai-news-rss',
    name: 'OpenAI News RSS',
    homepage: 'https://openai.com/news/rss.xml',
    kind: 'official_product_news',
    authority: 'vendor_official',
    language: 'en',
    originRegion: 'international',
    cadence: 'twice_daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    ingestion: {
      protocol: 'rss2',
      endpoint: 'https://openai.com/news/rss.xml',
      allowedEndpointHosts: ['openai.com'],
      allowedItemHosts: ['openai.com'],
      maxBytes: 1_000_000,
      maxItems: 40,
      maxRedirects: 2,
      timeoutMs: 10_000,
    },
    active: true,
    lastVerifiedAt: '2026-08-24T15:27:00.000Z',
    notes: '仅登记官方标题、日期、链接与自有短摘要；公司案例中的效果数字按企业自述标识。',
  },
  {
    id: 'anthropic-news',
    name: 'Anthropic Newsroom',
    homepage: 'https://www.anthropic.com/news',
    kind: 'official_product_news',
    authority: 'vendor_official',
    language: 'en',
    originRegion: 'international',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    active: true,
    lastVerifiedAt: '2026-08-23T17:40:00.000Z',
    notes: '新闻、工程方法、隐私说明和岗位事实分别核验；不把厂商主张写成独立验证事实。',
  },
  {
    id: 'google-cloud-ai-blog',
    name: 'Google Cloud AI & Machine Learning Blog',
    homepage: 'https://cloud.google.com/blog/products/ai-machine-learning',
    kind: 'official_engineering_blog',
    authority: 'vendor_official',
    language: 'en',
    originRegion: 'international',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'eligible_low_risk_facts',
    ingestion: {
      protocol: 'rss2',
      endpoint: 'https://cloudblog.withgoogle.com/products/ai-machine-learning/rss/',
      allowedEndpointHosts: ['cloudblog.withgoogle.com'],
      allowedItemHosts: ['cloud.google.com'],
      maxBytes: 1_000_000,
      maxItems: 40,
      maxRedirects: 2,
      timeoutMs: 10_000,
    },
    active: true,
    lastVerifiedAt: '2026-08-24T15:31:00.000Z',
    notes: '只自动处理官方产品和工程事实；客户案例、效果与方法建议进入人工复核。',
  },
  {
    id: 'anthropic-careers',
    name: 'Anthropic Careers',
    homepage: 'https://www.anthropic.com/careers/jobs',
    kind: 'official_careers',
    authority: 'vendor_official',
    language: 'en',
    originRegion: 'international',
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
    originRegion: 'international',
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
    originRegion: 'international',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:46:00.000Z',
    notes: '法律、适用范围与时间线一律高风险人工终审；产品不提供法律建议。',
  },
  {
    id: 'stanford-ai-index-2026',
    name: 'Stanford HAI 2026 AI Index',
    homepage: 'https://hai.stanford.edu/ai-index/2026-ai-index-report',
    kind: 'original_research',
    authority: 'academic_primary',
    language: 'en',
    originRegion: 'international',
    cadence: 'quarterly',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T17:49:00.000Z',
    notes: '只引用报告公开指标并保留章节口径；不转载图表、长段落或报告全文。',
  },
  {
    id: 'aliyun-model-studio',
    name: '阿里云百炼 Model Studio 官方文档',
    homepage: 'https://help.aliyun.com/zh/model-studio/',
    kind: 'official_documentation',
    authority: 'vendor_official',
    language: 'zh',
    originRegion: 'mainland_china',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T20:20:00.000Z',
    notes: '记录中国大陆产品、区域、计费、评测、隐私和 Agent 身份能力；不同套餐与地域条款分开核验。',
  },
  {
    id: 'aliyun-careers',
    name: '阿里云社会招聘',
    homepage: 'https://careers.aliyun.com/off-campus/position-list?lang=zh',
    kind: 'official_careers',
    authority: 'vendor_official',
    language: 'zh',
    originRegion: 'mainland_china',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T20:40:00.000Z',
    notes: '岗位名称与数量仅作为核验当日快照；能力趋势属于跨岗位编辑归纳，发布前重新观察。',
  },
  {
    id: 'tencent-cloud-ai',
    name: '腾讯云 AI 官方文档',
    homepage: 'https://cloud.tencent.com/document/product/1729',
    kind: 'official_documentation',
    authority: 'vendor_official',
    language: 'zh',
    originRegion: 'mainland_china',
    cadence: 'daily',
    redistributionPolicy: 'metadata_short_summary_link_only',
    automaticEligibility: 'manual_review_only',
    active: true,
    lastVerifiedAt: '2026-08-23T21:00:00.000Z',
    notes: '核验混元、ADP、API 兼容和计费等大陆产品事实；不把产品页能力声明当成客户成效。',
  },
] as const satisfies readonly SourceRegistryEntry[];

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireHostList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((host) => (
    typeof host !== 'string'
    || host.trim() === ''
    || host !== host.toLocaleLowerCase()
    || host.includes('/')
    || host.includes('*')
  ))) {
    throw new Error(`${label} must contain exact lowercase hosts`);
  }
  return value as readonly string[];
}

function requireBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is outside the allowed range`);
  }
}

function validateIngestionConfig(value: unknown) {
  if (!isRecord(value) || value.protocol !== 'rss2') {
    throw new Error('source ingestion protocol must be rss2');
  }
  requireNonEmpty(value.endpoint, 'source ingestion endpoint');
  const endpointHosts = requireHostList(
    value.allowedEndpointHosts,
    'source ingestion allowedEndpointHosts',
  );
  requireHostList(value.allowedItemHosts, 'source ingestion allowedItemHosts');

  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error('source ingestion endpoint must use HTTPS');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('source ingestion endpoint must use HTTPS');
  }
  if (!endpointHosts.includes(endpoint.hostname)) {
    throw new Error('source ingestion endpoint host must be allowlisted');
  }
  requireBoundedInteger(value.maxBytes, 'source ingestion maxBytes', 1, 1_000_000);
  requireBoundedInteger(value.maxItems, 'source ingestion maxItems', 1, 50);
  requireBoundedInteger(value.maxRedirects, 'source ingestion maxRedirects', 0, 3);
  requireBoundedInteger(value.timeoutMs, 'source ingestion timeoutMs', 1_000, 30_000);

  return endpoint.href;
}

export function validateSourceRegistry(sources: readonly SourceRegistryInput[]) {
  if (sources.length < 6 || sources.length > 10) {
    throw new Error('first release requires 6-10 sources');
  }

  const ids = new Set<string>();
  const homepages = new Set<string>();
  const ingestionEndpoints = new Set<string>();
  let machineSourceCount = 0;
  for (const source of sources) {
    requireNonEmpty(source.id, 'source id');
    requireNonEmpty(source.name, 'source name');
    requireNonEmpty(source.homepage, 'source homepage');
    requireNonEmpty(source.lastVerifiedAt, 'source lastVerifiedAt');
    if (source.originRegion !== 'mainland_china' && source.originRegion !== 'international') {
      throw new Error('source originRegion is invalid');
    }

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
    if (source.ingestion !== undefined) {
      const endpoint = validateIngestionConfig(source.ingestion);
      if (ingestionEndpoints.has(endpoint)) {
        throw new Error(`duplicate source ingestion endpoint: ${endpoint}`);
      }
      ingestionEndpoints.add(endpoint);
      machineSourceCount += 1;
    }
    ids.add(source.id);
    homepages.add(homepage.href);
  }

  if (machineSourceCount < 2 || machineSourceCount > 3) {
    throw new Error('cold-start release requires 2-3 machine sources');
  }
}
