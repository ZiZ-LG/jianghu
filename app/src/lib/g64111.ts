import {
  DEFAULT_PROFILE,
  scoreFromState,
  type ScoreBreakdown,
  type ScoringProfile,
} from '@jianghu/g64111';
import type { Account, Opportunity } from '../types';

export * from '@jianghu/g64111';

/** App domain adapter. All scoring constants and formulas live in @jianghu/g64111. */
export function scoreFromDomain(
  account: Account,
  opportunity: Opportunity,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScoreBreakdown {
  return scoreFromState(account, opportunity, profile);
}
