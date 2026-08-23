import { useEffect, useState } from 'react';

type Language = 'zh' | 'en';

const navigation = [
  { href: '#today', zh: '今日必读', en: 'Today' },
  { href: '#radar', zh: '雷达专题', en: 'Radar' },
  { href: '#tools', zh: '方法工具', en: 'Tools' },
  { href: '#library', zh: '我的收藏', en: 'Library' },
] as const;

const domains = [
  {
    zh: 'AI 技术',
    en: 'AI Technology',
    zhBody: '看懂模型、Agent、数据与产品能力怎样形成商业价值。',
    enBody: 'Understand how models, agents, data and products create business value.',
  },
  {
    zh: '大客户销售',
    en: 'Enterprise Sales',
    zhBody: '把技术变化翻译成客户问题、价值假设、决策链与采用路径。',
    enBody: 'Translate technology shifts into customer problems, value and adoption.',
  },
  {
    zh: '岗位与组织转型',
    en: 'Roles & Organization',
    zhBody: '理解 AI 岗位、能力证据和组织工作方式如何一起改变。',
    enBody: 'Track how AI roles, evidence of ability and ways of working evolve.',
  },
] as const;

const copy = {
  zh: {
    eyebrow: 'AI 技术 × 大客户销售 × 岗位与组织转型',
    title: '每天 10 分钟，从可信变化走到可执行动作。',
    intro: '为正在转向 AI 业务与岗位的传统 To B 销售个人建立的行动型知识库。',
    fieldbook: '进入完整旧手册',
    status: 'SAAS-601 · 基线与独立外壳',
    statusBody: '首批 30 条内容、6 个专题与 8 个工具仍需在后续任务中完成中文编制和人工终审；当前页面不展示伪造的占位内容。',
    todayTitle: '今日必读',
    todayBody: '精选内容将在人工终审通过后开放。首页届时展示 3–5 条，每周新增或实质更新 3–5 条。',
    radarTitle: '三域雷达',
    toolsTitle: '方法工具与学习路径',
    toolsBody: '新知识库采用 1 / 7 / 30 / 90 天路径；旧手册内部的 3 / 7 / 14 / 30 天任务保持原样。',
    libraryTitle: '我的收藏',
    libraryBody: '后续工具材料只保存在本机，可继续编辑、复制并下载 Markdown；不生成作品集、不建立公开主页，也不写入 CRM。',
    languageNote: '第一阶段保证完整中文正文和双语界面。英文正文尚未完成时继续展示中文，并标记 Chinese content。',
    feedback: '返回江湖首页',
    crm: '进入江湖 CRM',
  },
  en: {
    eyebrow: 'AI Technology × Enterprise Sales × Roles & Organization',
    title: 'Ten minutes a day, from a trusted change to an actionable next step.',
    intro: 'An action-oriented knowledge hub for traditional B2B sellers moving into AI business and roles.',
    fieldbook: 'Open the complete fieldbook',
    status: 'SAAS-601 · Baseline and standalone shell',
    statusBody: 'The first 30 items, 6 topics and 8 tools still require complete Chinese authoring and human review in later tasks. This shell does not present invented placeholder content.',
    todayTitle: 'Today',
    todayBody: 'Curated items open only after human review. The homepage will show 3–5 items, with 3–5 meaningful additions or updates each week.',
    radarTitle: 'Three-domain radar',
    toolsTitle: 'Tools and learning paths',
    toolsBody: 'The new hub uses 1 / 7 / 30 / 90 day paths. The fieldbook keeps its original 3 / 7 / 14 / 30 day tasks unchanged.',
    libraryTitle: 'Library',
    libraryBody: 'Future tool materials stay local and remain editable, copyable and downloadable as Markdown. There is no portfolio generator, public profile or CRM write.',
    languageNote: 'Phase one requires complete Chinese content and a bilingual interface. Missing English body copy falls back to Chinese with a Chinese content label.',
    feedback: 'Back to Jianghu',
    crm: 'Open Jianghu CRM',
  },
} as const;

export default function App() {
  const [language, setLanguage] = useState<Language>('zh');
  const text = copy[language];

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main">{language === 'zh' ? '跳到正文' : 'Skip to content'}</a>
      <header className="site-header">
        <a className="brand" href="/" aria-label="自我修养首页">
          <span className="brand-mark" aria-hidden="true">修</span>
          <span><strong>自我修养</strong><small>AI Sales Fieldcraft</small></span>
        </a>
        <nav className="desktop-nav" aria-label={language === 'zh' ? '主要导航' : 'Primary navigation'}>
          {navigation.map((item) => (
            <a key={item.href} href={item.href}>{language === 'zh' ? item.zh : item.en}</a>
          ))}
        </nav>
        <button
          className="language-toggle"
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}
        >
          {language === 'zh' ? 'EN' : '中文'}
        </button>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">{text.eyebrow}</p>
          <h1 id="hero-title">{text.title}</h1>
          <p className="hero-copy">{text.intro}</p>
          <div className="hero-actions">
            <a className="primary-action" href="/fieldbook/">{text.fieldbook}</a>
            <span className="stage-badge">{text.status}</span>
          </div>
        </section>

        <section className="status-panel" aria-label={text.status}>
          <strong>{text.status}</strong>
          <p>{text.statusBody}</p>
        </section>

        <section id="today" className="section-block">
          <div className="section-heading">
            <p className="section-index">01</p>
            <h2>{text.todayTitle}</h2>
          </div>
          <div className="empty-state"><p>{text.todayBody}</p></div>
        </section>

        <section id="radar" className="section-block">
          <div className="section-heading">
            <p className="section-index">02</p>
            <h2>{text.radarTitle}</h2>
          </div>
          <div className="domain-grid">
            {domains.map((domain) => (
              <article className="domain-card" key={domain.en}>
                <p className="domain-en">{language === 'zh' ? domain.en : domain.zh}</p>
                <h3>{language === 'zh' ? domain.zh : domain.en}</h3>
                <p>{language === 'zh' ? domain.zhBody : domain.enBody}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="tools" className="section-block split-block">
          <div>
            <div className="section-heading">
              <p className="section-index">03</p>
              <h2>{text.toolsTitle}</h2>
            </div>
            <p>{text.toolsBody}</p>
          </div>
          <a className="fieldbook-card" href="/fieldbook/">
            <span>FIELD­BOOK</span>
            <strong>{text.fieldbook}</strong>
            <small>8 modules · 32 terms · 45 tasks</small>
          </a>
        </section>

        <section id="library" className="section-block">
          <div className="section-heading">
            <p className="section-index">04</p>
            <h2>{text.libraryTitle}</h2>
          </div>
          <p>{text.libraryBody}</p>
          <p className="language-note">{text.languageNote}</p>
        </section>
      </main>

      <footer className="site-footer">
        <div>
          <strong>自在创造（北京）智慧科技有限公司</strong>
          <p>© 2026 AI Sales Fieldcraft</p>
        </div>
        <div className="footer-links">
          <a href="https://lake2ocean.top" rel="noreferrer">{text.feedback}</a>
          <a href="https://crm.lake2ocean.top" rel="noreferrer">{text.crm}</a>
          <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">京ICP备2026046195号-2</a>
        </div>
      </footer>

      <nav className="mobile-nav" aria-label={language === 'zh' ? '移动端导航' : 'Mobile navigation'}>
        {navigation.map((item) => (
          <a key={item.href} href={item.href}>{language === 'zh' ? item.zh.slice(0, 2) : item.en}</a>
        ))}
      </nav>
    </div>
  );
}
