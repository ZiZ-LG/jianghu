import { useMemo, useState } from 'react';

import {
  KNOWLEDGE_DOMAINS,
  type KnowledgeDomain,
  type KnowledgeTopic,
  type SeedCandidate,
} from '../domain';
import { domainLabels, localize, type Language } from '../i18n';
import { filterKnowledgeItems } from '../navigation';
import { searchKnowledge } from '../state/search';
import Filters from '../components/Filters';
import InternalLink from '../components/InternalLink';
import KnowledgeCard from '../components/KnowledgeCard';
import TopicGrid from '../components/TopicGrid';

export default function RadarPage({
  items,
  topics,
  language,
  query,
}: {
  readonly items: readonly SeedCandidate[];
  readonly topics: readonly KnowledgeTopic[];
  readonly language: Language;
  readonly query: string;
}) {
  const [selectedDomains, setSelectedDomains] = useState<KnowledgeDomain[]>([]);
  const [mode, setMode] = useState<'and' | 'or'>('and');
  const searchedItems = useMemo(
    () => searchKnowledge(items, query),
    [items, query],
  );
  const filteredItems = useMemo(
    () => filterKnowledgeItems(searchedItems, { domains: selectedDomains, mode }),
    [mode, searchedItems, selectedDomains],
  );

  const toggleDomain = (domain: KnowledgeDomain) => {
    setSelectedDomains((current) => current.includes(domain)
      ? current.filter((value) => value !== domain)
      : [...current, domain]);
  };

  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>RADAR</p>
        <h1>{language === 'zh' ? '三域不是分类，是同一个业务问题的三个视角。' : 'Three lenses on the same business problem.'}</h1>
        <p>
          {language === 'zh'
            ? '同时查看技术事实、复杂销售判断和岗位与组织影响，避免只追热点或只背销售话术。'
            : 'Connect technical facts, enterprise-sales judgment and organizational impact.'}
        </p>
      </section>

      <section className='domain-overview' aria-label={language === 'zh' ? '三域概览' : 'Domain overview'}>
        {KNOWLEDGE_DOMAINS.map((domain) => (
          <article key={domain}>
            <span>{items.filter((item) => item.domains.includes(domain)).length}</span>
            <h2>{localize(domainLabels[domain], language)}</h2>
            <p>
              {domain === 'ai_technology' && (language === 'zh' ? '能力、限制、成本、数据与生产控制。' : 'Capability, limits, cost, data and production controls.')}
              {domain === 'enterprise_sales' && (language === 'zh' ? '客户问题、价值证据、决策链与扩展门。' : 'Customer problem, value evidence, committee and scale gates.')}
              {domain === 'role_org' && (language === 'zh' ? '岗位结果、工作流、治理与采用。' : 'Role outcomes, workflow, governance and adoption.')}
            </p>
          </article>
        ))}
      </section>

      <Filters
        language={language}
        selectedDomains={selectedDomains}
        mode={mode}
        onToggleDomain={toggleDomain}
        onModeChange={setMode}
        onClear={() => setSelectedDomains([])}
      />

      {query && (
        <p className='active-query' role='status'>
          {language === 'zh' ? '当前搜索：' : 'Current search: '}
          <strong>{query}</strong>
        </p>
      )}

      <section className='section-block' aria-labelledby='radar-result-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>SIGNALS</p>
            <h2 id='radar-result-title'>{language === 'zh' ? '内容信号' : 'Knowledge signals'}</h2>
          </div>
          <span className='result-count'>
            {language === 'zh' ? `${filteredItems.length} 条` : `${filteredItems.length} items`}
          </span>
        </div>
        {filteredItems.length > 0 ? (
          <div className='knowledge-grid'>
            {filteredItems.map((item) => (
              <KnowledgeCard key={item.id} item={item} language={language} />
            ))}
          </div>
        ) : (
          <div className='empty-state'>
            <strong>{language === 'zh' ? '当前没有可公开内容' : 'No public item matches yet'}</strong>
            <p>
              {query
                ? (language === 'zh' ? '尝试更短的关键词、原文岗位标题，或清除搜索。' : 'Try a shorter keyword, an original job title, or clear search.')
                : selectedDomains.length > 0
                ? (language === 'zh' ? '尝试清除筛选或切换 AND / OR。' : 'Clear filters or switch AND / OR.')
                : (language === 'zh' ? '首批 30 条仍在项目所有者终审。' : 'The first 30 items remain under owner review.')}
            </p>
          </div>
        )}
      </section>

      <section className='section-block' aria-labelledby='all-topic-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>TOPICS</p>
            <h2 id='all-topic-title'>{language === 'zh' ? '六个交叉专题' : 'Six cross-domain topics'}</h2>
          </div>
          <InternalLink href='/roles/'>{language === 'zh' ? '查看岗位与组织' : 'Roles & organization'}</InternalLink>
        </div>
        <TopicGrid topics={topics} language={language} />
      </section>
    </>
  );
}
