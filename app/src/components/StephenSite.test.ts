// @ts-expect-error Vitest runs in Node; the browser app intentionally does not load global Node typings.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const siteUrl = new URL('../../public/stephen/index.html', import.meta.url);
const nginxUrl = new URL('../../../deploy/stephen.nginx.conf', import.meta.url);

function readRequiredFile(url: URL) {
  const exists = existsSync(url);
  expect(exists, `missing ${url.pathname}`).toBe(true);
  return exists ? readFileSync(url, 'utf8') : '';
}

function extract(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern);
  expect(match, `missing ${label} data block`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('Stephen self-cultivation site', () => {
  it('preserves the complete source curriculum and interactive fieldbook', () => {
    const html = readRequiredFile(siteUrl);
    const syllabus = extract(html, /const syllabus = \[(.*?)\n\s*\];\n\n\s*const glossary/s, 'syllabus');
    const glossary = extract(html, /const glossary = \[(.*?)\n\s*\];\n\n\s*const plans/s, 'glossary');
    const plans = extract(html, /const plans = \{(.*?)\n\s*\};\n\n\s*const questions/s, 'plans');
    const questions = extract(html, /const questions = \[(.*?)\n\s*\];\n\n\s*function loadState/s, 'questions');

    expect(syllabus.match(/\bcode: "M\d{2}"/g)).toHaveLength(8);
    expect(glossary.match(/^\s*\["/gm)).toHaveLength(32);
    expect(plans.match(/\bid: "(?:3|7|14|30)-\d+"/g)).toHaveLength(45);
    expect(questions.match(/\bid: "S\d{2}"/g)).toHaveLength(22);
    expect(questions.match(/\bid: "M\d{2}"/g)).toHaveLength(6);

    for (const sectionId of [
      'definition',
      'profile',
      'literacy',
      'preparation',
      'answering',
      'questions',
      'interview-day',
      'future',
      'sources',
    ]) {
      expect(html).toContain(`id="${sectionId}"`);
    }

    expect(html).toContain('id="glossarySearch"');
    expect(html).toContain('id="nextQuestion"');
    expect(html).toContain('id="themeToggle"');
    expect(html).toContain('id="printButton"');
    expect(html).toContain('ai-sales-interview-fieldbook-v2');
  });

  it('connects the fieldbook to the Jianghu ecosystem and filing identity', () => {
    const html = readRequiredFile(siteUrl);

    expect(html).toContain('href="https://lake2ocean.top"');
    expect(html).toContain('href="https://crm.lake2ocean.top"');
    expect(html).toContain('href="https://beian.miit.gov.cn/"');
    expect(html).toContain('京ICP备2026046195号-2');
    expect(html).toContain('自在创造（北京）智慧科技有限公司');
    expect(html).toContain('<link rel="canonical" href="https://stephen.lake2ocean.top/">');
  });

  it('defines an isolated HTTPS static host with no API surface', () => {
    const nginx = readRequiredFile(nginxUrl);

    expect(nginx).toContain('server_name stephen.lake2ocean.top;');
    expect(nginx).toContain('return 301 https://stephen.lake2ocean.top$request_uri;');
    expect(nginx).toContain('/etc/letsencrypt/live/stephen.lake2ocean.top/fullchain.pem');
    expect(nginx).toContain('root /usr/share/nginx/jianghu/stephen;');
    expect(nginx).toMatch(/location \^~ \/api\/\s*\{\s*return 404;/);
  });
});
