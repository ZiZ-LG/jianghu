import { createHash } from 'node:crypto';
import type {
  MethodologyActionTemplate,
  MethodologyFieldDefinition,
  MethodologyRoleDefinition,
  MethodologyRuleDefinition,
  MethodologyStageDefinition,
} from '@jianghu/domain-contracts';
import type { MethodologyDefinitionSetInput } from './repository.js';
import { G64111_DEFINITION_MANIFEST, G64111_ENGINE_REF } from './g64111Manifest.js';

type DefinitionSpec<T> = Omit<T, 'id' | 'packId' | 'versionId'>;

export interface BuiltinMethodologyDefinitionManifest {
  fields: readonly DefinitionSpec<MethodologyFieldDefinition>[];
  stages: readonly DefinitionSpec<MethodologyStageDefinition>[];
  roles: readonly DefinitionSpec<MethodologyRoleDefinition>[];
  rules: readonly DefinitionSpec<MethodologyRuleDefinition>[];
  actions: readonly DefinitionSpec<MethodologyActionTemplate>[];
}

export interface BuiltinMethodologyTemplate {
  templateKey: string;
  sourceTemplateRef: string;
  packKey: string;
  name: string;
  versionKey: string;
  engineRef: string;
  learningContentRef: string | null;
  contentHash: string;
  definitions: BuiltinMethodologyDefinitionManifest;
}

const EMPTY_DEFINITIONS: BuiltinMethodologyDefinitionManifest = Object.freeze({
  fields: Object.freeze([]),
  stages: Object.freeze([]),
  roles: Object.freeze([]),
  rules: Object.freeze([]),
  actions: Object.freeze([]),
});

const generalFollowupContent = Object.freeze({
  templateKey: 'general-followup',
  sourceTemplateRef: 'builtin:general-followup:1',
  packKey: 'platform.general_followup',
  versionKey: '1.0.0',
  engineRef: 'none:1',
  capabilities: ['stage-free-followup'],
});

const generalFollowup: BuiltinMethodologyTemplate = Object.freeze({
  templateKey: generalFollowupContent.templateKey,
  sourceTemplateRef: generalFollowupContent.sourceTemplateRef,
  packKey: generalFollowupContent.packKey,
  name: '通用跟进方法',
  versionKey: generalFollowupContent.versionKey,
  engineRef: generalFollowupContent.engineRef,
  learningContentRef: null,
  contentHash: createHash('sha256').update(JSON.stringify(generalFollowupContent)).digest('hex'),
  definitions: EMPTY_DEFINITIONS,
});

const g64111Content = Object.freeze({
  templateKey: 'g64111',
  sourceTemplateRef: 'builtin:g64111:1',
  packKey: 'platform.g64111',
  name: 'G64111 趋赢力',
  versionKey: '1.0.0',
  engineRef: G64111_ENGINE_REF,
  learningContentRef: 'docs:G64111-评分规格.md',
  definitions: G64111_DEFINITION_MANIFEST,
});

const g64111: BuiltinMethodologyTemplate = Object.freeze({
  ...g64111Content,
  contentHash: createHash('sha256').update(JSON.stringify(g64111Content)).digest('hex'),
});

const BUILTIN_TEMPLATES = new Map<string, BuiltinMethodologyTemplate>([
  [generalFollowup.templateKey, generalFollowup],
  [g64111.templateKey, g64111],
]);

/** Platform templates are code-owned manifests. Business rows always receive a tenant-local immutable snapshot. */
export function findBuiltinMethodologyTemplate(templateKey: string): BuiltinMethodologyTemplate | undefined {
  return BUILTIN_TEMPLATES.get(templateKey);
}

function definitionId(versionId: string, kind: string, key: string): string {
  const suffix = createHash('sha256').update(`${versionId}\u0000${kind}\u0000${key}`).digest('hex').slice(0, 32);
  return `methodology${kind}_${suffix}`;
}

/** Instantiate tenant/version-local ids without mutating the code-owned manifest. */
export function instantiateBuiltinMethodologyDefinitions(
  template: BuiltinMethodologyTemplate,
  packId: string,
  versionId: string,
): MethodologyDefinitionSetInput {
  const attach = <T extends { key: string }>(kind: string, definition: T) => ({
    id: definitionId(versionId, kind, definition.key),
    packId,
    versionId,
    ...definition,
  });
  return {
    packId,
    versionId,
    fields: template.definitions.fields.map((definition) => attach('field', definition)),
    stages: template.definitions.stages.map((definition) => attach('stage', definition)),
    roles: template.definitions.roles.map((definition) => attach('role', definition)),
    rules: template.definitions.rules.map((definition) => attach('rule', definition)),
    actions: template.definitions.actions.map((definition) => attach('action', definition)),
  };
}
