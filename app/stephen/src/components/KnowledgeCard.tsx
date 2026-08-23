import type { KnowledgeItem, SeedReview } from '../domain';
import { domainLabels, isChineseFallback, localize, type Language } from '../i18n';
import { useLibrary } from '../state/LibraryContext';
import EvidenceBadge from './EvidenceBadge';
import InternalLink from './InternalLink';

type DisplayItem = KnowledgeItem & { readonly review?: SeedReview };

export default function KnowledgeCard({
  item,
  language,
}: {
  readonly item: DisplayItem;
  readonly language: Language;
}) {
  const { state, toggleBookmark, markRead } = useLibrary();
  const bookmarked = state.bookmarkedIds.includes(item.id);
  const read = state.readIds.includes(item.id);
  const date = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(item.publishedAt));
  const firstEvidence = item.evidence[0];

  return (
    <article className='knowledge-card'>
      <div className='card-meta'>
        <div className='domain-tags'>
          {item.domains.map((domain) => (
            <span key={domain}>{localize(domainLabels[domain], language)}</span>
          ))}
        </div>
        <time dateTime={item.publishedAt}>{date}</time>
      </div>
      {item.editorialStatus === 'candidate' && (
        <p className='candidate-label'>
          {language === 'zh' ? '终审候选 · 尚未公开' : 'Review candidate · not published'}
        </p>
      )}
      <h3>
        <InternalLink
          href={`/items/${encodeURIComponent(item.slug)}/`}
          onClick={() => markRead(item.id)}
        >
          {localize(item.title, language)}
        </InternalLink>
      </h3>
      {isChineseFallback(item.title, language) && (
        <span className='language-fallback'>Chinese content</span>
      )}
      <p className='card-summary'>{localize(item.summary, language)}</p>
      <dl className='card-insight'>
        <div>
          <dt>{language === 'zh' ? '为什么与你有关' : 'Why it matters'}</dt>
          <dd>{localize(item.whyItMatters, language)}</dd>
        </div>
        <div>
          <dt>{language === 'zh' ? '下一步行动' : 'Next action'}</dt>
          <dd>{localize(item.nextAction, language)}</dd>
        </div>
      </dl>
      <div className='card-evidence'>
        <EvidenceBadge level={firstEvidence.level} language={language} />
        <a href={firstEvidence.url} target='_blank' rel='noreferrer'>
          {firstEvidence.publisher}
          {item.evidence.length > 1 ? ` +${item.evidence.length - 1}` : ''}
          <span className='sr-only'>
            {language === 'zh' ? '（在新窗口打开原文）' : ' (opens source in a new tab)'}
          </span>
        </a>
      </div>
      <div className='card-actions'>
        <button
          type='button'
          aria-pressed={bookmarked}
          onClick={() => toggleBookmark(item.id)}
        >
          {bookmarked
            ? (language === 'zh' ? '已收藏' : 'Bookmarked')
            : (language === 'zh' ? '收藏' : 'Bookmark')}
        </button>
        <span>{read ? (language === 'zh' ? '已读' : 'Read') : (language === 'zh' ? '未读' : 'Unread')}</span>
      </div>
    </article>
  );
}
