import {
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  type KnowledgeItem,
  type LocalizedText,
} from '../domain';

export interface DigestEntry<T extends KnowledgeItem = KnowledgeItem> {
  readonly item: T;
  readonly eventKey: string;
  readonly estimatedReadMinutes: number;
  readonly sourceCount: number;
  readonly action: LocalizedText;
}

export interface DailyDigest<T extends KnowledgeItem = KnowledgeItem> {
  readonly kind: 'daily';
  readonly digestDate: string;
  readonly entries: readonly DigestEntry<T>[];
  readonly coveredDomains: readonly KnowledgeDomain[];
  readonly estimatedReadMinutes: number;
  readonly sourceCount: number;
  readonly todayAction: LocalizedText | null;
}

export interface WeeklyDigest<T extends KnowledgeItem = KnowledgeItem> {
  readonly kind: 'weekly';
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly entries: readonly DigestEntry<T>[];
  readonly coveredDomains: readonly KnowledgeDomain[];
  readonly estimatedReadMinutes: number;
  readonly sourceCount: number;
  readonly mainThread: DigestEntry<T> | null;
  readonly continuingEvents: readonly DigestEntry<T>[];
  readonly roleChanges: readonly DigestEntry<T>[];
  readonly recommendedToolIds: readonly string[];
}

interface DailyDigestOptions {
  readonly digestDate: string;
  readonly limit?: number;
}

interface WeeklyDigestOptions {
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly limit?: number;
  readonly validToolIds: readonly string[];
}

const freshnessPriority: Readonly<Record<KnowledgeItem['freshness'], number>> = {
  breaking: 3,
  current: 2,
  evergreen: 1,
};

function validateDateOnly(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
}

function effectiveTimestamp(item: KnowledgeItem) {
  return Math.max(Date.parse(item.publishedAt), Date.parse(item.updatedAt));
}

function compareDigestValue<T extends KnowledgeItem>(left: T, right: T) {
  return freshnessPriority[right.freshness] - freshnessPriority[left.freshness]
    || effectiveTimestamp(right) - effectiveTimestamp(left)
    || Date.parse(right.publishedAt) - Date.parse(left.publishedAt)
    || left.id.localeCompare(right.id);
}

function normalizeEvidenceUrl(value: string) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    url.hostname = url.hostname.toLocaleLowerCase();
    url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return '';
  }
}

class EventGroups {
  private readonly parent = new Map<string, string>();

  constructor(ids: readonly string[]) {
    ids.forEach((id) => this.parent.set(id, id));
  }

  has(id: string) {
    return this.parent.has(id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent) return id;
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string) {
    if (!this.has(left) || !this.has(right)) return;
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [root, child] = [leftRoot, rightRoot].sort((a, b) => a.localeCompare(b));
    this.parent.set(child, root);
  }
}

function dedupeApprovedItems<T extends KnowledgeItem>(items: readonly T[]) {
  const approved = items.filter((item) => item.editorialStatus === 'approved');
  const groups = new EventGroups(approved.map((item) => item.id));
  const itemByEvidenceUrl = new Map<string, string>();

  for (const item of approved) {
    item.relatedItemIds.forEach((relatedId) => groups.union(item.id, relatedId));
    const primaryUrl = normalizeEvidenceUrl(item.evidence[0]?.url ?? '');
    const existingItemId = itemByEvidenceUrl.get(primaryUrl);
    if (primaryUrl && existingItemId) groups.union(item.id, existingItemId);
    else if (primaryUrl) itemByEvidenceUrl.set(primaryUrl, item.id);
  }

  const representatives = new Map<string, T>();
  for (const item of [...approved].sort(compareDigestValue)) {
    const eventKey = groups.find(item.id);
    if (!representatives.has(eventKey)) representatives.set(eventKey, item);
  }
  return [...representatives.entries()]
    .map(([eventKey, item]) => ({ eventKey, item }))
    .sort((left, right) => compareDigestValue(left.item, right.item));
}

