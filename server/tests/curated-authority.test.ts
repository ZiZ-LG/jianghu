import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('SAAS-205 CuratedSummary compatibility authority', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  async function setup() {
    test = await createTestContext();
    await test.prisma.account.createMany({ data: [
      {
        id: 'curated-human-account', tenantId: test.tenant.id, name: 'Human',
        primaryOwnerUserId: test.owner.id,
      },
      {
        id: 'curated-ai-account', tenantId: test.tenant.id, name: 'AI cache',
        primaryOwnerUserId: test.owner.id,
      },
      {
        id: 'curated-unsafe-account', tenantId: test.tenant.id, name: 'Unsafe cache',
        primaryOwnerUserId: test.owner.id,
      },
      {
        id: 'curated-empty-account', tenantId: test.tenant.id, name: 'Empty',
        primaryOwnerUserId: test.owner.id,
      },
    ] });
    const basedOnAt = new Date('2026-08-26T01:00:00.000Z');
    await test.prisma.curatedSummary.createMany({ data: [
      {
        id: 'curated-human', tenantId: test.tenant.id, entityKind: 'account',
        entityId: 'curated-human-account', content: '人工确认资料',
        editedByHuman: true, editedBy: test.owner.id, aclVersion: 1,
      },
      {
        id: 'curated-ai', tenantId: test.tenant.id, entityKind: 'account',
        entityId: 'curated-ai-account', content: '旧 AI 缓存资料', model: 'legacy-model',
        basedOnAt, editedByHuman: false, aclVersion: 1,
      },
      {
        id: 'curated-unsafe', tenantId: test.tenant.id, entityKind: 'account',
        entityId: 'curated-unsafe-account', content: '无法证明 ACL 的旧缓存',
        model: 'legacy-model', editedByHuman: false, aclVersion: 0,
      },
    ] });
    return { basedOnAt };
  }

  async function get(accountId: string, token = test!.token) {
    return test!.app.inject({
      method: 'GET',
      url: `/api/curated?entityKind=account&entityId=${accountId}`,
      headers: auth(token),
    });
  }

  it('reads human and ACL-safe legacy rows without AI calls or database writes', async () => {
    await setup();
    const before = await test!.prisma.curatedSummary.findMany({ orderBy: { id: 'asc' } });

    const human = await get('curated-human-account');
    const compatibility = await get('curated-ai-account');
    const unsafe = await get('curated-unsafe-account');
    const empty = await get('curated-empty-account');

    expect(human.statusCode, human.body).toBe(200);
    expect(human.json()).toMatchObject({
      content: '人工确认资料', status: 'human', editedByHuman: true,
    });
    expect(compatibility.statusCode, compatibility.body).toBe(200);
    expect(compatibility.json()).toMatchObject({
      content: '旧 AI 缓存资料', status: 'compatibility_cache', editedByHuman: false,
    });
    expect(unsafe.statusCode, unsafe.body).toBe(200);
    expect(unsafe.json()).toEqual({ content: '', status: 'empty', editedByHuman: false });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ content: '', status: 'empty', editedByHuman: false });
    await expect(test!.prisma.curatedSummary.findMany({ orderBy: { id: 'asc' } }))
      .resolves.toEqual(before);
  });

  it('retires forced AI regeneration with a stable 410 and leaves the row untouched', async () => {
    await setup();
    const before = await test!.prisma.curatedSummary.findUniqueOrThrow({
      where: { id: 'curated-ai' },
    });
    const response = await test!.app.inject({
      method: 'POST', url: '/api/curated/regenerate', headers: auth(test!.token),
      payload: { entityKind: 'account', entityId: 'curated-ai-account' },
    });
    expect(response.statusCode, response.body).toBe(410);
    expect(response.json()).toEqual({
      error: '旧版 AI 梳理已退役，请使用拜访前简报',
      code: 'curated_ai_generation_retired',
    });
    await expect(test!.prisma.curatedSummary.findUniqueOrThrow({
      where: { id: 'curated-ai' },
    })).resolves.toEqual(before);
  });

  it('keeps human-wins on PUT, removes legacy model authority, and increments ACL generation', async () => {
    const { basedOnAt } = await setup();
    const response = await test!.app.inject({
      method: 'PUT', url: '/api/curated', headers: auth(test!.token),
      payload: {
        entityKind: 'account', entityId: 'curated-ai-account', content: '人工修订资料',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const row = await test!.prisma.curatedSummary.findUniqueOrThrow({
      where: { id: 'curated-ai' },
    });
    expect(row).toMatchObject({
      content: '人工修订资料', model: '', basedOnAt: null,
      editedByHuman: true, editedBy: test!.owner.id, aclVersion: 2,
    });
    expect(row.basedOnAt).not.toEqual(basedOnAt);
    const read = await get('curated-ai-account');
    expect(read.json()).toMatchObject({ content: '人工修订资料', status: 'human' });
  });

  it('keeps viewer read restricted and denies both human edit and retired mutation surface', async () => {
    await setup();
    const viewer = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    await test!.prisma.account.update({
      where: { id: 'curated-human-account' }, data: { primaryOwnerUserId: viewer.id },
    });
    const token = test!.app.jwt.sign({
      userId: viewer.id, tenantId: test!.tenant.id, role: 'viewer',
    });
    const read = await get('curated-human-account', token);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ content: '', status: 'restricted', editedByHuman: false });
    for (const input of [
      { method: 'PUT' as const, url: '/api/curated', payload: {
        entityKind: 'account', entityId: 'curated-human-account', content: 'viewer write',
      } },
      { method: 'POST' as const, url: '/api/curated/regenerate', payload: {
        entityKind: 'account', entityId: 'curated-human-account',
      } },
    ]) {
      const response = await test!.app.inject({ ...input, headers: auth(token) });
      expect(response.statusCode, response.body).toBe(403);
    }
    await expect(test!.prisma.curatedSummary.findUniqueOrThrow({
      where: { id: 'curated-human' },
    })).resolves.toMatchObject({ content: '人工确认资料', editedBy: test!.owner.id });
  });
});
