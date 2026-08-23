import type { Language } from '../i18n';
import InternalLink from '../components/InternalLink';

export default function LibraryPage({ language }: { readonly language: Language }) {
  return (
    <>
      <section className='page-intro'>
        <p className='eyebrow'>LOCAL LIBRARY</p>
        <h1>{language === 'zh' ? '你的收藏与材料，只保存在这台设备。' : 'Your library and artifacts stay on this device.'}</h1>
        <p>
          {language === 'zh'
            ? '不登录、不上传、不写入 CRM。收藏、已读、工具进度与 Markdown 材料将在 SAAS-603 接通。'
            : 'No account, upload or CRM write. Bookmarks, reading state and local Markdown arrive in SAAS-603.'}
        </p>
      </section>

      <section className='library-grid'>
        <article>
          <span>0</span>
          <h2>{language === 'zh' ? '未读收藏' : 'Unread bookmarks'}</h2>
          <p>{language === 'zh' ? '收藏功能尚未启用，不伪造用户数据。' : 'Bookmarking is not enabled yet; no user data is invented.'}</p>
        </article>
        <article>
          <span>0</span>
          <h2>{language === 'zh' ? '已读内容' : 'Read items'}</h2>
          <p>{language === 'zh' ? '后续会在本机记录，可随时清除。' : 'This will be stored locally and remain clearable.'}</p>
        </article>
        <article>
          <span>0</span>
          <h2>{language === 'zh' ? '进行中工具' : 'Tools in progress'}</h2>
          <p>{language === 'zh' ? '工具草稿不会跨设备同步。' : 'Tool drafts will not sync across devices.'}</p>
        </article>
        <article>
          <span>0</span>
          <h2>{language === 'zh' ? '完成材料' : 'Completed artifacts'}</h2>
          <p>{language === 'zh' ? '可以复制或下载 Markdown，不生成作品集。' : 'Copy or download Markdown; no portfolio generator.'}</p>
        </article>
      </section>

      <section className='empty-state library-empty'>
        <strong>{language === 'zh' ? '从一条内容或一个工具开始' : 'Start with one item or tool'}</strong>
        <p>
          {language === 'zh'
            ? 'SAAS-603 完成前，本页保持诚实的空状态。'
            : 'This page remains an honest empty state until SAAS-603 is complete.'}
        </p>
        <div className='hero-actions'>
          <InternalLink className='primary-action' href='/'>
            {language === 'zh' ? '查看今日必读' : 'View today'}
          </InternalLink>
          <InternalLink className='secondary-action' href='/tools/'>
            {language === 'zh' ? '选择方法工具' : 'Choose a tool'}
          </InternalLink>
        </div>
      </section>
    </>
  );
}