function selectWithDomainCoverage<T extends KnowledgeItem>(
  items: readonly { readonly eventKey: string; readonly item: T }[],
  limit: number,
) {
  const boundedLimit = Math.max(0, Math.min(limit, 5));
  const selected: typeof items[number][] = [];
  const selectedIds = new Set<string>();
  const coveredDomains = new Set<KnowledgeDomain>();

  for (const domain of KNOWLEDGE_DOMAINS) {
    if (coveredDomains.has(domain) || selected.length >= boundedLimit) continue;
    const next = items.find(({ item }) =>
      !selectedIds.has(item.id) && item.domains.includes(domain));
    if (!next) continue;
    selected.push(next);
    selectedIds.add(next.item.id);
    next.item.domains.forEach((itemDomain) => coveredDomains.add(itemDomain));
  }

  for (const entry of items) {
    if (selected.length >= boundedLimit) break;
    if (selectedIds.has(entry.item.id)) continue;
    selected.push(entry);
    selectedIds.add(entry.item.id);
    entry.item.domains.forEach((domain) => coveredDomains.add(domain));
  }

  return selected;
}

function estimateReadMinutes(item: KnowledgeItem) {
  const text = [
    item.title.zh,
    item.summary.zh,
    item.whyItMatters.zh,
    item.salesImplication.zh,
    item.roleOrgImplication.zh,
    item.nextAction.zh,
  ].join(' ');
  const cjkCharacters = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latinWords = text.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(cjkCharacters / 350 + latinWords / 180));
}

function toDigestEntry<T extends KnowledgeItem>(
  entry: { readonly eventKey: string; readonly item: T },
): DigestEntry<T> {
  return {
    item: entry.item,
    eventKey: entry.eventKey,
    estimatedReadMinutes: estimateReadMinutes(entry.item),
    sourceCount: new Set(entry.item.evidence.map((evidence) => evidence.sourceId)).size,
    action: entry.item.nextAction,
  };
}

function summarizeEntries<T extends KnowledgeItem>(entries: readonly DigestEntry<T>[]) {
  const domains = new Set(entries.flatMap((entry) => entry.item.domains));
  const sources = new Set(entries.flatMap((entry) =>
    entry.item.evidence.map((evidence) => evidence.sourceId)));
  return {
    coveredDomains: KNOWLEDGE_DOMAINS.filter((domain) => domains.has(domain)),
    estimatedReadMinutes: entries.reduce(
      (total, entry) => total + entry.estimatedReadMinutes,
      0,
    ),
    sourceCount: sources.size,
  };
}

function projectEntries<T extends KnowledgeItem>(items: readonly T[], limit = 5) {
  return selectWithDomainCoverage(dedupeApprovedItems(items), limit).map(toDigestEntry);
}

export function createDailyDigest<T extends KnowledgeItem>(
  items: readonly T[],
  options: DailyDigestOptions,
): DailyDigest<T> {
  validateDateOnly(options.digestDate, 'digestDate');
  const entries = projectEntries(items, options.limit);
  const summary = summarizeEntries(entries);
  return {
    kind: 'daily',
    digestDate: options.digestDate,
    entries,
    ...summary,
    todayAction: entries[0]?.action ?? null,
  };
}

function dateOnly(timestamp: string) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function effectiveDate(item: KnowledgeItem) {
  return dateOnly(new Date(effectiveTimestamp(item)).toISOString());
}

function extractToolIds(item: KnowledgeItem) {
  const candidate = item as KnowledgeItem & { readonly toolIds?: unknown };
  if (!Array.isArray(candidate.toolIds)) return [];
  return candidate.toolIds.filter((id): id is string => typeof id === 'string');
}

export function createWeeklyDigest<T extends KnowledgeItem>(
  items: readonly T[],
  options: WeeklyDigestOptions,
): WeeklyDigest<T> {
  validateDateOnly(options.weekStart, 'weekStart');
  validateDateOnly(options.weekEnd, 'weekEnd');
  if (options.weekStart > options.weekEnd) {
    throw new Error('weekStart must not be after weekEnd');
  }

  const inWindow = items.filter((item) => {
    const effective = effectiveDate(item);
    return effective >= options.weekStart && effective <= options.weekEnd;
  });
  const entries = projectEntries(inWindow, options.limit);
  const summary = summarizeEntries(entries);
  const validToolIds = new Set(options.validToolIds);
  const recommendedToolIds = [...new Set(entries.flatMap((entry) =>
    extractToolIds(entry.item).filter((toolId) => validToolIds.has(toolId))))];

  return {
    kind: 'weekly',
    weekStart: options.weekStart,
    weekEnd: options.weekEnd,
    entries,
    ...summary,
    mainThread: entries[0] ?? null,
    continuingEvents: entries.filter((entry) => entry.item.relatedItemIds.length > 0),
    roleChanges: entries.filter((entry) => entry.item.domains.includes('role_org')),
    recommendedToolIds,
  };
}
