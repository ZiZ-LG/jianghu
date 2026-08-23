import type {
  KnowledgeDomain,
  KnowledgeItem,
  KnowledgeTopic,
  LocalizedText,
} from './domain';

export type AppRoute =
  | { readonly name: 'today' }
  | { readonly name: 'radar' }
  | { readonly name: 'topics' }
  | { readonly name: 'topic'; readonly slug: string }
  | { readonly name: 'tools' }
  | { readonly name: 'roles' }
  | { readonly name: 'learn' }
  | { readonly name: 'library' }
  | { readonly name: 'item'; readonly slug: string }
  | { readonly name: 'not_found' };

export interface NavigationItem {
  readonly href: string;
  readonly label: LocalizedText;
  readonly shortLabel: LocalizedText;
}

export const desktopNavigation: readonly NavigationItem[] = [
  { href: '/', label: { zh: '今日必读', en: 'Today' }, shortLabel: { zh: '今日', en: 'Today' } },
  { href: '/radar/', label: { zh: '雷达专题', en: 'Radar' }, shortLabel: { zh: '专题', en: 'Radar' } },
  { href: '/tools/', label: { zh: '方法工具', en: 'Tools' }, shortLabel: { zh: '工具', en: 'Tools' } },
  { href: '/library/', label: { zh: '我的收藏', en: 'Library' }, shortLabel: { zh: '我的', en: 'Mine' } },
];

export const mobileNavigation = desktopNavigation;

function normalizePath(pathname: string) {
  const pathOnly = pathname.split(/[?#]/, 1)[0] || '/';
  const withLeadingSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const collapsed = withLeadingSlash.replace(/\/{2,}/g, '/');
  return collapsed === '/' ? '/' : `${collapsed.replace(/\/+$/, '')}/`;
}

function decodeSlug(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute(pathname: string): AppRoute {
  const path = normalizePath(pathname);
  if (path === '/') return { name: 'today' };
  if (path === '/radar/') return { name: 'radar' };
  if (path === '/topics/') return { name: 'topics' };
  if (path === '/tools/') return { name: 'tools' };
  if (path === '/roles/') return { name: 'roles' };
  if (path === '/learn/') return { name: 'learn' };
  if (path === '/library/') return { name: 'library' };

  const topic = path.match(/^\/topics\/([^/]+)\/$/);
  if (topic) return { name: 'topic', slug: decodeSlug(topic[1]) };
  const item = path.match(/^\/items\/([^/]+)\/$/);
  if (item) return { name: 'item', slug: decodeSlug(item[1]) };

  return { name: 'not_found' };
}

export function getKnowledgeItemBySlug<T extends KnowledgeItem>(
  items: readonly T[],
  slug: string,
): T | null {
  return items.find((item) => item.slug === slug) ?? null;
}

export function getKnowledgeTopicBySlug<T extends KnowledgeTopic>(
  topics: readonly T[],
  slug: string,
): T | null {
  return topics.find((topic) => topic.slug === slug) ?? null;
}

const freshnessPriority: Readonly<Record<KnowledgeItem['freshness'], number>> = {
  breaking: 3,
  current: 2,
  evergreen: 1,
};

export function selectTodayItems<T extends KnowledgeItem>(
  items: readonly T[],
  options: { readonly includeCandidates?: boolean; readonly limit?: number } = {},
): T[] {
  const limit = Math.max(0, Math.min(options.limit ?? 5, 5));
  return items
    .filter((item) => item.editorialStatus === 'approved'
      || (options.includeCandidates === true && item.editorialStatus === 'candidate'))
    .sort((left, right) => {
      const priority = freshnessPriority[right.freshness] - freshnessPriority[left.freshness];
      return priority || Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
    })
    .slice(0, limit);
}

export interface DomainFilters {
  readonly domains: readonly KnowledgeDomain[];
  readonly mode: 'and' | 'or';
}

export function filterKnowledgeItems<T extends KnowledgeItem>(
  items: readonly T[],
  filters: DomainFilters,
): T[] {
  if (filters.domains.length === 0) return [...items];
  return items.filter((item) => filters.mode === 'and'
    ? filters.domains.every((domain) => item.domains.includes(domain))
    : filters.domains.some((domain) => item.domains.includes(domain)));
}

export function toKnowledgeCardModel(item: KnowledgeItem) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    whyItMatters: item.whyItMatters,
    nextAction: item.nextAction,
    domains: item.domains,
    editorialStatus: item.editorialStatus,
    publishedAt: item.publishedAt,
    evidenceHref: item.evidence[0]?.url ?? '',
    evidenceCount: item.evidence.length,
    itemHref: `/items/${encodeURIComponent(item.slug)}/`,
  } as const;
}
