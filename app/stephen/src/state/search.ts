import type { KnowledgeDomain, SeedCandidate } from '../domain';

interface SearchFilters {
  readonly domains: readonly KnowledgeDomain[];
  readonly mode: 'and' | 'or';
}

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function matchesDomains(item: SeedCandidate, filters?: SearchFilters) {
  if (!filters || filters.domains.length === 0) return true;
  return filters.mode === 'and'
    ? filters.domains.every((domain) => item.domains.includes(domain))
    : filters.domains.some((domain) => item.domains.includes(domain));
}

function scoreItem(item: SeedCandidate, tokens: readonly string[]) {
  const weightedFields = [
    [item.title.zh, 12],
    [item.originalTitle ?? '', 10],
    [item.tags.join(' '), 8],
    [item.summary.zh, 6],
    [item.nextAction.zh, 5],
    [item.whyItMatters.zh, 4],
    [item.salesImplication.zh, 3],
    [item.roleOrgImplication.zh, 3],
    [item.topicSlugs.join(' '), 2],
  ] as const;
  const normalizedFields = weightedFields.map(([value, weight]) => [normalize(value), weight] as const);
  if (!tokens.every((token) => normalizedFields.some(([value]) => value.includes(token)))) return 0;
  return tokens.reduce((score, token) => score + normalizedFields.reduce(
    (fieldScore, [value, weight]) => fieldScore + (value.includes(token) ? weight : 0),
    0,
  ), 0);
}

export function searchKnowledge(
  items: readonly SeedCandidate[],
  query: string,
  filters?: SearchFilters,
) {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => matchesDomains(item, filters))
    .map((item) => ({ item, score: tokens.length === 0 ? 1 : scoreItem(item, tokens) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score
      || Date.parse(right.item.publishedAt) - Date.parse(left.item.publishedAt))
    .map(({ item }) => item);
}

export function sanitizeMarkdownFilename(title: string) {
  const safe = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `${safe || 'stephen-tool'}.md`;
}
