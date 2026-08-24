import type { KnowledgeTool, SeedCandidate } from '../domain';
import { localize, type Language } from '../i18n';
import { useLibrary } from '../state/LibraryContext';
import InternalLink from '../components/InternalLink';

export default function LibraryPage({
  items,
  tools,
  language,
}: {
  readonly items: readonly SeedCandidate[];
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  const { state, saveStatus, clearAll } = useLibrary();
  const bookmarkedItems = state.bookmarkedIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is SeedCandidate => item !== undefined);
  const unreadBookmarks = bookmarkedItems.filter((item) => !state.readIds.includes(item.id));
  const readItems = state.readIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is SeedCandidate => item !== undefined);
  const activeMaterials = state.toolMaterials.filter((material) => material.status !== 'completed');
  const completedMaterials = state.toolMaterials.filter((material) => material.status === 'completed');
  const hasLocalData = state.bookmarkedIds.length > 0
    || state.readIds.length > 0
    || state.toolMaterials.length > 0;

  const itemLinks = (entries: readonly SeedCandidate[]) => (
    <div className='library-links'>
      {entries.map((item) => (
        <InternalLink href={`/items/${item.slug}/`} key={item.id}>
          <strong>{localize(item.title, language)}</strong>
          <span>{localize(item.nextAction, language)}</span>
        </InternalLink>
      ))}
    </div>
  );

  const materialLinks = (status: 'active' | 'completed') => {
    const materials = status === 'completed' ? completedMaterials : activeMaterials;
    return (
      <div className='library-links'>
        {materials.map((material) => {
          const tool = tools.find((entry) => entry.id === material.toolId);
          return (
            <InternalLink href={`/tools/#${material.toolId}`} key={material.toolId}>
              <strong>{tool ? localize(tool.title, language) : material.title}</strong>
              <span>
                {material.status === 'completed'
                  ? (language === 'zh' ? '已完成' : 'Completed')
                  : (language === 'zh' ? '进行中' : 'In progress')}
                {' · '}
                {new Date(material.updatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
              </span>
            </InternalLink>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>LOCAL LIBRARY</p>
        <h1>{language === 'zh' ? '你的收藏与材料，只保存在这台设备。' : 'Your library and artifacts stay on this device.'}</h1>
        <p>
          {language === 'zh'
            ? '不登录、不上传、不写入 CRM。清除浏览器数据会删除这些状态，请及时下载重要 Markdown。'
            : 'No account, upload or CRM write. Clearing browser data removes this state, so download important Markdown.'}
        </p>
        <p className='save-indicator' role='status'>
          {saveStatus === 'saved'
            ? (language === 'zh' ? '本机自动保存正常' : 'Local autosave is working')
            : (language === 'zh' ? '本机保存失败，请先复制或下载材料' : 'Local save failed; copy or download your artifacts')}
        </p>
      </section>

      <section className='library-grid'>
        <article>
          <span>{unreadBookmarks.length}</span>
          <h2>{language === 'zh' ? '未读收藏' : 'Unread bookmarks'}</h2>
          {unreadBookmarks.length > 0
            ? itemLinks(unreadBookmarks)
            : <p>{language === 'zh' ? '还没有未读收藏。' : 'No unread bookmarks yet.'}</p>}
        </article>
        <article>
          <span>{readItems.length}</span>
          <h2>{language === 'zh' ? '已读内容' : 'Read items'}</h2>
          {readItems.length > 0
            ? itemLinks(readItems)
            : <p>{language === 'zh' ? '打开详情后会自动标为已读。' : 'Opening a detail marks it read.'}</p>}
        </article>
        <article>
          <span>{activeMaterials.length}</span>
          <h2>{language === 'zh' ? '进行中工具' : 'Tools in progress'}</h2>
          {activeMaterials.length > 0
            ? materialLinks('active')
            : <p>{language === 'zh' ? '编辑工具模板后会出现在这里。' : 'Edited tool templates appear here.'}</p>}
        </article>
        <article>
          <span>{completedMaterials.length}</span>
          <h2>{language === 'zh' ? '完成材料' : 'Completed artifacts'}</h2>
          {completedMaterials.length > 0
            ? materialLinks('completed')
            : <p>{language === 'zh' ? '把工具进度改为已完成后归档到这里。' : 'Mark a tool complete to archive it here.'}</p>}
        </article>
      </section>

      {!hasLocalData && (
        <section className='empty-state library-empty'>
          <strong>{language === 'zh' ? '从一条内容或一个工具开始' : 'Start with one item or tool'}</strong>
          <p>
            {language === 'zh'
              ? '可以从雷达收藏公开条目，也可以直接使用 8 个本机工具。'
              : 'Bookmark public items from Radar, or start with any of the eight local tools.'}
          </p>
          <div className='hero-actions'>
            <InternalLink className='primary-action' href='/tools/'>
              {language === 'zh' ? '选择方法工具' : 'Choose a tool'}
            </InternalLink>
            <a className='secondary-action' href='/fieldbook/'>
              {language === 'zh' ? '进入完整手册' : 'Open the fieldbook'}
            </a>
          </div>
        </section>
      )}

      {hasLocalData && (
        <section className='local-data-controls'>
          <div>
            <h2>{language === 'zh' ? '本机数据管理' : 'Local data controls'}</h2>
            <p>
              {language === 'zh'
                ? '清除后无法从服务器恢复。'
                : 'The server cannot restore cleared local data.'}
            </p>
          </div>
          <button
            className='danger-action'
            type='button'
            onClick={() => {
              if (window.confirm(language === 'zh' ? '清除全部本机收藏、已读和工具材料？' : 'Clear all local bookmarks, reading state and tool artifacts?')) {
                clearAll();
              }
            }}
          >
            {language === 'zh' ? '清除全部本机数据' : 'Clear all local data'}
          </button>
        </section>
      )}
    </>
  );
}
