import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidatePaths, resolveBase } from './select-checks.mjs';

export function localLinks(markdown, file) {
  // Fenced examples and inline code are not actual document navigation.
  const body = markdown.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '').replace(/`[^`\n]*`/g, '');
  const destinations = [...body.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)]
    .map(match => match[1].replace(/^<|>$/g, ''));
  return [...new Set(destinations.flatMap(raw => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(raw)) return [];
    const target = decodeURIComponent(raw.split(/[?#]/)[0]);
    if (!target) return [];
    const resolved = posix.normalize(posix.join(posix.dirname(file), target));
    if (resolved.startsWith('../')) throw new Error(`Link leaves repository: ${file} -> ${raw}`);
    return [resolved];
  }))];
}

export function validateTaskList(markdown) {
  const current = markdown.split('### 旧 G5–G7 处置')[0];
  const rows = [...current.matchAll(/^\| ((?:CORE|SAAS)-\d+) \|.*\| (PENDING|READY|IN_PROGRESS|BLOCKED|DONE) \|$/gm)];
  const ids = rows.map(row => row[1]);
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('Missing or duplicate active task IDs');
  if (rows.filter(row => row[2] === 'IN_PROGRESS').length > 1) throw new Error('More than one CRM task IN_PROGRESS');
}

export function checkDocuments(cwd, base, head) {
  const { paths, mergeBase } = candidatePaths(cwd, base, head);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const files = ref => new Set(git('ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean));
  const before = files(mergeBase), after = files(head);
  const exists = (set, target) => set.has(target) || [...set].some(path => path.startsWith(`${target.replace(/\/$/, '')}/`));
  const removed = [...before].filter(path => !after.has(path));
  const problems = [];
  let checked = 0;
  for (const file of after) {
    if (!file.endsWith('.md') || (!paths.includes(file) && removed.length === 0)) continue;
    const content = git('show', `${head}:${file}`);
    const previous = before.has(file) ? git('show', `${mergeBase}:${file}`) : '';
    const previousLinks = new Set(localLinks(previous, file));
    for (const target of localLinks(content, file)) {
      if (!exists(after, target) && (!previousLinks.has(target) || exists(before, target))) {
        problems.push(`${file} -> missing ${target}`);
      }
    }
    checked += 1;
    if (file === 'docs/商业版开发待办清单v1.md') {
      validateTaskList(content);
      const history = previous.split('## 8. 状态更新记录\n')[1]?.trimEnd();
      if (history && !content.split('## 8. 状态更新记录\n')[1]?.startsWith(history)) {
        problems.push('Commercial task history was rewritten');
      }
    }
  }
  // Task rules remain checked even when no Markdown changed.
  validateTaskList(git('show', `${head}:docs/商业版开发待办清单v1.md`));
  git('diff', '--check', mergeBase, head, '--');
  if (problems.length) throw new Error(problems.join('\n'));
  return { checkedDocuments: checked, candidatePaths: paths.length, headSha: head };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(checkDocuments(process.cwd(), resolveBase(process.cwd(), process.env.CI_BASE_SHA), process.env.CI_HEAD_SHA)));
}
