import { z } from 'zod';
import type { ActionType } from './actions.js';

export const ENTITLEMENT_KEYS = [
  'crm.core',
  'sales.workspace',
  'team.operations',
  'methodology.center',
  'methodology.g64111',
  'decision.pde',
] as const;

export const PERMISSION_KEYS = [
  'portfolio.read',
  'coaching.manage',
  'commitment.assign',
  'source.read_shared',
  'candidate.review_shared',
  'data.read_all',
] as const;

export const TENANT_DATA_SCOPE_POLICIES = [
  'legacy_tenant_shared',
  'scoped',
] as const;

export const PRODUCT_EDITIONS = ['commercial', 'internal'] as const;

export const PRODUCT_ENTRY_IDS = [
  'today',
  'customers',
  'matters',
  'quick-capture',
  'sales-workspace',
  'team',
  'g64111',
  'pde',
] as const;

export const EntitlementKeySchema = z.enum(ENTITLEMENT_KEYS);
export const PermissionKeySchema = z.enum(PERMISSION_KEYS);
export const TenantDataScopePolicySchema = z.enum(TENANT_DATA_SCOPE_POLICIES);
export const ProductEditionSchema = z.enum(PRODUCT_EDITIONS);
export const ProductEntryIdSchema = z.enum(PRODUCT_ENTRY_IDS);

const unique = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

export const CapabilityPolicySchema = z.object({
  entitlements: z.array(EntitlementKeySchema),
  permissions: z.array(PermissionKeySchema),
}).strict().superRefine((value, ctx) => {
  if (!unique(value.entitlements)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entitlements'], message: 'duplicate entitlement key' });
  }
  if (!unique(value.permissions)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['permissions'], message: 'duplicate permission key' });
  }
});

export const CapabilityRequirementSchema = z.object({
  entitlement: EntitlementKeySchema.optional(),
  permission: PermissionKeySchema.optional(),
}).strict().refine(
  (value) => value.entitlement !== undefined || value.permission !== undefined,
  'capability requirement must name an entitlement or permission',
);

export type EntitlementKey = z.infer<typeof EntitlementKeySchema>;
export type PermissionKey = z.infer<typeof PermissionKeySchema>;
export type TenantDataScopePolicy = z.infer<typeof TenantDataScopePolicySchema>;
export type CapabilityPolicy = z.infer<typeof CapabilityPolicySchema>;
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;
export type ProductEdition = z.infer<typeof ProductEditionSchema>;
export type ProductEntryId = z.infer<typeof ProductEntryIdSchema>;

export interface ProductEntryDefinition {
  id: ProductEntryId;
  label: string;
  path: string;
  title: string;
  description: string;
  requirement: CapabilityRequirement;
}

export const ProductEntryDefinitionSchema: z.ZodType<ProductEntryDefinition> = z.object({
  id: ProductEntryIdSchema,
  label: z.string().trim().min(1),
  path: z.string().startsWith('/'),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  requirement: CapabilityRequirementSchema,
}).strict();

export const PRODUCT_ENTRY_REGISTRY: readonly ProductEntryDefinition[] = Object.freeze([
  {
    id: 'matters', label: '商机', path: '/matters', title: '商机',
    description: '看清客户为什么买、谁能推动，以及下一步该做什么。', requirement: { entitlement: 'crm.core' },
  },
  {
    id: 'today', label: '今日', path: '/today', title: '今日',
    description: '集中查看今天需要关注的客户与事项。', requirement: { entitlement: 'crm.core' },
  },
  {
    id: 'customers', label: '客户', path: '/customers', title: '客户',
    description: '统一查看和管理客户档案。', requirement: { entitlement: 'crm.core' },
  },
  {
    id: 'quick-capture', label: '快速记录', path: '/quick-capture', title: '快速记录',
    description: '从客户或事项开始，留下下一步记录。', requirement: { entitlement: 'crm.core' },
  },
  {
    id: 'sales-workspace', label: '复杂销售', path: '/sales', title: '复杂销售',
    description: '进入干系人作战地图与复杂销售工作台。', requirement: { entitlement: 'sales.workspace' },
  },
  {
    id: 'team', label: '团队', path: '/team', title: '团队',
    description: '管理团队成员与协作设置。', requirement: { entitlement: 'team.operations' },
  },
  {
    id: 'g64111', label: 'G64111', path: '/g64111', title: 'G64111',
    description: '打开 G64111 方法论与趋赢力工具。', requirement: { entitlement: 'methodology.g64111' },
  },
  {
    id: 'pde', label: 'PDE', path: '/pde', title: 'PDE',
    description: '打开 PDE 决策评估与行动排序。', requirement: { entitlement: 'decision.pde' },
  },
]);

