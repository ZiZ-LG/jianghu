import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SAAS-206 capability route contract', () => {
  it('registers dedicated authenticated personal endpoints without loose prefix matches', async () => {
    const routes = await readFile(resolve('src/intelligenceFocus/routes.ts'), 'utf8');
    const app = await readFile(resolve('src/app.ts'), 'utf8');
    for (const endpoint of [
      '/api/commands/intelligence-item',
      '/api/intelligence-items',
      '/api/intelligence-items/:id',
      '/api/commands/stakeholder-focus',
      '/api/stakeholder-focuses',
      '/api/stakeholder-focuses/:id',
    ]) {
      expect(routes).toContain(endpoint);
    }
    expect(routes.match(/preHandler:\s*\[app\.authenticate\]/g)).toHaveLength(6);
    expect(app).toContain('intelligenceFocusRoutes(app, product.policy)');
    expect(app).not.toContain("pathname.startsWith('/api/intelligence-items')");
    expect(app).not.toContain("pathname.startsWith('/api/stakeholder-focuses')");
  });
});
