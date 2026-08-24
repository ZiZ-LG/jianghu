import type { KnowledgeTopic } from '../domain';
import { domainLabels, localize, type Language } from '../i18n';
import InternalLink from './InternalLink';

export default function TopicGrid({
  topics,
  language,
}: {
  readonly topics: readonly KnowledgeTopic[];
  readonly language: Language;
}) {
  return (
    <div className='topic-grid'>
      {topics.map((topic) => (
        <article className='topic-card' key={topic.slug}>
          <div className='domain-tags'>
            {topic.domains.map((domain) => (
              <span key={domain}>{localize(domainLabels[domain], language)}</span>
            ))}
          </div>
          <h3>
            <InternalLink href={`/topics/${encodeURIComponent(topic.slug)}/`}>
              {localize(topic.title, language)}
            </InternalLink>
          </h3>
          <p>{localize(topic.summary, language)}</p>
          <small>
            {language === 'zh'
              ? `${topic.itemIds.length} 条关联内容 · ${topic.toolIds.length} 个工具`
              : `${topic.itemIds.length} related items · ${topic.toolIds.length} tools`}
          </small>
        </article>
      ))}
    </div>
  );
}
