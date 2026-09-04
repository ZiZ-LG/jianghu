import {
  DEFAULT_PROFILE,
  buildScoringInput as engineBuildScoringInput,
  personContributions as enginePersonContributions,
  scoreFromState as engineScoreFromState,
  type PersonContribution,
  type ScoreBreakdown,
  type ScoringAccount,
  type ScoringBurningIssue,
  type ScoringInput,
  type ScoringOpportunity,
  type ScoringPerson,
  type ScoringProfile,
  type ScoringRole,
  type ScoringUcv,
} from '@jianghu/g64111';
import { G64111_BUILTIN_ENGINE_REF } from '@jianghu/domain-contracts';
import type { Account, Opportunity } from '../types';

export * from '@jianghu/g64111';

export const G64111_ENGINE_REF = G64111_BUILTIN_ENGINE_REF;

export interface G64111LegacyStorageBinding {
  key: string;
  storageBindingKind: string;
  storageBindingPath: string;
}

export interface G64111RuntimeConfig {
  engineRef: string;
  storageBindings: readonly G64111LegacyStorageBinding[];
}

export interface G64111LegacyProjection {
  account: ScoringAccount;
  opportunity: ScoringOpportunity;
  pipelineStage: unknown;
}

export interface G64111Adapter {
  engineRef: string;
  projectLegacyState: (
    account: ScoringAccount,
    opportunity: ScoringOpportunity & { pipelineStage?: unknown },
  ) => G64111LegacyProjection;
  buildScoringInput: (
    account: ScoringAccount,
    opportunity: ScoringOpportunity & { pipelineStage?: unknown },
  ) => ScoringInput;
  scoreFromState: (
    account: ScoringAccount,
    opportunity: ScoringOpportunity & { pipelineStage?: unknown },
    profile?: ScoringProfile,
  ) => ScoreBreakdown;
  personContributions: (
    account: ScoringAccount,
    opportunity: ScoringOpportunity & { pipelineStage?: unknown },
    profile?: ScoringProfile,
  ) => Map<string, PersonContribution>;
}

export class G64111AdapterConfigurationError extends Error {
  readonly code = 'g64111_adapter_configuration_error';

  constructor(message: string) {
    super(message);
    this.name = 'G64111AdapterConfigurationError';
  }
}

const legacyPath = (key: string, storageBindingPath: string): G64111LegacyStorageBinding => Object.freeze({
  key,
  storageBindingKind: 'legacy_path',
  storageBindingPath,
});

const EXPECTED_LEGACY_BINDINGS = Object.freeze([
  legacyPath('g64111.primary_d', 'Opportunity.primaryDPersonId'),
  legacyPath('g64111.pipeline_stage', 'Opportunity.pipelineStage'),
  legacyPath('g64111.engage_stage', 'Opportunity.engageStage'),
  legacyPath('g64111.c3_items', 'Opportunity.c3Items'),
  legacyPath('g64111.c5_items', 'Opportunity.c5Items'),
  legacyPath('g64111.roles', 'OppRole[]'),
  legacyPath('g64111.burning_issues', 'BurningIssue[]'),
  legacyPath('g64111.unique_value_claims', 'UCV[]'),
  legacyPath('g64111.person_form_family7', 'Person.form.family7'),
]);

export const G64111_RUNTIME_CONFIG: G64111RuntimeConfig = Object.freeze({
  engineRef: G64111_ENGINE_REF,
  storageBindings: EXPECTED_LEGACY_BINDINGS,
});

interface LegacySource {
  account: ScoringAccount;
  opportunity: ScoringOpportunity & { pipelineStage?: unknown };
}

type LegacyOpportunity = ScoringOpportunity & { pipelineStage?: unknown };

const LEGACY_PATH_READERS: Readonly<Record<string, (source: LegacySource) => unknown>> = Object.freeze({
  'Opportunity.primaryDPersonId': ({ opportunity }) => opportunity.primaryDPersonId,
  'Opportunity.pipelineStage': ({ opportunity }) => opportunity.pipelineStage,
  'Opportunity.engageStage': ({ opportunity }) => opportunity.engageStage,
  'Opportunity.c3Items': ({ opportunity }) => opportunity.c3Items,
  'Opportunity.c5Items': ({ opportunity }) => opportunity.c5Items,
  'OppRole[]': ({ opportunity }) => opportunity.roles,
  'BurningIssue[]': ({ opportunity }) => opportunity.bis,
  'UCV[]': ({ opportunity }) => opportunity.ucvs,
  'Person.form.family7': ({ account }) => account.persons,
});

function configurationError(message: string): never {
  throw new G64111AdapterConfigurationError(message);
}

function validateRuntimeConfig(config: G64111RuntimeConfig): Map<string, G64111LegacyStorageBinding> {
  if (config.engineRef !== G64111_ENGINE_REF) {
    configurationError(`unsupported engineRef: ${config.engineRef}`);
  }
  if (!Array.isArray(config.storageBindings) || config.storageBindings.length !== EXPECTED_LEGACY_BINDINGS.length) {
    configurationError('registered legacy binding set is incomplete');
  }

  const byKey = new Map<string, G64111LegacyStorageBinding>();
  for (const binding of config.storageBindings) {
    if (byKey.has(binding.key)) configurationError(`duplicate storage binding: ${binding.key}`);
    byKey.set(binding.key, Object.freeze({ ...binding }));
  }
  for (const expected of EXPECTED_LEGACY_BINDINGS) {
    const actual = byKey.get(expected.key);
    if (
      !actual
      || actual.storageBindingKind !== expected.storageBindingKind
      || actual.storageBindingPath !== expected.storageBindingPath
      || !LEGACY_PATH_READERS[actual.storageBindingPath]
    ) {
      configurationError(`unregistered or drifted storage binding: ${expected.key}`);
    }
  }
  return byKey;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('G64111 legacy binding expected an object');
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : asRecord(value);
}

