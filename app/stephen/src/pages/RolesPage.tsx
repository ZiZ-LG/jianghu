import type { ReviewedKnowledgeItem } from '../domain';
import type { Language } from '../i18n';
import InternalLink from '../components/InternalLink';
import KnowledgeCard from '../components/KnowledgeCard';

export default function RolesPage({
  items,
  language,
}: {
  readonly items: readonly ReviewedKnowledgeItem[];
  readonly language: Language;
}) {
  const roleItems = items.filter((item) =>
    item.seedCategory === 'ai_role_change' || item.seedCategory === 'org_adoption');

  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>ROLES & ORGANIZATION</p>
        <h1>{language === 'zh' ? '岗位名称只是入口，真正变化的是工作结果与协作边界。' : 'Job titles are only the entry point; outcomes and boundaries are changing.'}</h1>
        <p>
          {language === 'zh'
            ? '用官方招聘原页和组织研究理解 AI Architect、FDE、部署、售前项目、教育与 AgentOps 等新分工。'
            : 'Use original job pages and organizational research to understand emerging AI commercial roles.'}
        </p>
        <div className='hero-actions'>
          <InternalLink className='primary-action' href='/tools/#company-role-research'>
            {language === 'zh' ? '开始岗位研究' : 'Start role research'}
          </InternalLink>
          <InternalLink className='secondary-action' href='/learn/'>
            {language === 'zh' ? '查看转岗路径' : 'View transition path'}
          </InternalLink>
        </div>
      </section>

      <section className='section-block'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>ROLE SIGNALS</p>
            <h2>{language === 'zh' ? '岗位与组织信号' : 'Role and organization signals'}</h2>
          </div>
          <span className='result-count'>
            {language === 'zh' ? `${roleItems.length} 条可见` : `${roleItems.length} visible`}
          </span>
        </div>
        {roleItems.length > 0 ? (
          <div className='knowledge-grid'>
            {roleItems.map((item) => (
              <KnowledgeCard key={item.id} item={item} language={language} />
            ))}
          </div>
        ) : (
          <div className='empty-state'>
            {language === 'zh'
              ? '岗位与组织领域当前没有已批准内容；岗位研究与能力差距工具仍可使用。'
              : 'No approved role or organization items are available; the research tools remain usable.'}
          </div>
        )}
      </section>
    </>
  );
}
