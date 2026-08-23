import type { EvidenceLevel } from '../domain';
import type { Language } from '../i18n';

const labels: Readonly<Record<EvidenceLevel, { readonly zh: string; readonly en: string }>> = {
  official: { zh: '官方原始来源', en: 'Official source' },
  multi_source: { zh: '多源交叉', en: 'Multiple sources' },
  single_source: { zh: '单一来源', en: 'Single source' },
  practitioner_opinion: { zh: '从业者观点', en: 'Practitioner view' },
  editorial_inference: { zh: '编辑推断', en: 'Editorial inference' },
};

export default function EvidenceBadge({
  level,
  language,
}: {
  readonly level: EvidenceLevel;
  readonly language: Language;
}) {
  return (
    <span className={`evidence-badge evidence-${level}`}>
      {labels[level][language]}
    </span>
  );
}
