import { describe, expect, it } from 'vitest';
import * as aiModule from '../src/ai.js';

describe('mock AI analysis selection semantics', () => {
  it('uses the marked non-first D and one legal P4 when context contains historical duplicates', () => {
    const mockAnalysis = (aiModule as Record<string, unknown>).mockAnalysis as ((ctx: unknown, hypothesis: string) => string) | undefined;
    expect(mockAnalysis).toBeTypeOf('function');
    const analysis = mockAnalysis!({
      winTendency: { percent: 0.6, band: '相对优势', items: {} },
      people: [
        { name: '首位D', role: 'D', sentiment: 'plus', isPrimaryD: false },
        { name: '非法A', role: 'A', sentiment: 'star', isKeyInfluencer: true },
        { name: '合法C', role: 'C', sentiment: 'neutral', isKeyInfluencer: true },
        { name: '重复U', role: 'U', sentiment: 'plus', isKeyInfluencer: true },
        { name: '显式主D', role: 'D', sentiment: 'star', isPrimaryD: true },
      ],
    }, '验证主 D 与 P4');

    expect(analysis).toContain('拍板人 D＝显式主D');
    expect(analysis).toContain('关键影响人＝合法C');
    expect(analysis).not.toContain('关键影响人＝非法A');
  });
});
