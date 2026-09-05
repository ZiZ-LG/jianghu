import { expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import { createPersonCandidate, personCandidateDedupeKey } from '../src/candidates/personRelation.js';
import { applyCandidateMigration } from '../src/candidates/migration.js';
import { applySensitiveAclMigration } from '../src/sensitiveAcl/migration.js';

it('preserves current online candidate data across repeated startup migrations', async () => {
  const context = await createTestContext();
  try {
    await applyCandidateMigration(context.prisma);
    await applySensitiveAclMigration(context.prisma);
    const accountId = 'core215-current-customer';
    await context.prisma.account.create({ data: {
      id: accountId, tenantId: context.tenant.id, name: 'Synthetic customer',
    } });
    const input = {
      id: 'core215-person-pending', tenantId: context.tenant.id, accountId,
      matterId: null, name: 'Synthetic pending', title: 'Unknown', orgLevel: 3,
      source: 'mcp', sourceRef: 'core215:synthetic:pending',
      evidence: 'Synthetic test source; human review required', confidence: 0.6,
      createdByUserId: context.owner.id, dedupeKey: personCandidateDedupeKey(accountId, 'Synthetic pending'),
    };
    const created = await createPersonCandidate(context.prisma, input);
    await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'viewer' } });
    const before = await context.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await applyCandidateMigration(context.prisma);
      await applySensitiveAclMigration(context.prisma);
      const after = await context.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } });
      expect(after).toEqual(before);
      expect(await context.prisma.person.count()).toBe(0);
    }
  } finally { await context.cleanup(); }
});
