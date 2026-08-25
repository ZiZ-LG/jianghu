import { describe, expect, it } from 'vitest';

import {
  projectEditorialGovernance,
  runSequentialEditorialScans,
} from '../../scripts/stephen-editorial-runner';

describe('SAAS-605 multi-source editorial scan orchestration', () => {
  it('passes accumulated history to each later source and isolates one source failure', async () => {
    const receivedHistory: ReadonlySet<string>[] = [];
    const result = await runSequentialEditorialScans(
      [{ id: 'first' }, { id: 'failed' }, { id: 'third' }],
      async (source, history) => {
        receivedHistory.push(history.normalizedUrls ?? new Set());
        if (source.id === 'failed') throw new Error('source unavailable');
        const normalizedUrls = new Set(history.normalizedUrls ?? []);
        normalizedUrls.add(`https://example.com/${source.id}`);
        return {
          report: source.id,
          nextHistory: {
            normalizedUrls,
            eventKeys: new Set(history.eventKeys ?? []),
            sourceFingerprints: new Set(history.sourceFingerprints ?? []),
          },
        };
      },
    );

    expect(receivedHistory[0].size).toBe(0);
    expect(receivedHistory[1]).toContain('https://example.com/first');
    expect(receivedHistory[2]).toContain('https://example.com/first');
    expect(result.reports).toEqual(['first', 'third']);
    expect(result.failures).toMatchObject([
      { sourceId: 'failed', error: expect.any(Error) },
    ]);
    expect(result.nextHistory.normalizedUrls)
      .toEqual(new Set(['https://example.com/first', 'https://example.com/third']));
  });

  it('projects per-candidate governance decisions for the SAAS-606 review gate', () => {
    const decisions = [{ itemId: 'ED-ONE', disposition: 'manual_review' }];

    expect(projectEditorialGovernance({
      decisions,
      autoReady: [],
      manualReview: decisions,
      rejected: [{ itemId: 'ED-TWO' }],
    })).toEqual({
      autoReady: 0,
      manualReview: 1,
      rejected: 1,
      decisions,
    });
  });
});
