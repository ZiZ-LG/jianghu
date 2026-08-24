import { useState } from 'react';

import type { KnowledgeTool, ToolMaterial } from '../domain';
import { localize, type Language } from '../i18n';
import { useLibrary } from '../state/LibraryContext';
import { sanitizeMarkdownFilename } from '../state/search';
import InternalLink from '../components/InternalLink';

async function copyMarkdown(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Some embedded or headless browsers expose Clipboard API but deny it.
      // Fall through to the user-gesture legacy copy path.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy failed');
}

function downloadMarkdown(title: string, value: string) {
  const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeMarkdownFilename(title);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ToolWorkspace({
  tool,
  index,
  language,
}: {
  readonly tool: KnowledgeTool;
  readonly index: number;
  readonly language: Language;
}) {
  const {
    state,
    saveStatus,
    updateToolMaterial,
    removeToolMaterial,
  } = useLibrary();
  const [copyStatus, setCopyStatus] = useState<'copied' | 'error' | null>(null);
  const material = state.toolMaterials.find((entry) => entry.toolId === tool.id);
  const bodyMarkdown = material?.bodyMarkdown ?? tool.templateMarkdown;
  const status = material?.status ?? 'not_started';

  const persist = (changes: {
    readonly bodyMarkdown?: string;
    readonly status?: ToolMaterial['status'];
  }) => {
    updateToolMaterial({
      toolId: tool.id,
      title: tool.title.zh,
      status: changes.status ?? status,
      bodyMarkdown: changes.bodyMarkdown ?? bodyMarkdown,
    });
  };

  const handleCopy = async () => {
    try {
      await copyMarkdown(bodyMarkdown);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  };

  return (
    <article className='tool-card' id={tool.id}>
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
          <summary>{language === 'zh' ? '查看虚构示例' : 'View fictional example'}</summary>
          <pre>{tool.exampleMarkdown}</pre>
        </details>

        <section className='tool-editor' aria-labelledby={`${tool.id}-editor-title`}>
          <div className='tool-editor-heading'>
            <div>
              <p className='section-index'>LOCAL WORKSPACE</p>
              <h3 id={`${tool.id}-editor-title`}>
                {language === 'zh' ? '本机工具材料' : 'Local tool artifact'}
              </h3>
            </div>
            <label>
              <span>{language === 'zh' ? '进度' : 'Status'}</span>
              <select
                value={status}
                onChange={(event) => persist({
                  status: event.target.value as ToolMaterial['status'],
                })}
              >
                <option value='not_started'>{language === 'zh' ? '未开始' : 'Not started'}</option>
                <option value='in_progress'>{language === 'zh' ? '进行中' : 'In progress'}</option>
                <option value='completed'>{language === 'zh' ? '已完成' : 'Completed'}</option>
              </select>
            </label>
          </div>
          <textarea
            value={bodyMarkdown}
            rows={16}
            spellCheck='false'
            aria-label={language === 'zh' ? `编辑${tool.title.zh}` : `Edit ${tool.title.en ?? tool.title.zh}`}
            onChange={(event) => persist({
              bodyMarkdown: event.target.value,
              status: status === 'not_started' ? 'in_progress' : status,
            })}
          />
          <div className='tool-editor-actions'>
            <button type='button' onClick={() => void handleCopy()}>
              {language === 'zh' ? '复制 Markdown' : 'Copy Markdown'}
            </button>
            <button type='button' onClick={() => downloadMarkdown(tool.title.zh, bodyMarkdown)}>
              {language === 'zh' ? '下载 .md' : 'Download .md'}
            </button>
            {material && (
              <button
                className='danger-action'
                type='button'
                onClick={() => {
                  if (window.confirm(language === 'zh' ? '清除此工具的本机材料？' : 'Clear this local tool artifact?')) {
                    removeToolMaterial(tool.id);
                  }
                }}
              >
                {language === 'zh' ? '恢复模板' : 'Reset'}
              </button>
            )}
            <span role='status'>
              {copyStatus === 'copied' && (language === 'zh' ? '已复制' : 'Copied')}
              {copyStatus === 'error' && (language === 'zh' ? '复制失败，请手动选择文本' : 'Copy failed; select the text manually')}
              {!copyStatus && saveStatus === 'saved' && material && (language === 'zh' ? '已自动保存在本机' : 'Saved locally')}
              {saveStatus === 'error' && (language === 'zh' ? '本机保存失败' : 'Local save failed')}
            </span>
          </div>
        </section>

        <p className='safety-note'>
          <strong>{language === 'zh' ? '数据边界：' : 'Data boundary: '}</strong>
          {localize(tool.safetyNote, language)}
        </p>
      </div>
    </article>
  );
}

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
            ? '八个工具覆盖转岗研究、客户发现、价值证明、POC、组织采用与风险。材料自动保存在当前浏览器，不上传、不跨设备同步。'
            : 'Eight tools cover transition, discovery, value, POC, adoption and risk. Artifacts stay in this browser and never upload or sync.'}
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
          <ToolWorkspace tool={tool} index={index} language={language} key={tool.id} />
        ))}
      </section>
    </>
  );
}
