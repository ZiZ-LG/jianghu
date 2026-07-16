import { describe, expect, it } from 'vitest';
import { OpaqueEntityIdSchema } from '@jianghu/domain-contracts';
import { createOpaqueEntityId } from './opaqueId';

describe('createOpaqueEntityId', () => {
  it('creates distinct contract-valid 128-bit IDs', () => {
    const ids = new Set(Array.from({ length: 64 }, () => createOpaqueEntityId('opp')));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(OpaqueEntityIdSchema.safeParse(id).success).toBe(true);
  });
});
