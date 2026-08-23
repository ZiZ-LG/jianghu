import type { KnowledgeTool } from '../domain';
import { localize, type Language } from '../i18n';
import InternalLink from '../components/InternalLink';

export default function ToolsPage({
  tools,
  language,
}: {
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>METHOD TOOLS</p>
        <h1>{language === 'zh' ? '把“我理解了”变成一份可继续工作的材料。' : 'Turn understanding into a working artifact.'}</h1>
        <p>
          {language === 'zh'
            ? '八个工具覆盖转岗研究、客户发现、价值证明、POC、组织采用与风险。示例全部虚构，不保存真实客户数据。'
            : 'Eight tools cover transition, discovery, value, POC, adoption and risk. All examples are fictional.'}
        </p>
        <div className='hero-actions'>
          <InternalLink className='primary-action' href='/learn/'>
            {language === 'zh' ? '选择 1 / 7 / 30 / 90 天路径' : 'Choose a 1 / 7 / 30 / 90 day path'}
          </InternalLink>
          <a className='secondary-action' href='/fieldbook/'>
            {language === 'zh' ? '完整旧手册' : 'Complete fieldbook'}
          </a>
        </div>
      </section>

      <section className='tool-list' aria-label={language === 'zh' ? '行动工具' : 'Action tools'}>
        {tools.map((tool, index) => (
          <article className='tool-card' id={tool.id} key={tool.id}>
            <div className='tool-number'>{String(index + 1).padStart(2, '0')}</div>
            <div className='tool-body'>
              <div className='tool-heading'>
                <div>
                  <h2>{localize(tool.title, language)}</h2>
                  {language === 'en' && !tool.title.en && <span className='language-fallback'>Chinese content</span>}
                </div>
                <span>{tool.estimatedMinutes} min · Markdown</span>
              </div>
              <p className='lead'>{localize(tool.scenario, language)}</p>
              <div className='tool-columns'>
                <section>
                  <h3>{language === 'zh' ? '开始前回答' : 'Prompts'}</h3>
                  <ol>
                    {tool.inputPrompts.map((prompt) => (
                      <li key={prompt.zh}>{localize(prompt, language)}</li>
                    ))}
                  </ol>
                </section>
                <section>
                  <h3>{language === 'zh' ? '完成标准' : 'Completion criteria'}</h3>
                  <ul>
                    {tool.completionCriteria.map((criterion) => (
                      <li key={criterion.zh}>{localize(criterion, language)}</li>
                    ))}
                  </ul>
                </section>
              </div>
              <details>
                <summary>{language === 'zh' ? '查看 Markdown 模板' : 'View Markdown template'}</summary>
                <pre>{tool.templateMarkdown}</pre>
              </details>
              <details>
                <summary>{language === 'zh' ? '查看虚构示例' : 'View fictional example'}</summary>
                <pre>{tool.exampleMarkdown}</pre>
              </details>
              <p className='safety-note'><strong>{language === 'zh' ? '数据边界：' : 'Data boundary: '}</strong>{localize(tool.safetyNote, language)}</p>
              <p className='stage-note'>
                {language === 'zh'
                  ? '本机编辑、复制和 Markdown 下载将在 SAAS-603 接通。'
                  : 'Local editing, copy and Markdown download arrive in SAAS-603.'}
              </p>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
