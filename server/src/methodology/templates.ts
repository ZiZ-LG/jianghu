import { createHash } from 'node:crypto';

export interface BuiltinMethodologyTemplate {
  templateKey: string;
  sourceTemplateRef: string;
  packKey: string;
  name: string;
  versionKey: string;
  engineRef: string;
  learningContentRef: string | null;
  contentHash: string;
}

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
});

const BUILTIN_TEMPLATES = new Map<string, BuiltinMethodologyTemplate>([
  [generalFollowup.templateKey, generalFollowup],
]);

/** Platform templates are code-owned manifests. Business rows always receive a tenant-local immutable snapshot. */
export function findBuiltinMethodologyTemplate(templateKey: string): BuiltinMethodologyTemplate | undefined {
  return BUILTIN_TEMPLATES.get(templateKey);
}
