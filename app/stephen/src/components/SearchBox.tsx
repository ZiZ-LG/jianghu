import { useEffect, useState, type FormEvent } from 'react';

import type { Language } from '../i18n';

function navigateToQuery(query: string) {
  const next = new URL('/radar/', window.location.origin);
  if (query.trim()) next.searchParams.set('q', query.trim());
  window.history.pushState({}, '', `${next.pathname}${next.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function SearchBox({
  language,
  query,
}: {
  readonly language: Language;
  readonly query: string;
}) {
  const [value, setValue] = useState(query);

  useEffect(() => setValue(query), [query]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigateToQuery(value);
  };

  return (
    <form className='global-search' role='search' onSubmit={submit}>
      <label className='sr-only' htmlFor='global-search-input'>
        {language === 'zh' ? '搜索知识库' : 'Search knowledge hub'}
      </label>
      <input
        id='global-search-input'
        type='search'
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={language === 'zh' ? '搜索技术、销售、岗位…' : 'Search tech, sales, roles…'}
      />
      <button type='submit'>{language === 'zh' ? '搜索' : 'Search'}</button>
      {query && (
        <button
          className='search-clear'
          type='button'
          onClick={() => {
            setValue('');
            navigateToQuery('');
          }}
        >
          {language === 'zh' ? '清除' : 'Clear'}
        </button>
      )}
    </form>
  );
}
