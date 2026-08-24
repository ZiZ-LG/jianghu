import type { KnowledgeTool, KnowledgeTopic, SeedCandidate } from '../domain';
import { domainLabels, localize, type Language } from '../i18n';
import InternalLink from '../components/InternalLink';
import KnowledgeCard from '../components/KnowledgeCard';

export default function TopicPage({
  topic,
  items,
  tools,
  language,
}: {
  readonly topic: KnowledgeTopic;
  readonly items: readonly SeedCandidate[];
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  const topicItems = topic.itemIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is SeedCandidate => item !== undefined);
  const topicTools = topic.toolIds
    .map((id) => tools.find((tool) => tool.id === id))
    .filter((tool): tool is KnowledgeTool => tool !== undefined);

  return (
    <>
      <article className='topic-detail'>
        <InternalLink className='back-link' href='/topics/'>
          ← {language === 'zh' ? '全部专题' : 'All topics'}
        </InternalLink>
        <div className='domain-tags'>
          {topic.domains.map((domain) => (
            <span key={domain}>{localize(domainLabels[domain], language)}</span>
          ))}
        </div>
        <h1>{localize(topic.title, language)}</h1>
        <p className='lead'>{localize(topic.summary, language)}</p>
        <div className='topic-framework'>
          <section>
            <p className='section-index'>01 · PROBLEM</p>
            <h2>{language === 'zh' ? '问题定义' : 'Problem'}</h2>
            <p>{localize(topic.problemDefinition, language)}</p>
          </section>
          <section>
            <p className='section-index'>02 · CHANGE</p>
            <h2>{language === 'zh' ? '关键变化' : 'Key changes'}</h2>
            <p>{localize(topic.keyChanges, language)}</p>
          </section>
          <section>
            <p className='section-index'>03 · JUDGMENT</p>
            <h2>{language === 'zh' ? '销售判断' : 'Sales judgment'}</h2>
            <p>{localize(topic.salesJudgment, language)}</p>
          </section>
          <section>
            <p className='section-index'>04 · IMPACT</p>
            <h2>{language === 'zh' ? '岗位与组织影响' : 'Role and organization impact'}</h2>
            <p>{localize(topic.roleOrgImpact, language)}</p>
          </section>
        </div>
      </article>

      <section className='section-block' aria-labelledby='topic-tools-title'>
        <div className='section-heading'>
          <p className='section-index'>TOOLS</p>
          <h2 id='topic-tools-title'>{language === 'zh' ? '推荐行动工具' : 'Recommended tools'}</h2>
        </div>
        <div className='link-stack'>
          {topicTools.map((tool) => (
            <InternalLink href={`/tools/#${tool.id}`} key={tool.id}>
              <strong>{localize(tool.title, language)}</strong>
              <span>{localize(tool.scenario, language)}</span>
            </InternalLink>
          ))}
        </div>
      </section>

      <section className='section-block' aria-labelledby='topic-items-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>EVIDENCE</p>
            <h2 id='topic-items-title'>{language === 'zh' ? '相关内容与证据' : 'Related items and evidence'}</h2>
          </div>
          <span className='result-count'>
            {language === 'zh' ? `${topicItems.length} 条可见` : `${topicItems.length} visible`}
          </span>
        </div>
        {topicItems.length > 0 ? (
          <div className='knowledge-grid'>
            {topicItems.map((item) => (
              <KnowledgeCard item={item} language={language} key={item.id} />
            ))}
          </div>
        ) : (
          <div className='empty-state'>
            {language === 'zh'
              ? '该专题当前没有已批准且仍然有效的公开内容。'
              : 'This topic currently has no approved, active public items.'}
          </div>
        )}
      </section>
    </>
  );
}
