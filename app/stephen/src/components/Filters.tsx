import { KNOWLEDGE_DOMAINS, type KnowledgeDomain } from '../domain';
import { domainLabels, localize, type Language } from '../i18n';

export default function Filters({
  language,
  selectedDomains,
  mode,
  onToggleDomain,
  onModeChange,
  onClear,
}: {
  readonly language: Language;
  readonly selectedDomains: readonly KnowledgeDomain[];
  readonly mode: 'and' | 'or';
  readonly onToggleDomain: (domain: KnowledgeDomain) => void;
  readonly onModeChange: (mode: 'and' | 'or') => void;
  readonly onClear: () => void;
}) {
  return (
    <section className='filters-panel' aria-labelledby='filter-title'>
      <div>
        <h2 id='filter-title'>{language === 'zh' ? '交叉筛选' : 'Cross-domain filters'}</h2>
        <p>
          {language === 'zh'
            ? '选择多个领域后，明确使用“同时满足”或“任一满足”。'
            : 'Choose whether selected domains must all match or any may match.'}
        </p>
      </div>
      <fieldset>
        <legend>{language === 'zh' ? '知识领域' : 'Knowledge domains'}</legend>
        <div className='filter-options'>
          {KNOWLEDGE_DOMAINS.map((domain) => (
            <label key={domain}>
              <input
                type='checkbox'
                checked={selectedDomains.includes(domain)}
                onChange={() => onToggleDomain(domain)}
              />
              <span>{localize(domainLabels[domain], language)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className='filter-mode' aria-label={language === 'zh' ? '筛选模式' : 'Filter mode'}>
        <button type='button' aria-pressed={mode === 'and'} onClick={() => onModeChange('and')}>
          {language === 'zh' ? '同时满足 AND' : 'Match all AND'}
        </button>
        <button type='button' aria-pressed={mode === 'or'} onClick={() => onModeChange('or')}>
          {language === 'zh' ? '任一满足 OR' : 'Match any OR'}
        </button>
        <button type='button' className='clear-filter' onClick={onClear}>
          {language === 'zh' ? '清除' : 'Clear'}
        </button>
      </div>
    </section>
  );
}
