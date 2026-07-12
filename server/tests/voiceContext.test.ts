import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { deriveIngestCommandContext } from '../src/voice.js';

const baseCtx: CommandContext = {
  tenantId: 'tenant-voice-context',
  actorId: 'actor-voice-context',
  actorRole: 'member',
  channel: 'web',
  requestId: 'request-voice-context',
  assertionMode: 'user_asserted',
};

describe('manual voice CommandContext trust mapping', () => {
  it.each([
    ['account', { kind: 'inferred' }],
    ['opportunity', { kind: 'inferred' }],
    ['relationship-note source', { kind: 'inferred' }],
  ] as const)('labels an inferred %s as machine_proposed', (_label, item) => {
    const ctx = deriveIngestCommandContext(baseCtx, { kind: 'structured', source: 'voice', item });

    expect(ctx.assertionMode).toBe('machine_proposed');
  });

  it.each([
    ['account', { kind: 'explicit', confidence: 0.9 }],
    ['opportunity', { kind: 'explicit', confidence: 0.9 }],
    ['relationship-note source', { kind: 'explicit', confidence: 0.9 }],
  ] as const)('labels an explicit %s as user_asserted', (_label, item) => {
    const ctx = deriveIngestCommandContext(baseCtx, { kind: 'structured', source: 'voice', item });

    expect(ctx.assertionMode).toBe('user_asserted');
  });

  it('keeps recording-derived structured items machine_proposed', () => {
    const ctx = deriveIngestCommandContext(baseCtx, {
      kind: 'structured',
      source: 'recording',
      item: { kind: 'explicit', confidence: 0.99 },
    });

    expect(ctx.assertionMode).toBe('machine_proposed');
  });

  it('keeps raw notes raw_append', () => {
    const ctx = deriveIngestCommandContext(baseCtx, { kind: 'raw' });

    expect(ctx.assertionMode).toBe('raw_append');
  });
});
