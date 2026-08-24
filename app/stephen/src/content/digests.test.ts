import { describe, expect, it } from 'vitest';

import type { SeedCandidate } from '../domain';
import { approvedSeedItems } from './items';
import { knowledgeTools } from './tools';
import {
  createDailyDigest,
  createWeeklyDigest,
} from './digests';

function approve(
  item: SeedCandidate,
  overrides: Partial<SeedCandidate> = {},
): SeedCandidate {
  return {
    ...item,
    ...overrides,
    editorialStatus: 'approved',
    review: {
      ...item.review,
      status: 'approved',
    },
  };
}

function asReviewCandidate(item: SeedCandidate): SeedCandidate {
  return {
    ...item,
    editorialStatus: 'candidate',
    review: {
      ...item.review,
      status: 'pending_owner_review',
    },
  };
}

describe('SAAS-603 reviewed digest projections', () => {
  it('only projects approved content and never leaks candidate or archived entries', () => {
    const approved = approve(approvedSeedItems[0]);
    const archived = {
      ...approve(approvedSeedItems[1]),
      editorialStatus: 'archived' as const,
    };
    const digest = createDailyDigest(
      [approved, asReviewCandidate(approvedSeedItems[2]), archived],
      { digestDate: '2026-08-23' },
    );

    expect(digest.entries.map((entry) => entry.item.id)).toEqual([approved.id]);
    expect(digest.entries.every((entry) => entry.item.editorialStatus === 'approved')).toBe(true);
  });

  it('selects at most five items with cross-domain coverage and action metadata', () => {
    const approved = approvedSeedItems.slice(0, 12).map((item) => approve(item));
    const digest = createDailyDigest(approved, { digestDate: '2026-08-23' });

    expect(digest.entries.length).toBeGreaterThanOrEqual(3);
    expect(digest.entries.length).toBeLessThanOrEqual(5);
    expect(new Set(digest.entries.flatMap((entry) => entry.item.domains)))
      .toEqual(new Set(['ai_technology', 'enterprise_sales', 'role_org']));
    expect(digest.entries.every((entry) => entry.estimatedReadMinutes >= 1)).toBe(true);
    expect(digest.entries.every((entry) => entry.sourceCount >= 1)).toBe(true);
    expect(digest.entries.every((entry) => entry.action.zh.trim().length > 0)).toBe(true);
    expect(digest.estimatedReadMinutes).toBe(
      digest.entries.reduce((total, entry) => total + entry.estimatedReadMinutes, 0),
    );
    expect(digest.sourceCount).toBeGreaterThan(0);
  });

  it('deduplicates a related event and normalized primary evidence URL', () => {
    const first = approve(approvedSeedItems[0], {
      id: 'DIGEST-EVENT-A',
      slug: 'digest-event-a',
      relatedItemIds: ['DIGEST-EVENT-B'],
    });
    const related = approve(approvedSeedItems[1], {
      id: 'DIGEST-EVENT-B',
      slug: 'digest-event-b',
      relatedItemIds: ['DIGEST-EVENT-A'],
    });
    const sameUrl = approve(approvedSeedItems[2], {
      id: 'DIGEST-SAME-URL',
      slug: 'digest-same-url',
      evidence: [{
        ...first.evidence[0],
        id: 'DIGEST-SAME-URL-E1',
        url: `${first.evidence[0].url}?utm_source=digest#top`,
      }],
    });

    const digest = createDailyDigest(
      [first, related, sameUrl],
      { digestDate: '2026-08-23' },
    );

    expect(digest.entries).toHaveLength(1);
    expect(digest.entries[0].item.id).toBe(sameUrl.id);
  });

  it('allows a short or empty edition instead of padding with unapproved content', () => {
    const twoApproved = approvedSeedItems.slice(0, 2).map((item) => approve(item));
    expect(createDailyDigest(twoApproved, { digestDate: '2026-08-23' }).entries)
      .toHaveLength(2);
    expect(createDailyDigest(approvedSeedItems.map(asReviewCandidate), { digestDate: '2026-08-23' }).entries)
      .toEqual([]);
  });

  it('builds a weekly view from new or substantively updated items only', () => {
    const weeklyItems = [
      approve(approvedSeedItems[10], {
        publishedAt: '2026-08-18T08:00:00.000Z',
        updatedAt: '2026-08-18T08:00:00.000Z',
        relatedItemIds: ['WEEK-CONTINUING'],
      }),
      approve(approvedSeedItems[20], {
        publishedAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-08-20T08:00:00.000Z',
      }),
      approve(approvedSeedItems[25], {
        publishedAt: '2026-08-22T08:00:00.000Z',
        updatedAt: '2026-08-22T08:00:00.000Z',
      }),
      approve(approvedSeedItems[5], {
        publishedAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-01T08:00:00.000Z',
      }),
    ];

    const digest = createWeeklyDigest(weeklyItems, {
      weekStart: '2026-08-17',
      weekEnd: '2026-08-23',
      validToolIds: knowledgeTools.map((tool) => tool.id),
    });

    expect(digest.entries).toHaveLength(3);
    expect(digest.mainThread?.item.editorialStatus).toBe('approved');
    expect(digest.continuingEvents.map((entry) => entry.item.id))
      .toContain(weeklyItems[0].id);
    expect(digest.roleChanges.length).toBeGreaterThan(0);
    expect(digest.recommendedToolIds.length).toBeGreaterThan(0);
    expect(digest.recommendedToolIds.every((id) =>
      knowledgeTools.some((tool) => tool.id === id))).toBe(true);
  });

  it('rejects invalid digest dates instead of silently using the current clock', () => {
    expect(() => createDailyDigest([], { digestDate: '08/23/2026' }))
      .toThrow('digestDate must use YYYY-MM-DD');
    expect(() => createWeeklyDigest([], {
      weekStart: '2026-08-24',
      weekEnd: '2026-08-23',
      validToolIds: [],
    })).toThrow('weekStart must not be after weekEnd');
  });
});