const ProductAccessConfigSchema = z.object({
  edition: ProductEditionSchema,
  enabledEntitlements: z.array(EntitlementKeySchema).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.enabledEntitlements && !unique(value.enabledEntitlements)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['enabledEntitlements'], message: 'duplicate entitlement key' });
  }
});

export interface ProductAccess {
  valid: boolean;
  edition: ProductEdition | null;
  shell: 'commercial' | 'internal_legacy';
  policy: CapabilityPolicy;
  navigation: readonly ProductEntryDefinition[];
}

export const ProductAccessSchema: z.ZodType<ProductAccess> = z.object({
  valid: z.boolean(),
  edition: ProductEditionSchema.nullable(),
  shell: z.enum(['commercial', 'internal_legacy']),
  policy: CapabilityPolicySchema,
  navigation: z.array(ProductEntryDefinitionSchema),
}).strict().superRefine((value, ctx) => {
  if (!value.valid) {
    if (value.edition !== null
      || value.shell !== 'commercial'
      || value.policy.entitlements.length !== 0
      || value.policy.permissions.length !== 0
      || value.navigation.length !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid product access must grant nothing' });
    }
    return;
  }
  if (value.edition === 'internal') {
    if (value.shell !== 'internal_legacy'
      || value.navigation.length !== 0
      || ENTITLEMENT_KEYS.some((key) => !value.policy.entitlements.includes(key))
      || PERMISSION_KEYS.some((key) => !value.policy.permissions.includes(key))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'internal product access is inconsistent' });
    }
    return;
  }
  if (value.edition !== 'commercial'
    || value.shell !== 'commercial'
    || !value.policy.entitlements.includes('crm.core')
    || value.policy.permissions.length !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'commercial product access is inconsistent' });
    return;
  }
  const expectedNavigation = PRODUCT_ENTRY_REGISTRY
    .filter((entry) => capabilityPolicyAllows(value.policy, entry.requirement));
  if (JSON.stringify(value.navigation) !== JSON.stringify(expectedNavigation)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['navigation'], message: 'product navigation does not match policy' });
  }
});

