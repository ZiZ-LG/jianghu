import { describe, expect, it } from 'vitest';
import { OpaqueEntityIdSchema } from '../src/index.js';

describe('OpaqueEntityIdSchema', () => {
  it('accepts 128-bit opaque IDs and rejects legacy or truncated values', () => {
    expect(OpaqueEntityIdSchema.safeParse('opp_00112233445566778899aabbccddeeff').success).toBe(true);
    expect(OpaqueEntityIdSchema.safeParse('opp_001122334455').success).toBe(false);
    expect(OpaqueEntityIdSchema.safeParse('opp-mnb4-random').success).toBe(false);
  });
});
