import { describe, expect, it } from 'vitest';
import { computeOverflowMenuLayout } from './overflowMenuLayout';

describe('OverflowMenu viewport layout', () => {
  it('gives a landscape-phone menu enough scrollable height outside a clipped parent', () => {
    const layout = computeOverflowMenuLayout(
      { left: 98, right: 163, bottom: 42 },
      { width: 812, height: 375 },
      'left',
    );

    expect(layout).toEqual({
      position: 'fixed',
      top: 48,
      left: 98,
      right: 'auto',
      maxHeight: 319,
    });
  });

  it('keeps a right-aligned menu inside the viewport margin', () => {
    const layout = computeOverflowMenuLayout(
      { left: 760, right: 805, bottom: 42 },
      { width: 812, height: 375 },
      'right',
    );

    expect(layout).toMatchObject({ left: 620, right: 'auto' });
  });

  it('clamps a left-aligned menu to the viewport margin', () => {
    const layout = computeOverflowMenuLayout(
      { left: -24, right: 40, bottom: 42 },
      { width: 812, height: 375 },
      'left',
    );

    expect(layout.left).toBe(8);
  });

  it('keeps narrow or exhausted viewports deterministic without negative height', () => {
    expect(computeOverflowMenuLayout(
      { left: 2, right: 30, bottom: 42 },
      { width: 160, height: 48 },
      'right',
    )).toEqual({
      position: 'fixed',
      top: 48,
      left: 8,
      right: 'auto',
      maxHeight: 0,
    });
  });
});
