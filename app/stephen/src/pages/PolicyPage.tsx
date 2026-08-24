import type { Language } from '../i18n';

const feedbackEmail = 'mailto:cs@zizai.tech?subject=%E8%87%AA%E6%88%91%E4%BF%AE%E5%85%BB%E5%86%85%E5%AE%B9%E7%BA%A0%E9%94%99';

export default function PolicyPage({ language }: { readonly language: Language }) {
  return (
    <>
      <section className='page-intro policy-intro'>
        <p className='eyebrow'>POLICY & CORRECTION</p>
        <h1>{language === 'zh' ? '隐私、版权与纠错说明' : 'Privacy, copyright and corrections'}</h1>
        <p>
          {language === 'zh'
            ? '这是一个面向销售个人的静态知识站。本页说明浏览器本机数据、内容引用、AI 辅助和问题反馈的边界。'
            : 'This static knowledge site serves individual sellers. This page explains local browser data, attribution, AI assistance and issue reporting.'}
        </p>
        <p className='policy-updated'>
          {language === 'zh' ? '最后更新：2026 年 8 月 23 日' : 'Last updated: August 23, 2026'}
        </p>
      </section>

      <div className='policy-toc' aria-label={language === 'zh' ? '说明页目录' : 'Policy contents'}>
        <a href='#privacy'>{language === 'zh' ? '隐私与本机数据' : 'Privacy & local data'}</a>
        <a href='#copyright'>{language === 'zh' ? '版权与引用' : 'Copyright & attribution'}</a>
        <a href='#ai-assistance'>{language === 'zh' ? 'AI 辅助边界' : 'AI assistance'}</a>
        <a href='#correction'>{language === 'zh' ? '纠错与建议' : 'Corrections & ideas'}</a>
      </div>

      <section className='policy-section' id='privacy'>
        <p className='section-index'>01 · PRIVACY</p>
        <h2>{language === 'zh' ? '隐私与本机数据' : 'Privacy and local browser data'}</h2>
        {language === 'zh' ? (
          <>
            <p>第一阶段不提供知识站账号，不上传收藏、已读状态或工具材料，也不写入江湖 CRM。</p>
            <p>收藏、已读、进度和 Markdown 材料保存在当前浏览器的 <code>localStorage</code>，键名为 <code>stephen-knowledge-library-v1</code>。清除浏览器数据会删除它们，站点无法从服务器恢复。</p>
            <p>搜索词会出现在页面 URL 中，可能留在浏览器历史和服务器基础访问日志。请不要输入客户姓名、联系方式、合同、报价或其他敏感信息。</p>
          </>
        ) : (
          <>
            <p>Phase one has no knowledge-site account. Bookmarks, read state and tool artifacts are not uploaded or written to Jianghu CRM.</p>
            <p>Bookmarks, reading state, progress and Markdown live in this browser's <code>localStorage</code> under <code>stephen-knowledge-library-v1</code>. Clearing browser data removes them, and the site cannot restore them from a server.</p>
            <p>Search terms appear in the page URL and may remain in browser history and basic server access logs. Do not enter customer names, contact details, contracts, pricing or other sensitive information.</p>
          </>
        )}
      </section>

      <section className='policy-section' id='copyright'>
        <p className='section-index'>02 · COPYRIGHT</p>
        <h2>{language === 'zh' ? '版权、来源与商业使用' : 'Copyright, sources and commercial use'}</h2>
        {language === 'zh' ? (
          <>
            <p>知识库默认只保存原文标题、发布方、日期、链接、必要短摘要和本站自有分析，不转载无授权全文、图表或付费内容。</p>
            <p>原始材料的权利归原权利人。“官方事实”、“企业自述”、“研究发现”和“编辑推断”在内容中分层标识，外部主张不视为本站独立验证。</p>
            <p>如果你是权利人并认为某条内容引用不当，请通过本页“纠错与建议”提供原文 URL、问题类型和联系方式；阻断级问题会先撤下再调查。</p>
          </>
        ) : (
          <>
            <p>The hub stores source titles, publishers, dates, links, necessary short summaries and original analysis. It does not republish unauthorized full text, charts or paywalled material.</p>
            <p>Rights in source material remain with their owners. Official facts, company claims, research findings and editorial inference are labeled separately; an external claim is not independent verification by this site.</p>
            <p>If you are a rights holder and believe an excerpt or attribution is improper, use Corrections & ideas below with the source URL, issue type and contact details. Blocking issues are withdrawn before investigation.</p>
          </>
        )}
      </section>

      <section className='policy-section' id='ai-assistance'>
        <p className='section-index'>03 · AI ASSISTANCE</p>
        <h2>{language === 'zh' ? 'AI 可以辅助，不能自行批准' : 'AI may assist; it may not approve'}</h2>
        <p>
          {language === 'zh'
            ? 'AI 只可辅助候选摘要、标签、翻译和影响分析草稿。它不得新增白名单、降低风险、忽略来源冲突、批准内容或覆盖人工终审。自动发布默认关闭。'
            : 'AI may assist with candidate summaries, tags, translation and impact-analysis drafts. It may not add allowlisted sources, lower risk, ignore source conflicts, approve content or override human review. Automatic publishing is disabled by default.'}
        </p>
      </section>

      <section className='policy-section policy-correction' id='correction'>
        <p className='section-index'>04 · CORRECTION</p>
        <h2>{language === 'zh' ? '纠错、失效链接、版权问题与 idea' : 'Corrections, broken links, rights issues and ideas'}</h2>
        <p>
          {language === 'zh'
            ? '所有反馈统一进入主站“卧虎藏龙”渠道。第一阶段只提供提交入口，不提供公开评论、回复串、点赞或用户主页。'
            : 'All feedback goes to the main site’s Wo Hu Cang Long channel. Phase one provides a submission route only, with no public comments, reply threads, likes or user profiles.'}
        </p>
        <div className='hero-actions policy-actions'>
          <a className='primary-action' href='https://lake2ocean.top/#wuhu'>
            {language === 'zh' ? '进入卧虎藏龙反馈渠道' : 'Open the feedback channel'}
          </a>
          <a className='secondary-action' href={feedbackEmail}>
            {language === 'zh' ? '邮件提交内容纠错' : 'Email a content correction'}
          </a>
        </div>
        <p className='correction-guide'>
          {language === 'zh'
            ? '建议包含：页面 URL、问题类型（事实错误 / 失效链接 / 版权 / 其他建议）、问题说明和可选联系方式。'
            : 'Please include the page URL, issue type (fact / broken link / rights / other), a short explanation and optional contact details.'}
        </p>
      </section>
    </>
  );
}
