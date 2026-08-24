import type { SeedCandidate } from '../domain';
import { approvedSeedItems } from './items';

// This explicit allowlist is the manual publication gate. Adding a future
// reviewed seed to items.ts cannot make it public without another
// owner-approved code change here.
const OWNER_APPROVED_SEED_IDS = [
  'ST-001', 'ST-002', 'ST-003', 'ST-004', 'ST-005',
  'ST-006', 'ST-007', 'ST-008', 'ST-009', 'ST-010',
  'ST-011', 'ST-012', 'ST-013', 'ST-014', 'ST-015',
  'ST-016', 'ST-017', 'ST-018', 'ST-019', 'ST-020',
  'ST-021', 'ST-022', 'ST-023', 'ST-024', 'ST-025',
  'ST-026', 'ST-027', 'ST-028', 'ST-029', 'ST-030',
] as const;

const approvedSeedById = new Map(approvedSeedItems.map((item) => [item.id, item]));

export const approvedKnowledgeItems: readonly SeedCandidate[] = OWNER_APPROVED_SEED_IDS
  .map((id) => {
    const item = approvedSeedById.get(id);
    if (!item) {
      throw new Error(`owner-approved seed is missing: ${id}`);
    }
    return item;
  });
