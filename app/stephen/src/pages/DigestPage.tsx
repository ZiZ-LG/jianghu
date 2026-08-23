import { useMemo } from 'react';

import type { KnowledgeTool, SeedCandidate } from '../domain';
import { createDailyDigest, createWeeklyDigest, type DigestEntry } from '../content/digests';
import { localize, type Language } from '../i18n';
import InternalLink from '../components/InternalLink';
import KnowledgeCard from '../components/KnowledgeCard';

function shanghaiDateOnly(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function weekRange(dateOnly: string) {
  const anchor = new Date(`${dateOnly}T00:00:00.000Z`);
  const day = anchor.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    weekStart: monday.toISOString().slice(0, 10),
    weekEnd: sunday.toISOString().slice(0, 10),
  };
}

function displayDate(value: string, language: Language) {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function EntryLinks({
  entries,
  language,
  emptyText,
}: {
  readonly entries: readonly DigestEntry<SeedCandidate>[];
  readonly language: Language;
  readonly emptyText: string;
}) {
  if (entries.length === 0) return <p className='digest-empty-line'>{emptyText}</p>;
  return (
    <div className='digest-link-list'>
      {entries.map((entry) => (
        <InternalLink href={`/items/${entry.item.slug}/`} key={entry.item.id}>
          <strong>{localize(entry.item.title, language)}</strong>
          <span>{entry.estimatedReadMinutes} min · {entry.sourceCount} {language === 'zh' ? '个信源' : 'sources'}</span>
        </InternalLink>
      ))}
    </div>
  );
}

export default function DigestPage({
  items,
  tools,
  language,
}: {
  readonly items: readonly SeedCandidate[];
  readonly tools: readonly KnowledgeTool[];
  readonly language: Language;
}) {
  const asOfDate = shanghaiDateOnly(new Date());
  const range = weekRange(asOfDate);
  const daily = useMemo(
    () => createDailyDigest(items, { digestDate: asOfDate }),
    [asOfDate, items],
  );
  const weekly = useMemo(
    () => createWeeklyDigest(items, {
      ...range,
      validToolIds: tools.map((tool) => tool.id),
    }),
    [items, range.weekEnd, range.weekStart, tools],
  );
  const recommendedTools = weekly.recommendedToolIds
    .map((id) => tools.find((tool) => tool.id === id))
    .filter((tool): tool is KnowledgeTool => tool !== undefined);

  return (
    <>
      <section className='page-intro digest-intro'>
        <p className='eyebrow'>REVIEWED DIGESTS</p>
        <h1>{language === 'zh' ? '把一周的变化压缩成今天能做的事。' : 'Compress the week into something you can do today.'}</h1>
        <p>
          {language === 'zh'
            ? '日报和周报只投影已经批准的公开内容。同一事件合并，内容不足时少发，不用候选或低价值条目凑数。'
            : 'Daily and weekly digests only project approved public content. Events are deduplicated, and short editions never pad with candidates.'}
        </p>
      </section>

      <section className='section-block' aria-labelledby='daily-digest-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>DAILY DIGEST</p>
            <h2 id='daily-digest-title'>{language === 'zh' ? '今日简报' : 'Daily digest'}</h2>
          </div>
          <span className='result-count'>{displayDate(daily.digestDate, language)}</span>
        </div>

        <div className='digest-metrics' aria-label={language === 'zh' ? '今日简报指标' : 'Daily digest metrics'}>
          <article><strong>{daily.entries.length}</strong><span>{language === 'zh' ? '条内容' : 'items'}</span></article>
          <article><strong>{daily.estimatedReadMinutes}</strong><span>{language === 'zh' ? '分钟' : 'minutes'}</span></article>
          <article><strong>{daily.sourceCount}</strong><span>{language === 'zh' ? '个信源' : 'sources'}</span></article>
          <article><strong>{daily.coveredDomains.length}/3</strong><span>{language === 'zh' ? '知识域' : 'domains'}</span></article>
        </div>

        {daily.entries.length > 0 ? (
          <>
            <div className='knowledge-grid digest-card-grid'>
              {daily.entries.map((entry) => (
                <KnowledgeCard item={entry.item} language={language} key={entry.item.id} />
              ))}
            </div>
            <div className='digest-action-callout'>
              <p className='section-index'>TODAY'S ACTION</p>
              <strong>{daily.todayAction ? localize(daily.todayAction, language) : ''}</strong>
            </div>
          </>
        ) : (
          <div className='empty-state'>
            <strong>{language === 'zh' ? '暂无可发布的今日简报' : 'No publishable daily digest yet'}</strong>
            <p>
              {language === 'zh'
                ? '首批 30 条仍在项目所有者终审，公开集合保持为空。终审通过前不会展示候选摘要。'
                : 'The first 30 items remain under owner review. Candidate summaries stay out of the public collection until approval.'}
            </p>
          </div>
        )}
      </section>

      <section className='section-block' aria-labelledby='weekly-digest-title'>
        <div className='section-heading section-heading-row'>
          <div>
            <p className='section-index'>WEEKLY DIGEST</p>
            <h2 id='weekly-digest-title'>{language === 'zh' ? '本周复盘' : 'Weekly review'}</h2>
          </div>
          <span className='result-count'>
            {displayDate(weekly.weekStart, language)} – {displayDate(weekly.weekEnd, language)}
          </span>
        </div>

        {weekly.entries.length > 0 ? (
          <div className='digest-panel-grid'>
            <article className='digest-panel digest-main-thread'>
              <p className='section-index'>MAIN THREAD</p>
              <h3>{language === 'zh' ? '本周主线' : 'Main thread'}</h3>
              {weekly.mainThread && (
                <>
                  <InternalLink href={`/items/${weekly.mainThread.item.slug}/`}>
                    {localize(weekly.mainThread.item.title, language)}
                  </InternalLink>
                  <p>{localize(weekly.mainThread.item.whyItMatters, language)}</p>
                </>
              )}
            </article>
            <article className='digest-panel'>
              <p className='section-index'>CONTINUING EVENTS</p>
              <h3>{language === 'zh' ? '持续事件' : 'Continuing events'}</h3>
              <EntryLinks
                entries={weekly.continuingEvents}
                language={language}
                emptyText={language === 'zh' ? '本周没有已批准的持续事件更新。' : 'No approved continuing event this week.'}
              />
            </article>
            <article className='digest-panel'>
              <p className='section-index'>ROLE CHANGE</p>
              <h3>{language === 'zh' ? '岗位与组织变化' : 'Role and organization change'}</h3>
              <EntryLinks
                entries={weekly.roleChanges}
                language={language}
                emptyText={language === 'zh' ? '本周没有已批准的岗位变化条目。' : 'No approved role-change item this week.'}
              />
            </article>
            <article className='digest-panel'>
              <p className='section-index'>RECOMMENDED TOOLS</p>
              <h3>{language === 'zh' ? '推荐工具' : 'Recommended tools'}</h3>
              {recommendedTools.length > 0 ? (
                <div className='digest-link-list'>
                  {recommendedTools.map((tool) => (
                    <InternalLink href={`/tools/#${tool.id}`} key={tool.id}>
                      <strong>{localize(tool.title, language)}</strong>
                      <span>{tool.estimatedMinutes} min · Markdown</span>
                    </InternalLink>
                  ))}
                </div>
              ) : (
                <p className='digest-empty-line'>
                  {language === 'zh' ? '本周条目尚未形成工具推荐。' : 'No tool recommendation is available this week.'}
                </p>
              )}
            </article>
          </div>
        ) : (
          <div className='empty-state'>
            <strong>{language === 'zh' ? '本周暂无已批准更新' : 'No approved update this week'}</strong>
            <p>
              {language === 'zh'
                ? '周报只包含本周新增或实质更新的公开内容；没有时保持空报。'
                : 'The weekly review only includes newly published or substantively updated public items.'}
            </p>
          </div>
        )}
      </section>

      <section className='digest-policy-note'>
        <div>
          <p className='section-index'>EDITORIAL CONTROL</p>
          <h2>{language === 'zh' ? '摘要不是新的事实来源。' : 'A digest is not a new source of facts.'}</h2>
        </div>
        <p>
          {language === 'zh'
            ? '每条内容仍保留原始证据、风险与审核状态。自动发布默认关闭，来源冲突和中高风险内容始终进入人工队列。'
            : 'Every item retains its evidence, risk and review state. Automatic publishing stays disabled by default; conflicts and medium/high risk always require review.'}
        </p>
      </section>
    </>
  );
}