const ACTION_ENTITLEMENTS: Record<ActionType, EntitlementKey> = {
  ADD_ACCOUNT: 'crm.core',
  UPDATE_ACCOUNT: 'crm.core',
  DELETE_ACCOUNT: 'crm.core',
  ADD_PERSON: 'crm.core',
  UPDATE_PERSON: 'crm.core',
  MOVE_PERSON: 'crm.core',
  DELETE_PERSON: 'crm.core',
  ADD_LOG: 'crm.core',
  ADD_EDGE: 'crm.core',
  UPDATE_EDGE: 'crm.core',
  DELETE_EDGE: 'crm.core',
  ADD_VISIT: 'crm.core',
  UPDATE_VISIT: 'crm.core',
  DELETE_VISIT: 'crm.core',
  ADD_NOTE: 'crm.core',
  UPDATE_NOTE: 'crm.core',
  DELETE_NOTE: 'crm.core',
  ADD_OPP: 'sales.workspace',
  UPDATE_OPP: 'sales.workspace',
  DELETE_OPP: 'sales.workspace',
  ADD_OPP_MEMBER: 'sales.workspace',
  REMOVE_OPP_MEMBER: 'sales.workspace',
  ADD_PLAN_ACTION: 'sales.workspace',
  UPDATE_PLAN_ACTION: 'sales.workspace',
  DELETE_PLAN_ACTION: 'sales.workspace',
  TOGGLE_PLAN_ACTION: 'sales.workspace',
  ADD_MILESTONE: 'sales.workspace',
  UPDATE_MILESTONE: 'sales.workspace',
  DELETE_MILESTONE: 'sales.workspace',
  ADD_OPP_STAGE: 'sales.workspace',
  UPDATE_OPP_STAGE: 'sales.workspace',
  DELETE_OPP_STAGE: 'sales.workspace',
  ADD_STRATEGY_CARD: 'sales.workspace',
  UPDATE_STRATEGY_CARD: 'sales.workspace',
  DELETE_STRATEGY_CARD: 'sales.workspace',
  ADD_STRATEGY_RISK: 'sales.workspace',
  UPDATE_STRATEGY_RISK: 'sales.workspace',
  DELETE_STRATEGY_RISK: 'sales.workspace',
  ADD_STRATEGY_RESOURCE: 'sales.workspace',
  UPDATE_STRATEGY_RESOURCE: 'sales.workspace',
  DELETE_STRATEGY_RESOURCE: 'sales.workspace',
  ADD_EVIDENCE: 'sales.workspace',
  DELETE_EVIDENCE: 'sales.workspace',
  SET_ROLE: 'methodology.g64111',
  REMOVE_ROLE: 'methodology.g64111',
  ADD_BI: 'methodology.g64111',
  UPDATE_BI: 'methodology.g64111',
  DELETE_BI: 'methodology.g64111',
  ADD_UCV: 'methodology.g64111',
  UPDATE_UCV: 'methodology.g64111',
  DELETE_UCV: 'methodology.g64111',
};

/** Explicit legacy Action ownership; unknown future actions receive no grant. */
export function capabilityRequirementForActionType(actionType: unknown): CapabilityRequirement | null {
  if (typeof actionType !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_ENTITLEMENTS, actionType)) return null;
  return { entitlement: ACTION_ENTITLEMENTS[actionType as ActionType] };
}

/**
 * One assembly point for product edition, navigation, and service entitlement policy.
 * Malformed runtime configuration produces no grants so callers can fail closed.
 */
export function assembleProductAccess(input: unknown): ProductAccess {
  const parsed = ProductAccessConfigSchema.safeParse(input);
  if (!parsed.success) {
    return ProductAccessSchema.parse({
      valid: false,
      edition: null,
      shell: 'commercial',
      policy: { entitlements: [], permissions: [] },
      navigation: [],
    });
  }
  if (parsed.data.edition === 'internal') {
    return ProductAccessSchema.parse({
      valid: true,
      edition: 'internal',
      shell: 'internal_legacy',
      policy: { entitlements: [...ENTITLEMENT_KEYS], permissions: [...PERMISSION_KEYS] },
      navigation: [],
    });
  }

  const entitlements = [
    'crm.core' as const,
    ...(parsed.data.enabledEntitlements ?? []).filter((key) => key !== 'crm.core'),
  ];
  const policy: CapabilityPolicy = { entitlements, permissions: [] };
  return ProductAccessSchema.parse({
    valid: true,
    edition: 'commercial',
    shell: 'commercial',
    policy,
    navigation: PRODUCT_ENTRY_REGISTRY.filter((entry) => capabilityPolicyAllows(policy, entry.requirement)),
  });
}

/** Shared fail-closed policy primitive. Resource scope and sensitive ACL remain separate intersections. */
export function capabilityPolicyAllows(policyInput: unknown, requirementInput: unknown): boolean {
  const policy = CapabilityPolicySchema.safeParse(policyInput);
  const requirement = CapabilityRequirementSchema.safeParse(requirementInput);
  if (!policy.success || !requirement.success) return false;

  if (requirement.data.entitlement && !policy.data.entitlements.includes(requirement.data.entitlement)) return false;
  if (requirement.data.permission && !policy.data.permissions.includes(requirement.data.permission)) return false;
  return true;
}
