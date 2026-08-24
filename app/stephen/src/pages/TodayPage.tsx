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
          <div className='heading-actions'>
            <span className='result-count'>
              {language === 'zh' ? `${todayItems.length} 条精选` : `${todayItems.length} selected`}
            </span>
            <InternalLink href='/digest/'>
              {language === 'zh' ? '日报与周报' : 'Daily & weekly digests'}
            </InternalLink>
          </div>
        </div>
        {todayItems.length > 0 ? (
          <div className='knowledge-grid'>
            {todayItems.map((item) => (
              <KnowledgeCard key={item.id} item={item} language={language} />
            ))}
          </div>
        ) : (
          <div className='empty-state'>
            <strong>{language === 'zh' ? '当前没有可公开内容' : 'No public items are available'}</strong>
            <p>
              {language === 'zh'
                ? '首页只展示已经批准且仍然有效的内容；内容不足时保持空白，不用占位条目凑数。'
                : 'This page shows only approved, current items and stays empty instead of padding the edition.'}
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
              ? '每个工具都会生成一份只保存在当前浏览器的 Markdown 材料，可继续编辑、复制和下载。'
              : 'Each tool creates a browser-local Markdown artifact you can keep editing, copy or download.'}
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
