import type { KnowledgeTopic } from '../domain';
import type { Language } from '../i18n';
import InternalLink from '../components/InternalLink';
import TopicGrid from '../components/TopicGrid';

export default function TopicsPage({
  topics,
  language,
}: {
  readonly topics: readonly KnowledgeTopic[];
  readonly language: Language;
}) {
  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>CROSS-DOMAIN TOPICS</p>
        <h1>{language === 'zh' ? '用持续问题组织知识，而不是追逐孤立新闻。' : 'Organize knowledge around persistent questions.'}</h1>
        <p>
          {language === 'zh'
            ? '每个专题都包含问题定义、关键变化、销售判断、岗位与组织影响、行动工具和证据。'
            : 'Each topic connects the problem, changes, sales judgment, organizational impact, tools and evidence.'}
        </p>
        <InternalLink className='text-link' href='/radar/'>
          {language === 'zh' ? '返回三域雷达' : 'Back to radar'}
        </InternalLink>
      </section>
      <section className='section-block'>
        <TopicGrid topics={topics} language={language} />
      </section>
    </>
  );
}