function asOptionalArray(value: unknown): readonly unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new TypeError('G64111 legacy binding expected an array');
  return value;
}

function projectPersons(value: unknown): ScoringPerson[] | undefined {
  return asOptionalArray(value)?.map((raw) => {
    const person = asRecord(raw);
    const form = asOptionalRecord(person.form);
    const family7 = form ? asOptionalRecord(form.family7) : undefined;
    return family7
      ? { id: person.id as string, form: { family7 } }
      : { id: person.id as string };
  });
}

function projectRoles(value: unknown): ScoringRole[] | undefined {
  return asOptionalArray(value)?.map((raw) => {
    const role = asRecord(raw);
    const projected: ScoringRole = {
      personId: role.personId as string,
      role: role.role as ScoringRole['role'],
      sentiment: role.sentiment as ScoringRole['sentiment'],
      confidence: role.confidence as ScoringRole['confidence'],
    };
    if (role.isKeyInfluencer !== undefined) projected.isKeyInfluencer = role.isKeyInfluencer as boolean;
    if (role.procurementType !== undefined) projected.procurementType = role.procurementType as ScoringRole['procurementType'];
    if (role.procurementStatus !== undefined) projected.procurementStatus = role.procurementStatus as ScoringRole['procurementStatus'];
    return projected;
  });
}

function projectBurningIssues(value: unknown): ScoringBurningIssue[] | undefined {
  return asOptionalArray(value)?.map((raw) => {
    const issue = asRecord(raw);
    return {
      id: issue.id as string,
      personId: issue.personId as string,
      confidence: issue.confidence as ScoringBurningIssue['confidence'],
    };
  });
}

function projectUcvs(value: unknown): ScoringUcv[] | undefined {
  return asOptionalArray(value)?.map((raw) => {
    const ucv = asRecord(raw);
    return {
      targetBiId: ucv.targetBiId as string,
      status: ucv.status as ScoringUcv['status'],
    };
  });
}

export function createG64111Adapter(config: G64111RuntimeConfig): G64111Adapter {
  const bindings = validateRuntimeConfig(config);
  const read = (key: string, source: LegacySource): unknown => {
    const binding = bindings.get(key) ?? configurationError(`missing storage binding: ${key}`);
    const reader = LEGACY_PATH_READERS[binding.storageBindingPath]
      ?? configurationError(`unsupported legacy path: ${binding.storageBindingPath}`);
    return reader(source);
  };
  const projectLegacyState = (
    account: ScoringAccount,
    opportunity: ScoringOpportunity & { pipelineStage?: unknown },
  ): G64111LegacyProjection => {
    const source = { account, opportunity };
    return {
      account: {
        persons: projectPersons(read('g64111.person_form_family7', source)),
      },
      opportunity: {
        primaryDPersonId: read('g64111.primary_d', source) as string | null | undefined,
        engageStage: read('g64111.engage_stage', source) as string | null | undefined,
        c3Items: asOptionalRecord(read('g64111.c3_items', source)),
        c5Items: asOptionalRecord(read('g64111.c5_items', source)),
        roles: projectRoles(read('g64111.roles', source)),
        bis: projectBurningIssues(read('g64111.burning_issues', source)),
        ucvs: projectUcvs(read('g64111.unique_value_claims', source)),
      },
      pipelineStage: read('g64111.pipeline_stage', source),
    };
  };

  return Object.freeze({
    engineRef: config.engineRef,
    projectLegacyState,
    buildScoringInput: (account: ScoringAccount, opportunity: LegacyOpportunity) => {
      const projected = projectLegacyState(account, opportunity);
      return engineBuildScoringInput(projected.account, projected.opportunity);
    },
    scoreFromState: (
      account: ScoringAccount,
      opportunity: LegacyOpportunity,
      profile: ScoringProfile = DEFAULT_PROFILE,
    ) => {
      const projected = projectLegacyState(account, opportunity);
      return engineScoreFromState(projected.account, projected.opportunity, profile);
    },
    personContributions: (
      account: ScoringAccount,
      opportunity: LegacyOpportunity,
      profile: ScoringProfile = DEFAULT_PROFILE,
    ) => {
      const projected = projectLegacyState(account, opportunity);
      return enginePersonContributions(projected.account, projected.opportunity, profile);
    },
  });
}

const adapter = createG64111Adapter(G64111_RUNTIME_CONFIG);

export const projectG64111LegacyState = adapter.projectLegacyState;
export const buildScoringInput = adapter.buildScoringInput;
export const scoreFromState = adapter.scoreFromState;
export const personContributions = adapter.personContributions;

/** App domain adapter. All scoring constants and formulas live in @jianghu/g64111. */
export function scoreFromDomain(
  account: Account,
  opportunity: Opportunity,
  profile: ScoringProfile = DEFAULT_PROFILE,
): ScoreBreakdown {
  return adapter.scoreFromState(account, opportunity, profile);
}
