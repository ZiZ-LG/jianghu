import { useEffect } from 'react';

import type { KnowledgeTool, KnowledgeTopic, ReviewedKnowledgeItem } from '../domain';
import { domainLabels, isChineseFallback, localize, type Language } from '../i18n';
import { useLibrary } from '../state/LibraryContext';
import EvidenceBadge from '../components/EvidenceBadge';
import InternalLink from '../components/InternalLink';

const factTypeLabels = {
  official_fact: { zh: '官方事实', en: 'Official fact' },
  company_claim: { zh: '企业自述', en: 'Company claim' },
  research_finding: { zh: '研究发现', en: 'Research finding' },
  editorial_inference: { zh: '编辑推断', en: 'Editorial inference' },
} as const;

export default function ItemPage({
  item,
  topics,
  tools,
  language,
}: {
  readonly item: ReviewedKnowledgeItem;
  readonly topics: readonly KnowledgeTopic[];
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  const { state, markRead, toggleBookmark } = useLibrary();
  const bookmarked = state.bookmarkedIds.includes(item.id);
  const relatedTopics = topics.filter((topic) => item.topicSlugs.includes(topic.slug));
  const relatedTools = tools.filter((tool) => item.toolIds.includes(tool.id));
  const date = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'long',
  }).format(new Date(item.publishedAt));

  useEffect(() => markRead(item.id), [item.id, markRead]);

  return (
    <article className='item-detail'>
      <InternalLink className='back-link' href='/radar/'>
        ← {language === 'zh' ? '返回雷达' : 'Back to radar'}
      </InternalLink>
      <div className='card-meta'>
        <div className='domain-tags'>
          {item.domains.map((domain) => (
            <span key={domain}>{localize(domainLabels[domain], language)}</span>
          ))}
        </div>
        <time dateTime={item.publishedAt}>{date}</time>
      </div>
      {item.editorialStatus === 'candidate' && (
        <div className='review-warning' role='status'>
          <strong>{language === 'zh' ? '终审候选 · 尚未公开' : 'Review candidate · not published'}</strong>
          <p>
            {language === 'zh'
              ? '此页面仅在本地开发终审预览模式可见，不属于公开内容集合。'
              : 'This page is visible only in the local review preview and is not part of the public collection.'}
          </p>
        </div>
      )}
      <h1>{localize(item.title, language)}</h1>
      {isChineseFallback(item.title, language) && <span className='language-fallback'>Chinese content</span>}
      {item.originalTitle && <p className='original-title'>{item.originalTitle}</p>}
      <p className='lead'>{localize(item.summary, language)}</p>
      <button
        className='bookmark-detail'
        type='button'
        aria-pressed={bookmarked}
        onClick={() => toggleBookmark(item.id)}
      >
        {bookmarked
          ? (language === 'zh' ? '★ 已收藏' : '★ Bookmarked')
          : (language === 'zh' ? '☆ 收藏这条内容' : '☆ Bookmark this item')}
      </button>

      <div className='item-interpretation'>
        <section>
          <p className='section-index'>WHY</p>
          <h2>{language === 'zh' ? '为什么与你有关' : 'Why it matters'}</h2>
          <p>{localize(item.whyItMatters, language)}</p>
        </section>
        <section>
          <p className='section-index'>SALES</p>
          <h2>{language === 'zh' ? '大客户销售判断' : 'Enterprise-sales judgment'}</h2>
          <p>{localize(item.salesImplication, language)}</p>
        </section>
        <section>
          <p className='section-index'>ROLE & ORG</p>
          <h2>{language === 'zh' ? '岗位与组织影响' : 'Role and organization impact'}</h2>
          <p>{localize(item.roleOrgImplication, language)}</p>
        </section>
        <section className='next-action-panel'>
          <p className='section-index'>ACTION</p>
          <h2>{language === 'zh' ? '下一步行动' : 'Next action'}</h2>
          <p>{localize(item.nextAction, language)}</p>
        </section>
      </div>

      <section className='analysis-evidence' aria-labelledby='analysis-evidence-title'>
        <div className='supporting-facts'>
          <p className='section-index'>TWO-FACT CHECK</p>
          <h2 id='analysis-evidence-title'>
            {language === 'zh' ? '至少两项事实支撑' : 'At least two supporting facts'}
          </h2>
          <ol>
            {item.supportingFacts.map((fact) => (
              <li key={fact.id}>{fact.statement}</li>
            ))}
          </ol>
        </div>
        <div className='deeper-analysis'>
          <p className='section-index'>ONE LEVEL DEEPER</p>
          <h2>{language === 'zh' ? '再深一层的价值分析' : 'One-level-deeper value analysis'}</h2>
          <dl>
            <div>
              <dt>{language === 'zh' ? '为什么会发生' : 'Mechanism'}</dt>
              <dd>{item.deeperAnalysis.mechanism}</dd>
            </div>
            <div>
              <dt>{language === 'zh' ? '为业务带来什么' : 'Business value'}</dt>
              <dd>{item.deeperAnalysis.businessValue}</dd>
            </div>
            <div>
              <dt>{language === 'zh' ? '何时不成立' : 'Boundary'}</dt>
              <dd>{item.deeperAnalysis.boundary}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className='evidence-section' aria-labelledby='evidence-title'>
        <div>
          <p className='section-index'>EVIDENCE</p>
          <h2 id='evidence-title'>{language === 'zh' ? '证据与归属' : 'Evidence and attribution'}</h2>
          <p>
            {factTypeLabels[item.review.factType][language]} · {language === 'zh' ? `风险等级：${item.riskLevel}` : `Risk: ${item.riskLevel}`}
          </p>
        </div>
        <div className='evidence-list'>
          {item.evidence.map((evidence) => (
            <a href={evidence.url} target='_blank' rel='noreferrer' key={evidence.id}>
              <EvidenceBadge level={evidence.level} language={language} />
              <strong>{evidence.title}</strong>
              <span>{evidence.publisher} · {evidence.publishedAt.slice(0, 10)}</span>
            </a>
          ))}
        </div>
        <p className='verification-note'>
          <strong>{language === 'zh' ? '核验说明：' : 'Verification note: '}</strong>
          {item.review.verificationNotes}
        </p>
      </section>

      <section className='related-grid'>
        <div>
          <h2>{language === 'zh' ? '相关专题' : 'Related topics'}</h2>
          <div className='link-stack'>
            {relatedTopics.map((topic) => (
              <InternalLink href={`/topics/${topic.slug}/`} key={topic.slug}>
                <strong>{localize(topic.title, language)}</strong>
                <span>{localize(topic.summary, language)}</span>
              </InternalLink>
            ))}
          </div>
        </div>
        <div>
          <h2>{language === 'zh' ? '相关工具' : 'Related tools'}</h2>
          <div className='link-stack'>
            {relatedTools.map((tool) => (
              <InternalLink href={`/tools/#${tool.id}`} key={tool.id}>
                <strong>{localize(tool.title, language)}</strong>
                <span>{tool.estimatedMinutes} min</span>
              </InternalLink>
            ))}
          </div>
        </div>
      </section>

      <section className='feedback-callout'>
        <div>
          <p className='section-index'>CORRECTION</p>
          <h2>{language === 'zh' ? '发现事实错误、失效链接或版权问题？' : 'Found a factual error, broken link or rights issue?'}</h2>
        </div>
        <InternalLink className='secondary-action' href='/policy/#correction'>
          {language === 'zh' ? '提交纠错' : 'Submit a correction'}
        </InternalLink>
      </section>
    </article>
  );
}
