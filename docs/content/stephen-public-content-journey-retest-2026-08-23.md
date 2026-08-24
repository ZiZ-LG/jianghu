# 自我修养知识库｜30 条公开内容旅程复测报告

> 结论：`PASS / LOCAL RELEASE CANDIDATE`
>
> 复测对象：`codex/stephen-knowledge-hub`，内容代码提交 `477761347a2fd1c42280b891dd952b2a7299c6b9`
>
> 复测时间：2026-08-23（PDT）
>
> 边界：本报告只证明本地静态发布候选；未登录服务器、未部署生产、未切换流量、未合并 `main`、未启用自动发布。

## 1. 测试环境

- 本机 Vite production preview：`http://127.0.0.1:4174/`；
- 浏览器：gstack browse 启动的 Chromium；
- 视口：1280×720、768×1024、375×812；
- 静态产物：`app/dist/stephen/`；
- CI：[GitHub Actions 32691288870](https://github.com/ZiZ-LG/jianghu/actions/runs/32691288870)，12 个作业全部成功；
- 截图：
  - `/private/tmp/stephen-public-qa-2026-08-23/screenshots/home-desktop.png`
  - `/private/tmp/stephen-public-qa-2026-08-23/screenshots/home-tablet.png`
  - `/private/tmp/stephen-public-qa-2026-08-23/screenshots/home-mobile.png`

## 2. 公开内容契约

| 检查 | 结果 |
|---|---|
| 公开集合数量 | 30 条 |
| 发布状态 | 30/30 为 `approved` |
| 发布方式 | 30/30 为 `manual` |
| 审核状态 | 30/30 为 `review.status=approved` |
| 人工发布门 | `publicItems.ts` 显式列出 ST-001 至 ST-030；新增内容不会自动进入公开集合 |
| 纯 AI 技术占比 | 5/30，16.7%，低于 20% |
| 中国大陆事实支持 | 19/30，63.3%，高于 25% |
| 结论事实门 | 每条至少 2 项事实；跨组织判断至少 2 个独立 source ID |
| 深一层分析 | 每条均含机制、业务价值和适用边界 |
| 术语 | `Agent` 保留英文，不使用“代理”替换 |
| 构建扫描 | 30 个公开 ID、1 个公开版本标识、0 个 `pending_owner_review`、0 个 `/api/` 调用 |

逐条浏览器穿透 ST-001 至 ST-030：30/30 路由返回详情，30/30 无 404、无候选警告、无控制台错误；每条显示至少 2 项 supporting facts 和至少 2 个原始证据链接，ST-030 显示 3 个证据链接。

## 3. 用户旅程结果

### 首页、搜索和筛选

- 首页真实展示 5 条今日精选，页脚、运营主体和 `京ICP备2026046195号-2` 可见；
- 中文搜索“数据保留”命中 2 条；
- 英文原题搜索 `FORWARD DEPLOYED ENGINEER` 精确命中 FDE 条目；
- AI 技术 + 大客户销售的 AND 筛选返回 28 条，全部同时包含两域；切换 OR 返回 30 条；清除后恢复 30 条；
- 中英文外壳可切换，`html.lang` 在 `zh-CN` 与 `en` 间正确更新；英文正文缺失时明确显示 `Chinese content`，不伪造英文翻译。

### 内容详情、收藏和摘要

- 详情页展示标题、原文标题、事实层、机制、业务价值、边界、专题、工具和原始来源；
- ST-001 收藏后同时自动标记已读，刷新和进入“我的收藏”后状态仍保留；
- 日报显示 5 条、5 分钟、5 个信源、3/3 知识域；周报显示主线、持续事件、岗位变化和推荐工具；
- 公开页面未出现“终审候选 · 尚未公开”标签。

### 8 个工具与本机数据

- 8/8 工具均有独立 textarea、进度选择、复制 Markdown 和下载 `.md` 控件；
- 第一项工具完成编辑、`in_progress`、刷新恢复、复制和下载旅程；
- 状态改为 `completed` 后从“进行中工具”迁入“完成材料”；
- “清除全部本机数据”确认后，收藏、已读和工具材料全部归零；
- 手工写入损坏 JSON 后刷新，系统自动恢复为空状态并写回合法 v1 数据；
- 测试内容仅为虚构 QA 文本，不包含客户或商业敏感数据。

### 专题、岗位、学习路径和旧手册

- 6/6 专题直接访问成功，分别展示 5–11 条公开内容与 2–3 个相关工具；
- 岗位与组织页展示 13 条公开内容；
- 学习页展示 1/7/30/90 天四条路径，并保留 `/fieldbook/` 入口；
- `/fieldbook/` 直接返回 200，无 Google Fonts 请求；术语搜索 `RAG` 返回 2/32，任务进度从 0/14 变为 1/14，下一题和提示可用，明暗主题从 light 切到 dark 再切回；
- 主知识库存在系统级 `prefers-color-scheme: dark` 规则，旧手册提供显式主题按钮。

### 导航、响应式和可访问性

- 1280×720、768×1024、375×812 均无横向溢出；
- 768 与 375 宽度下 desktop nav 隐藏、四项 mobile nav 显示；
- 三个视口均展示 5 条今日精选并可纵向滚动；
- 首页可滚动到页脚；
- SPA 内部点击、前进、后退、详情深链刷新均保持正确路由；
- 第一次 Tab 聚焦“跳到正文”，Enter 后焦点进入 `main#main`；
- 全程控制台 0 错误；网络记录仅有本机 HTML、JS、CSS 与 `/fieldbook/` 请求，全部为 200/304，无意外 `/api/` 请求。

## 4. 自动化与构建证据

以下命令均在本次复测后重新运行并以退出码 0 完成：

- App TypeScript；
- Stephen 独立 TypeScript；
- App：30 files / 248 tests；
- Stephen：5 files / 35 tests；
- G64111 TypeScript：2 files / 32 tests；
- Server TypeScript；
- `npm run build`；
- `npm run build:stephen`；
- `npm run build:all`；
- `git diff --check`。

版本化本地静态包：

- 路径：`/private/tmp/stephen-knowledge-hub-4777613-final.tar.gz`
- 大小：156K
- SHA-256：`1fa52a5da28dd18f49deef43421a902407426dae0159fcbf242b6e1a4719cabb`
- 内容：根页、哈希 JS/CSS、favicon、`fieldbook/index.html`、`robots.txt`、`sitemap.xml`

## 5. QA 结论

| 类别 | 得分 | 说明 |
|---|---:|---|
| Console | 100 | 0 个错误 |
| Links | 100 | 所有测试内链成功；公开证据 href 完整且可追溯 |
| Visual | 100 | 三视口无布局阻断或横向溢出 |
| Functional | 100 | 搜索、筛选、详情、收藏、已读、摘要、工具和手册通过 |
| UX | 100 | 状态、空状态、刷新和清除流程清楚 |
| Performance | 100 | 本机首页与雷达 navigation total 均约 10ms |
| Content | 100 | 30 条人工批准内容全部进入公开集合 |
| Accessibility | 100 | 语义导航、键盘跳过链接、标签与移动布局通过 |
| **加权总分** | **100** | 本轮发现 0 个缺陷，修复 0 个，遗留 0 个本地内容旅程缺陷 |

PR 摘要：`QA found 0 issues in the owner-approved 30-item public journey; local health score 100 → 100.`

## 6. 仍需生产发布窗口验证

以下不是本地候选缺陷，也不在本次授权范围内：

- 在生产同版本 Nginx 上运行 `nginx -t`；
- 核验证书 SAN、真实 HTTPS、安全头、缓存和 `/api/` 404；
- 回归 `lake2ocean.top`、`crm.lake2ocean.top`、`zizai.tech` 和其他既有 Host；
- 在生产发布当日再次核验价格、法律、安全、隐私和易变岗位来源；
- 获取项目所有者明确的生产部署授权。

当前应停在生产发布批准门。
