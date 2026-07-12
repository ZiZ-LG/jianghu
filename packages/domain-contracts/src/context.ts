import { z } from 'zod';

export const ActorRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
export const CommandChannelSchema = z.enum(['web', 'mcp', 'worker', 'system']);
export const AssertionModeSchema = z.enum(['user_asserted', 'raw_append', 'machine_proposed']);

export const CommandContextSchema = z.object({
  tenantId: z.string().min(1),
  actorId: z.string().min(1),
  actorRole: ActorRoleSchema,
  channel: CommandChannelSchema,
  requestId: z.string().min(1),
  assertionMode: AssertionModeSchema,
}).strict();

export interface CommandContext {
  tenantId: string;
  actorId: string;
  actorRole: 'owner' | 'admin' | 'member' | 'viewer';
  channel: 'web' | 'mcp' | 'worker' | 'system';
  requestId: string;
  assertionMode: 'user_asserted' | 'raw_append' | 'machine_proposed';
}

export function parseActorRole(value: unknown): CommandContext['actorRole'] {
  return ActorRoleSchema.parse(value);
}
