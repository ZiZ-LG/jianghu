import type { KnowledgeTool, KnowledgeTopic, SeedCandidate } from '../domain';
import { localize, type Language } from '../i18n';
import { selectTodayItems } from '../navigation';
import InternalLink from '../components/InternalLink';
import KnowledgeCard from '../components/KnowledgeCard';
import TopicGrid from '../components/TopicGrid';

export default function TodayPage({
  items,
  topics,
  tools,
  language,
}: {
  readonly items: readonly SeedCandidate[];
  readonly topics: readonly KnowledgeTopic[];
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  const todayItems = selectTodayItems(items, { limit: 5 });

  return (
    <>
      <section className='hero page-hero' aria-labelledby='hero-title'>
        <p className='eyebrow'>
          {language === 'zh'
            ? 'AI 技术 × 大客户销售 × 岗位与组织转型'
            : 'AI Technology × Enterprise Sales × Roles & Organization'}
        </p>
        <h1 id='hero-title'>
          {language === 'zh'
            ? '每天 10 分钟，从可信变化走到可执行动作。'
            : 'Ten minutes a day, from trusted change to action.'}
        </h1>
        <p className='hero-copy'>
          {language === 'zh'
            ? '为正在转向 AI 业务与岗位的传统 To B 销售个人建立的行动型知识库。'
            : 'An action-oriented hub for B2B sellers moving into AI business and roles.'}
        </p>
        <div className='hero-actions'>
          <a className='primary-action' href='/fieldbook/'>
            {language === 'zh' ? '进入完整旧手册' : 'Open the complete fieldbook'}
          </a>
          <InternalLink className='secondary-action' href='/learn/'>
            {language === 'zh' ? '选择学习路径' : 'Choose a learning path'}
          </InternalLink>
        </div>
      </section>

      <section className='section-block' aria-labelledby='today-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>TODAY</p>
            <h2 id='today-title'>{language === 'zh' ? '今日必读' : 'Today'}</h2>
          </div>
          <span className='result-count'>
            {language === 'zh' ? `${todayItems.length} 条精选` : `${todayItems.length} selected`}
          </span>
        </div>
        {todayItems.length > 0 ? (
          <div className='knowledge-grid'>
            {todayItems.map((item) => (
              <KnowledgeCard key={item.id} item={item} language={language} />
            ))}
          </div>
        ) : (
          <div className='empty-state'>
            <strong>{language === 'zh' ? '首批内容仍在人工终审' : 'The seed collection is under human review'}</strong>
            <p>
              {language === 'zh'
                ? '公开集合目前保持为空。内容负责人批准后，首页会展示 3–5 条高价值内容；不会用占位内容凑数。'
                : 'The public collection remains empty. After approval, this page will show 3–5 high-value items without filler.'}
            </p>
          </div>
        )}
      </section>

      <section className='section-block' aria-labelledby='topic-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>RADAR</p>
            <h2 id='topic-title'>{language === 'zh' ? '从持续问题进入' : 'Start with a persistent problem'}</h2>
          </div>
          <InternalLink href='/topics/'>{language === 'zh' ? '查看全部专题' : 'All topics'}</InternalLink>
        </div>
        <TopicGrid topics={topics.slice(0, 3)} language={language} />
      </section>

      <section className='section-block split-block' aria-labelledby='action-title'>
        <div>
          <p className='section-index'>ACTION</p>
          <h2 id='action-title'>{language === 'zh' ? '读完就做一件事' : 'Turn reading into one action'}</h2>
          <p>
            {language === 'zh'
              ? '每个工具都会生成一份只保存在本机的 Markdown 材料。编辑、复制和下载将在 SAAS-603 接通。'
              : 'Each tool produces local-only Markdown. Editing, copy and download arrive in SAAS-603.'}
          </p>
        </div>
        <div className='link-stack'>
          {tools.slice(0, 3).map((tool) => (
            <InternalLink href={`/tools/#${tool.id}`} key={tool.id}>
              <strong>{localize(tool.title, language)}</strong>
              <span>{tool.estimatedMinutes} min</span>
            </InternalLink>
          ))}
        </div>
      </section>
    </>
  );
}
