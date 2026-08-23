import type { SeedCandidate } from '../domain';

// Production builds import only this module. The owner-review candidate source
// stays physically outside the public application graph until approval.
export const approvedKnowledgeItems: readonly SeedCandidate[] = [];
