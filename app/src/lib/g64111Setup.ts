import {
  G64111_BUILTIN_TEMPLATE_KEY,
  MethodologyCommandSchema,
  isG64111Active,
  isG64111LifecycleEligible,
  type G64111MethodologyMatter,
  type G64111MethodologyReadModel,
  type MethodologyCommand,
} from '@jianghu/domain-contracts';
import { createOpaqueEntityId } from './opaqueId';

type IdFactory = (prefix: string) => string;
export type G64111SetupCommand = Exclude<MethodologyCommand, { type: 'ASSIGN_METHODOLOGY_PILOT' }>;

function assertCommandsAllowed(model: G64111MethodologyReadModel): void {
  if (!model.commandsEnabled || !model.canManage) throw new Error('methodology commands are unavailable');
}

function exactMatter(
  model: G64111MethodologyReadModel,
  customerId: string,
  matterId: string,
): G64111MethodologyMatter {
  const matter = model.matters.find((candidate) => (
    candidate.customerId === customerId && candidate.matterId === matterId
  ));
  if (!matter) throw new Error('Matter is outside the current methodology projection');
  return matter;
}

export function g64111BoundMatterIds(model: G64111MethodologyReadModel): ReadonlySet<string> {
  return new Set(model.matters
    .filter((matter) => isG64111Active(matter.activeBinding))
    .map((matter) => matter.matterId));
}

export function buildG64111InstallCommand(
  createId: IdFactory = createOpaqueEntityId,
): G64111SetupCommand {
  return MethodologyCommandSchema.parse({
    type: 'MATERIALIZE_BUILTIN_METHODOLOGY',
    templateKey: G64111_BUILTIN_TEMPLATE_KEY,
    packId: createId('methodologypack'),
    versionId: createId('methodologyversion'),
  }) as G64111SetupCommand;
}

export function buildG64111BindCommand(
  model: G64111MethodologyReadModel,
  customerId: string,
  matterId: string,
  createId: IdFactory = createOpaqueEntityId,
): G64111SetupCommand {
  assertCommandsAllowed(model);
  if (!model.installation) throw new Error('G64111 is not installed');
  const matter = exactMatter(model, customerId, matterId);
  if (!isG64111LifecycleEligible(matter.lifecycleStatus)) {
    throw new Error('Matter lifecycle does not allow G64111 activation');
  }
  if (isG64111Active(matter.activeBinding)) throw new Error('G64111 is already active');
  return MethodologyCommandSchema.parse({
    type: 'ACTIVATE_METHODOLOGY_BINDING',
    bindingId: createId('methodologybinding'),
    customerId,
    matterId,
    versionId: model.installation.versionId,
    baseMatterVersion: matter.matterVersion,
    expectedActiveBindingId: matter.activeBinding?.bindingId ?? null,
    decisionProfileRef: null,
  }) as G64111SetupCommand;
}

export function buildG64111UnbindCommand(
  model: G64111MethodologyReadModel,
  customerId: string,
  matterId: string,
): G64111SetupCommand {
  assertCommandsAllowed(model);
  const matter = exactMatter(model, customerId, matterId);
  if (!isG64111Active(matter.activeBinding)) throw new Error('G64111 is not active');
  return MethodologyCommandSchema.parse({
    type: 'UNBIND_METHODOLOGY',
    customerId,
    matterId,
    baseMatterVersion: matter.matterVersion,
    expectedActiveBindingId: matter.activeBinding!.bindingId,
  }) as G64111SetupCommand;
}
