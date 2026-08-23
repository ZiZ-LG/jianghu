import { useEffect, useLayoutEffect, useMemo, useState } from 'react';

import { approvedKnowledgeItems } from './content/publicItems';
import { knowledgeTools } from './content/tools';
import { knowledgeTopics } from './content/topics';
import InternalLink from './components/InternalLink';
import SearchBox from './components/SearchBox';
import type { Language } from './i18n';
import {
  desktopNavigation,
  getKnowledgeItemBySlug,
  getKnowledgeTopicBySlug,
  mobileNavigation,
  parseRoute,
  type AppRoute,
} from './navigation';
import ItemPage from './pages/ItemPage';
import DigestPage from './pages/DigestPage';
import LearnPage from './pages/LearnPage';
import LibraryPage from './pages/LibraryPage';
import RadarPage from './pages/RadarPage';
import RolesPage from './pages/RolesPage';
import TodayPage from './pages/TodayPage';
import ToolsPage from './pages/ToolsPage';
import TopicPage from './pages/TopicPage';
import TopicsPage from './pages/TopicsPage';
import { LibraryProvider } from './state/LibraryContext';

const productScope = {
  zh: 'AI 技术 × 大客户销售 × 岗位与组织转型',
  en: 'AI Technology × Enterprise Sales × Roles & Organization',
} as const;
const approvedItemIds = approvedKnowledgeItems.map((item) => item.id);
const knowledgeToolIds = knowledgeTools.map((tool) => tool.id);

function useBrowserLocation() {
  const readLocation = () => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  });
  const [location, setLocation] = useState(readLocation);

  useEffect(() => {
    const handleLocation = () => setLocation(readLocation());
    window.addEventListener('popstate', handleLocation);
    return () => window.removeEventListener('popstate', handleLocation);
  }, []);

  return location;
}

function routeBelongsToPrimary(route: AppRoute, href: string) {
  if (href === '/') return route.name === 'today' || route.name === 'digest';
  if (href === '/radar/') {
    return ['radar', 'topics', 'topic', 'roles', 'item'].includes(route.name);
  }
  if (href === '/tools/') return route.name === 'tools' || route.name === 'learn';
  if (href === '/library/') return route.name === 'library';
  return false;
}

function NotFoundPage({ language }: { readonly language: Language }) {
  return (
    <section className='not-found'>
      <p className='eyebrow'>404</p>
      <h1>{language === 'zh' ? '这一页不在当前知识地图中。' : 'This page is not in the current knowledge map.'}</h1>
      <p>
        {language === 'zh'
          ? '链接可能已失效，或候选内容尚未通过人工终审。'
          : 'The link may be stale, or candidate content may still be under review.'}
      </p>
      <div className='hero-actions'>
        <InternalLink className='primary-action' href='/'>
          {language === 'zh' ? '返回今日必读' : 'Back to today'}
        </InternalLink>
        <InternalLink className='secondary-action' href='/radar/'>
          {language === 'zh' ? '打开雷达专题' : 'Open radar'}
        </InternalLink>
      </div>
    </section>
  );
}

