import { describe, expect, it } from 'vitest';
import { dec, enc } from '../src/ai.js';
import { validateProductionConfig } from '../src/security/productionConfig.js';

const validProduction = {
  NODE_ENV: 'production',
  JWT_SECRET: 'jwt-secret-with-at-least-thirty-two-characters',
  AI_KEY_SECRET: 'ai-secret-with-at-least-thirty-two-characters',
};

describe('production secret validation', () => {
  it.each([
    ['JWT_SECRET', { JWT_SECRET: undefined }],
    ['JWT_SECRET', { JWT_SECRET: 'dev-secret-change-in-production' }],
    ['AI_KEY_SECRET', { AI_KEY_SECRET: undefined }],
    ['AI_KEY_SECRET', { AI_KEY_SECRET: 'dev-ai-secret-change-in-production' }],
  ])('fails closed for missing/default %s', (name, override) => {
    expect(() => validateProductionConfig({ ...validProduction, ...override })).toThrow(name);
  });

  it.each([
    ['JWT_SECRET', '__改成64位随机十六进制__'],
    ['AI_KEY_SECRET', 'short-secret'],
  ])('rejects placeholder or weak %s', (name, value) => {
    expect(() => validateProductionConfig({ ...validProduction, [name]: value })).toThrow(name);
  });

  it('accepts strong non-default production secrets', () => {
    expect(() => validateProductionConfig(validProduction)).not.toThrow();
  });

  it('keeps test and development defaults usable', () => {
    expect(() => validateProductionConfig({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => validateProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('derives the encryption key from the loaded runtime environment', () => {
    const previous = process.env.AI_KEY_SECRET;
    try {
      process.env.AI_KEY_SECRET = 'a'.repeat(64);
      const ciphertext = enc('tenant-api-key');
      process.env.AI_KEY_SECRET = 'b'.repeat(64);
      expect(dec(ciphertext)).toBe('');
      process.env.AI_KEY_SECRET = 'a'.repeat(64);
      expect(dec(ciphertext)).toBe('tenant-api-key');
    } finally {
      if (previous === undefined) delete process.env.AI_KEY_SECRET;
      else process.env.AI_KEY_SECRET = previous;
    }
  });
});
