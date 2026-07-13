import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('deployment egress configuration', () => {
  it('passes both deployment-owned outbound allowlists into the server container', async () => {
    const compose = await readFile(resolve(process.cwd(), '../docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/OUTBOUND_ALLOWED_HOSTS:\s*\$\{OUTBOUND_ALLOWED_HOSTS:/);
    expect(compose).toMatch(/OUTBOUND_ALLOWED_PRIVATE_HOSTS:\s*\$\{OUTBOUND_ALLOWED_PRIVATE_HOSTS:-\}/);
  });

  it('keeps fixed providers usable in the development environment example', async () => {
    const example = await readFile(resolve(process.cwd(), '.env.example'), 'utf8');
    expect(example).toContain('OUTBOUND_ALLOWED_HOSTS=open.feishu.cn,agent.qcc.com,openapi.biji.com,qyapi.weixin.qq.com');
    expect(example).toContain('OUTBOUND_ALLOWED_PRIVATE_HOSTS=');
  });
});