export default function App() {
  const [language, setLanguage] = useState<Language>('zh');
  const location = useBrowserLocation();
  const route = useMemo(() => parseRoute(location.pathname), [location.pathname]);
  const searchQuery = new URLSearchParams(location.search).get('q')?.trim() ?? '';

  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    const target = location.hash
      ? document.getElementById(decodeURIComponent(location.hash.slice(1)))
      : null;
    const top = target
      ? target.getBoundingClientRect().top + window.scrollY - 94
      : 0;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    const restoreFrame = window.requestAnimationFrame(() => {
      root.style.scrollBehavior = previousBehavior;
    });
    return () => window.cancelAnimationFrame(restoreFrame);
  }, [location.hash, location.pathname, location.search]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = language === 'zh'
      ? '自我修养｜AI 技术、大客户销售与岗位组织转型'
      : 'AI Sales Fieldcraft | Technology, Sales, Roles & Organization';
  }, [language]);

  const page = (() => {
    switch (route.name) {
      case 'today':
        return (
          <TodayPage
            items={approvedKnowledgeItems}
            topics={knowledgeTopics}
            tools={knowledgeTools}
            language={language}
          />
        );
      case 'radar':
        return (
          <RadarPage
            items={approvedKnowledgeItems}
            topics={knowledgeTopics}
            language={language}
            query={searchQuery}
          />
        );
      case 'topics':
        return <TopicsPage topics={knowledgeTopics} language={language} />;
      case 'topic': {
        const topic = getKnowledgeTopicBySlug(knowledgeTopics, route.slug);
        return topic
          ? <TopicPage topic={topic} items={approvedKnowledgeItems} tools={knowledgeTools} language={language} />
          : <NotFoundPage language={language} />;
      }
      case 'tools':
        return <ToolsPage tools={knowledgeTools} language={language} />;
      case 'roles':
        return <RolesPage items={approvedKnowledgeItems} language={language} />;
      case 'learn':
        return <LearnPage language={language} />;
      case 'library':
        return (
          <LibraryPage
            items={approvedKnowledgeItems}
            tools={knowledgeTools}
            language={language}
          />
        );
      case 'digest':
        return (
          <DigestPage
            items={approvedKnowledgeItems}
            tools={knowledgeTools}
            language={language}
          />
        );
      case 'item': {
        const item = getKnowledgeItemBySlug(approvedKnowledgeItems, route.slug);
        return item
          ? <ItemPage item={item} topics={knowledgeTopics} tools={knowledgeTools} language={language} />
          : <NotFoundPage language={language} />;
      }
      default:
        return <NotFoundPage language={language} />;
    }
  })();

  return (
    <LibraryProvider itemIds={approvedItemIds} toolIds={knowledgeToolIds}>
      <div className='site-shell'>
      <a className='skip-link' href='#main'>
        {language === 'zh' ? '跳到正文' : 'Skip to content'}
      </a>
      <header className='site-header'>
        <InternalLink className='brand' href='/' aria-label={language === 'zh' ? '自我修养首页' : 'AI Sales Fieldcraft home'}>
          <span className='brand-mark' aria-hidden='true'>修</span>
          <span>
            <strong>自我修养</strong>
            <small>AI Sales Fieldcraft</small>
          </span>
        </InternalLink>
        <nav className='desktop-nav' aria-label={language === 'zh' ? '主要导航' : 'Primary navigation'}>
          {desktopNavigation.map((item) => (
            <InternalLink
              key={item.href}
              href={item.href}
              aria-current={routeBelongsToPrimary(route, item.href) ? 'page' : undefined}
            >
              {item.label[language]}
            </InternalLink>
          ))}
        </nav>
        <SearchBox language={language} query={searchQuery} />
        <button
          className='language-toggle'
          type='button'
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}
        >
          {language === 'zh' ? 'EN' : '中文'}
        </button>
      </header>

      <main id='main'>{page}</main>

      <footer className='site-footer'>
        <div>
          <strong>自在创造（北京）智慧科技有限公司</strong>
          <p>{productScope[language]}</p>
          <p>© 2026 AI Sales Fieldcraft</p>
        </div>
        <div className='footer-links'>
          <a href='https://lake2ocean.top' rel='noreferrer'>{language === 'zh' ? '返回江湖首页' : 'Back to Jianghu'}</a>
          <a href='https://crm.lake2ocean.top' rel='noreferrer'>{language === 'zh' ? '进入江湖 CRM' : 'Open Jianghu CRM'}</a>
          <a href='https://beian.miit.gov.cn/' target='_blank' rel='noreferrer'>京ICP备2026046195号-2</a>
        </div>
      </footer>

      <nav className='mobile-nav' aria-label={language === 'zh' ? '移动端导航' : 'Mobile navigation'}>
        {mobileNavigation.map((item) => (
          <InternalLink
            key={item.href}
            href={item.href}
            aria-current={routeBelongsToPrimary(route, item.href) ? 'page' : undefined}
          >
            {item.shortLabel[language]}
          </InternalLink>
        ))}
      </nav>
      </div>
    </LibraryProvider>
  );
}
