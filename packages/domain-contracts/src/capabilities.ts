import { z } from 'zod';

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

export const EntitlementKeySchema = z.enum(ENTITLEMENT_KEYS);
export const PermissionKeySchema = z.enum(PERMISSION_KEYS);
export const TenantDataScopePolicySchema = z.enum(TENANT_DATA_SCOPE_POLICIES);

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

/** Shared fail-closed policy primitive. Resource scope and sensitive ACL remain separate intersections. */
export function capabilityPolicyAllows(policyInput: unknown, requirementInput: unknown): boolean {
  const policy = CapabilityPolicySchema.safeParse(policyInput);
  const requirement = CapabilityRequirementSchema.safeParse(requirementInput);
  if (!policy.success || !requirement.success) return false;

  if (requirement.data.entitlement && !policy.data.entitlements.includes(requirement.data.entitlement)) return false;
  if (requirement.data.permission && !policy.data.permissions.includes(requirement.data.permission)) return false;
  return true;
}
