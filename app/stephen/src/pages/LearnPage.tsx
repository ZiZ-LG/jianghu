import type { Language } from '../i18n';
import InternalLink from '../components/InternalLink';

const paths = [
  {
    days: 1,
    zh: '建立三域地图',
    en: 'Map the three domains',
    zhBody: '读今日精选，完成一份 AI 公司与目标岗位研究画布。',
    enBody: 'Read today’s selection and complete one company and role research canvas.',
    toolId: 'company-role-research',
  },
  {
    days: 7,
    zh: '从变化走到价值假设',
    en: 'Move from change to value',
    zhBody: '围绕一个客户问题，完成发现访谈、成熟度扫描和价值假设。',
    enBody: 'Work one customer problem through discovery, maturity and value hypothesis.',
    toolId: 'value-hypothesis-one-pager',
  },
  {
    days: 30,
    zh: '形成 AI 商业岗位能力证据',
    en: 'Build evidence for an AI commercial role',
    zhBody: '对照岗位原页补齐能力差距，并完成 POC 与组织采用材料。',
    enBody: 'Close role gaps and build POC and adoption artifacts against original job evidence.',
    toolId: 'transition-evidence',
  },
  {
    days: 90,
    zh: '建立持续更新的个人作业系统',
    en: 'Build a durable personal operating system',
    zhBody: '持续更新专题、复盘工具材料，并把证据用于求职、客户研究或业务推进。',
    enBody: 'Refresh topics and artifacts for job transition, account research or opportunity work.',
    toolId: 'stakeholder-adoption-risk',
  },
] as const;

export default function LearnPage({ language }: { readonly language: Language }) {
  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>LEARNING PATHS</p>
        <h1>{language === 'zh' ? '按你现在要完成的工作选择路径。' : 'Choose a path by the work you need to finish.'}</h1>
        <p>
          {language === 'zh'
            ? '新知识库使用 1 / 7 / 30 / 90 天路径；完整旧手册中的 3 / 7 / 14 / 30 天任务保持原样。'
            : 'The new hub uses 1 / 7 / 30 / 90 days. The fieldbook keeps its original 3 / 7 / 14 / 30 day tasks.'}
        </p>
      </section>

      <section className='path-grid' aria-label={language === 'zh' ? '学习路径' : 'Learning paths'}>
        {paths.map((path) => (
          <article className='path-card' key={path.days}>
            <span className='path-days'>{path.days}</span>
            <small>{language === 'zh' ? '天' : path.days === 1 ? 'day' : 'days'}</small>
            <h2>{language === 'zh' ? path.zh : path.en}</h2>
            <p>{language === 'zh' ? path.zhBody : path.enBody}</p>
            <InternalLink href={`/tools/#${path.toolId}`}>
              {language === 'zh' ? '从第一个工具开始 →' : 'Start with the first tool →'}
            </InternalLink>
          </article>
        ))}
      </section>

      <section className='section-block split-block'>
        <div>
          <p className='section-index'>FIELD­BOOK</p>
          <h2>{language === 'zh' ? '需要系统准备 AI 销售面试？' : 'Preparing systematically for an AI sales interview?'}</h2>
          <p>
            {language === 'zh'
              ? '旧手册完整保留 8 个模块、32 个术语、45 项任务和 28 道问题，不被新路径改写。'
              : 'The fieldbook preserves 8 modules, 32 terms, 45 tasks and 28 questions unchanged.'}
          </p>
        </div>
        <a className='fieldbook-card' href='/fieldbook/'>
          <span>AI SALES FIELD­BOOK</span>
          <strong>{language === 'zh' ? '进入完整手册' : 'Open the complete fieldbook'}</strong>
          <small>8 modules · 32 terms · 45 tasks</small>
        </a>
      </section>
    </>
  );
}
