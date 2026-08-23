import { describe, expect, it } from 'vitest';

import { sourceRegistry, validateSourceRegistry } from './sources';

describe('Stephen source governance', () => {
  it('keeps the first release within ten active, independently identified public sources', () => {
    expect(sourceRegistry).toHaveLength(10);
    expect(sourceRegistry.filter((source) => source.active)).toHaveLength(10);

    const ids = sourceRegistry.map((source) => source.id);
    const homepages = sourceRegistry.map((source) => source.homepage);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(homepages).size).toBe(homepages.length);
    expect(() => validateSourceRegistry(sourceRegistry)).not.toThrow();
  });

  it('rejects unsafe, inactive or full-text redistribution sources', () => {
    const valid = sourceRegistry[0];
    type SourceInput = Parameters<typeof validateSourceRegistry>[0][number];
    const replaceFirst = (replacement: SourceInput) => [
      replacement,
      ...sourceRegistry.slice(1),
    ];

    expect(() => validateSourceRegistry(replaceFirst({ ...valid, homepage: 'http://example.com' })))
      .toThrow('source homepage must use HTTPS');
    expect(() => validateSourceRegistry(replaceFirst({ ...valid, active: false })))
      .toThrow('first-release source must be active');
    expect(() => validateSourceRegistry(replaceFirst({
      ...valid,
      redistributionPolicy: 'full_text_allowed',
    })))
      .toThrow('full-text redistribution is not allowed');
  });
});
