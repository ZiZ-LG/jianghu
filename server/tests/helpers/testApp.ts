import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Tenant, User } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { buildApp, type BuildAppOptions } from '../../src/app.js';
import { prisma } from '../../src/prisma.js';
import {
  assertDevDbUnchanged,
  assertTestDatabaseUrl,
  clearTestDatabase,
  devDbBaseline,
} from './testDb.js';

export interface TestContext {
  app: FastifyInstance;
  prisma: PrismaClient;
  tenant: Tenant;
  owner: User;
  token: string;
  cleanup: () => Promise<void>;
}

interface RegistrationBody {
  token: string;
  tenant: { id: string };
  user: { id: string };
}

export async function createTestContext(
  options: Pick<BuildAppOptions, 'productAccess' | 'agentHandlers'> = {},
): Promise<TestContext> {
  assertTestDatabaseUrl();
  await assertDevDbUnchanged(devDbBaseline);
  await clearTestDatabase(prisma);
  await assertDevDbUnchanged(devDbBaseline);

  // Existing integration fixtures exercise the internal compatibility adapter.
  // Commercial tests opt in explicitly so the production default can remain commercial Free.
  const app = await buildApp({
    logger: false,
    productAccess: options.productAccess ?? { edition: 'internal' },
    ...(options.agentHandlers ? { agentHandlers: options.agentHandlers } : {}),
  });
  try {
    const suffix = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: `owner-${suffix}@example.test`,
        password: 'test-password',
        name: 'Test Owner',
        tenantName: `Test Tenant ${suffix}`,
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`Test tenant registration failed (${response.statusCode}): ${response.body}`);
    }

    const body = response.json<RegistrationBody>();
    const [tenant, owner] = await Promise.all([
      prisma.tenant.findUniqueOrThrow({ where: { id: body.tenant.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: body.user.id } }),
    ]);

    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        try {
          await clearTestDatabase(prisma);
          await assertDevDbUnchanged(devDbBaseline);
        } finally {
          await prisma.$disconnect();
        }
      } finally {
        await app.close();
      }
    };

    return { app, prisma, tenant, owner, token: body.token, cleanup };
  } catch (error) {
    try {
      try {
        await clearTestDatabase(prisma);
        await assertDevDbUnchanged(devDbBaseline);
      } finally {
        await prisma.$disconnect();
      }
    } finally {
      await app.close();
    }
    throw error;
  }
}
