# 自我修养三域知识库 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan status:** `SYNCHRONIZED / SAAS-601_IN_PROGRESS`
>
> **Current authorization:** 仅执行 `SAAS-601`。`SAAS-602`～`SAAS-604`、生产部署、流量切换、自动发布启用、`main` 合并和 CRM 变更均未授权。
>
> **Execution isolation:** branch `codex/stephen-knowledge-hub`; worktree `/Volumes/PowerData/江湖APP/.worktrees/stephen-knowledge-hub`; base `e20e6f76407389aefbac35ca184efbb5c2f83852`.

**Goal:** 将 `stephen.lake2ocean.top` 从单篇“AI 销售面试手册”升级为面向传统 To B 销售个人的“AI 技术 × 大客户销售 × AI 岗位与组织转型”行动型知识库，同时完整保留现有手册。

**Architecture:** 第一版采用独立的 React/Vite 静态内容应用，不接入 CRM 后端、租户数据库或用户身份系统。首发 30 条结构化内容全部人工终审后随构建发布；现有单文件手册迁移到 `/fieldbook/` 作为常青内容。后续只有来自 6–10 个白名单公开信源、通过确定性校验的低风险事实更新，才可在停止开关、审计、回退和独立发布批准齐备后自动发布；中高风险、来源冲突、评论性或证据不足内容始终进入人工审核。本轮 `SAAS-601` 只建立契约与独立构建外壳，不实现或启用自动发布。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、静态 JSON/TypeScript 内容、localStorage、Nginx、Docker、Let's Encrypt。

## Global Constraints

- 核心用户是正在从传统 To B 销售转向 AI 业务、AI 岗位或 AI 组织变革工作的个人，不面向企业管理后台。
- 本计划把用户列出的四个词归为三个知识域：`AI 技术`、`大客户销售`、`AI 岗位与组织转型`。
- 每条内容必须回答“发生了什么、为什么与目标用户有关、可用于什么场景、下一步能做什么、证据来自哪里”。
- 一手信源优先；官方事实、企业自述、媒体报道和编辑推断必须分层标识。
- 不转载无授权全文；默认只保存元数据、必要短摘要、自有分析与原文链接。来源登记必须记录转载政策。
- AI 可以辅助候选摘要、标签、翻译和影响分析，但不得修改白名单、降低风险等级或绕过批准状态。首发种子内容全部人工终审；后续低风险自动发布必须满足确定性规则和独立启用门。
- 不直接使用 AIHOT 数据构建商业产品；如未来调用其 API、RSS 或复制其内容，必须先取得书面商业授权。
- MVP 不新增账号、支付、论坛、公开投稿或 CRM API 权限。
- 第一阶段不提供 CRM 写入、携带客户参数跳转或共享数据；工具材料由用户在本机编辑、复制或下载为 Markdown。
- 保留现有手册的 8 个课程模块、32 个术语、45 项任务、22 道销售题与 6 道管理题。
- 首页每天展示 3–5 条精选内容，每周新增或实质更新 3–5 条；内容不足时少发，不以低价值内容凑数。
- 新知识库提供 1/7/30/90 天路径；旧手册既有 3/7/14/30 天任务和进度编号原样保留，两者只通过入口关联。
- 首发规模固定为 30 条人工终审内容、6 个专题和 8 个行动工具；工具材料可继续编辑、复制和下载，但不建设作品集生成、公开主页、统一包装或云端托管。
- 导航、按钮、状态、法律说明和页面元数据保留中英文；30 条内容、6 个专题和 8 个工具的完整中文是发布条件，英文正文不是第一阶段阻塞项。
- 页面继续展示 `京ICP备2026046195号-2`、运营主体和江湖生态入口。
- 不引入新的重依赖；MVP 复用 `app/package.json` 已有 React/Vite/Vitest。
- 实施必须在上述独立 worktree/分支进行，可推送 feature branch，但不得合并或推送 `main`。
- CRM `CORE-115` 正在 `/Volumes/PowerData/江湖APP/.worktrees/g3-lightweight-personal-crm` 独立执行；本计划不得进入该工作树，也不得修改 `docs/商业版开发待办清单v1.md`。
- `app/package.json` 是唯一共享文件例外，只允许追加 `build:stephen` 和 `build:all`；现有 `"build": "vite build"` 必须保持 CRM-only 语义。禁止修改 `app/vite.config.ts`，禁止增加依赖或改动 lockfile。
- 当前允许的实现文件仅限 `app/stephen/**`、`app/public/stephen/**`（只用于旧手册迁移）、`app/vite.stephen.config.ts`、`app/src/components/StephenSite.test.ts`、`deploy/stephen.nginx.conf`、`docs/content/stephen-*` 和两份 Stephen 方案文档。
- 禁止修改 `server/**`、`packages/**`、`server/prisma/**`、`docker-compose.yml`、`.env*`、CRM 组件/路由/Store/Action/DTO/权限/数据库、主站 Landing、CRM 外壳和主导航。

---

## 调研结论与产品边界

AIHOT 值得借鉴的不是栏目名称，而是底层内容加工方式：

1. 将“原始条目”与“事件”分开，同一事件的多家报道合并成持续更新的故事。
2. 以一手信源、发布时间、类别、摘要、推荐理由和证据数量帮助用户快速判断。
3. 同一批底层内容可以投影为精选流、热点榜、主题页、日/周/月报和 Agent/RSS/API 输出。
4. 主题同时覆盖实体、技术方向和内容形态，而不是只有单层分类。
5. 收藏、已读状态和反馈先采用低成本本机能力，不强制登录。
6. 对版权、AI 摘要误差、纠错删除和商业使用边界作公开说明。

第一版不照搬的能力：泛 AI 全量信息流、单一 AI 分数、模型排行榜、匿名公共 API/MCP、站内全文转载和未经验证的实时热点。它们会增加噪声、版权风险与维护成本，却不能直接证明目标用户获得了销售或职业行动。

## 产品信息架构

桌面端一级栏目：

1. `今日必读`：每天展示 3–5 条经过审核、与目标用户高度相关的变化。
2. `三域雷达`：AI 技术、大客户销售、岗位与组织三个视角及其交叉筛选。
3. `交叉专题`：围绕一个持续问题聚合事件、解释、方法和工具，例如 AI POC 到规模化、AI 采购委员会、Agent 商业化、AI 岗位能力地图。
4. `方法工具`：访谈提纲、客户研究、价值假设、业务案例、POC 设计、采用计划、面试与转岗工具。
5. `岗位与组织`：AI 商业岗位、职责变化、能力证据、组织采用与变革方法。
6. `学习路径`：新知识库提供 1/7/30/90 天路线；现有完整手册放在 `/fieldbook/`，内部 3/7/14/30 天任务原样保留。
7. `我的收藏`：本机收藏、已读和学习进度。

移动端底部导航只保留 `今日｜专题｜工具｜我的`，分别对应桌面端的 `今日必读｜雷达专题｜方法工具｜我的收藏`，其余入口放入对应栏目。

## 内容对象与展示契约

```ts
export type KnowledgeDomain =
  | 'ai_technology'
  | 'enterprise_sales'
  | 'role_org';

export type LocalizedText = {
  zh: string;
  en?: string;
};

export type ContentKind =
  | 'update'
  | 'event'
  | 'explainer'
  | 'case'
  | 'method'
  | 'tool'
  | 'role'
  | 'learning_path';

export type EvidenceLevel =
  | 'official'
  | 'multi_source'
  | 'single_source'
  | 'practitioner_opinion'
  | 'editorial_inference';

export type RiskLevel = 'low' | 'medium' | 'high';
export type PublicationMode = 'manual' | 'allowlisted_low_risk_auto';
export type EditorialStatus = 'candidate' | 'approved' | 'archived';

export interface PublicationAudit {
  sourceFingerprint: string;
  ruleVersion: string;
  processedAt: string;
  releaseVersion: string;
  rollbackState: 'available' | 'rolled_back';
}

export interface EvidenceRef {
  id: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt: string;
  level: EvidenceLevel;
  language: 'zh' | 'en';
}

export interface KnowledgeItem {
  id: string;
  slug: string;
  title: LocalizedText;
  summary: LocalizedText;
  kind: ContentKind;
  domains: KnowledgeDomain[];
  topicSlugs: string[];
  audience: Array<'transitioning_seller' | 'ai_ae' | 'sales_leader' | 'solution' | 'customer_success'>;
  publishedAt: string;
  updatedAt: string;
  freshness: 'breaking' | 'current' | 'evergreen';
  whyItMatters: LocalizedText;
  salesImplication: LocalizedText;
  roleOrgImplication: LocalizedText;
  nextAction: LocalizedText;
  evidence: EvidenceRef[];
  relatedItemIds: string[];
  editorialStatus: EditorialStatus;
  riskLevel: RiskLevel;
  publicationMode: PublicationMode;
  seedContent: boolean;
  audit: PublicationAudit;
}

export const KNOWLEDGE_PATH_DAYS = [1, 7, 30, 90] as const;
export const LEGACY_FIELDBOOK_PATH_DAYS = [3, 7, 14, 30] as const;
```

公开卡片固定显示：三域标签、时间、标题、一句话事实、`为什么与你有关`、`下一步行动`、证据等级和原文入口。完整中文字段是公开集合的硬条件；英文正文可缺省，英文界面此时继续显示中文并标记 `Chinese content`。种子内容只能 `manual` 发布；`allowlisted_low_risk_auto` 只接受低风险、非种子、审计完整且来自已启用白名单的事实更新。通用热度或 AI 分数不能成为主要排序依据。

## 文件边界

```text
app/
  stephen/
    index.html                         # 独立知识库入口
    public/fieldbook/index.html        # 现有完整手册
    src/
      main.tsx
      App.tsx
      domain.ts                        # 内容契约
      content/
        items.ts                       # 已审核内容
        topics.ts                      # 交叉专题
        tools.ts                       # 方法工具
        sources.ts                     # 信源与授权登记
        validate.ts                    # 内容一致性校验
      components/
        KnowledgeCard.tsx
        EvidenceBadge.tsx
        Filters.tsx
        SearchBox.tsx
      pages/
        TodayPage.tsx
        RadarPage.tsx
        TopicPage.tsx
        ToolsPage.tsx
        RolesPage.tsx
        LibraryPage.tsx
        ItemPage.tsx
      state/localLibrary.ts            # 收藏、已读、进度
      styles.css
  vite.stephen.config.ts               # 独立静态构建到 dist/stephen
  src/components/StephenSite.test.ts   # 跨站与部署契约
deploy/stephen.nginx.conf              # 独立 Host 与缓存策略
docs/content/
  stephen-editorial-policy.md          # 编辑、证据与版权规则
  stephen-source-registry.md            # 信源清单与更新频率
```

当前 `SAAS-601` 只可使用上述路径中属于已授权文件边界的部分。旧线上基线只从提交 `f4ef4a9` 选择性迁移 `app/public/stephen/index.html`、`app/src/components/StephenSite.test.ts` 和 `deploy/stephen.nginx.conf`；禁止 cherry-pick 整个提交。迁移后旧手册进入 `app/stephen/public/fieldbook/index.html`，内容规模与备案/生态入口测试必须保持不变。

不得用新 Stephen 根页覆盖 `Landing.tsx`、`CultivationSection`、CRM 外壳或主站导航。不得修改 `app/vite.config.ts`。`app/package.json` 只能在保留既有脚本的前提下增加：

```json
{
  "build": "vite build",
  "build:stephen": "vite build --config vite.stephen.config.ts",
  "build:all": "npm run build && npm run build:stephen"
}
```

---

### Task 1: SAAS-601 固化旧站基线与新内容契约

**Files:**
- Modify: `app/src/components/StephenSite.test.ts`
- Create: `app/stephen/src/domain.ts`
- Create: `app/stephen/src/content/validate.ts`
- Create: `app/stephen/src/content/validate.test.ts`

**Interfaces:**
- Consumes: 从 `f4ef4a9` 选择性迁移的 `app/public/stephen/index.html`、`app/src/components/StephenSite.test.ts` 与 `deploy/stephen.nginx.conf`
- Produces: `KnowledgeItem`、`EvidenceRef`、风险/发布/审计类型、两套学习路径常量、`validateKnowledgeItems(items)` 与旧手册保护性契约

- [ ] **Step 1: Write the failing legacy preservation test**

  在 `StephenSite.test.ts` 增加断言：新站必须保留 `/fieldbook/` 链接，旧手册必须保留 8 个模块、32 个术语、45 项任务、22 道销售题、6 道管理题及备案/生态入口。测试同时锁定新路径 `1/7/30/90` 与旧手册路径 `3/7/14/30`，不得互相改写。

- [ ] **Step 2: Write the failing content validation tests**

  ```ts
  expect(() => validateKnowledgeItems([validItem])).not.toThrow();
  expect(() => validateKnowledgeItems([{ ...validItem, domains: [] }]))
    .toThrow('domains must not be empty');
  expect(() => validateKnowledgeItems([{ ...validItem, evidence: [] }]))
    .toThrow('evidence must not be empty');
  expect(() => validateKnowledgeItems([{ ...validItem, editorialStatus: 'candidate' }]))
    .toThrow('public collection contains non-approved item');
  expect(() => validateKnowledgeItems([{ ...validItem, title: { zh: '' } }]))
    .toThrow('Chinese content is required');
  expect(() => validateKnowledgeItems([{ ...validItem, title: { zh: '中文完整' } }]))
    .not.toThrow(); // English body is optional in phase one
  expect(() => validateKnowledgeItems([{ ...validItem, seedContent: true,
    publicationMode: 'allowlisted_low_risk_auto' }]))
    .toThrow('seed content requires manual approval');
  expect(() => validateKnowledgeItems([{ ...validItem, riskLevel: 'medium',
    publicationMode: 'allowlisted_low_risk_auto' }]))
    .toThrow('automatic publication requires low risk');
  ```

- [ ] **Step 3: Run the tests and verify RED**

  Run: `cd app && npm test -- src/components/StephenSite.test.ts stephen/src/content/validate.test.ts`

  Expected: FAIL because the typed contract, validator and `/fieldbook/` route do not exist.

- [ ] **Step 4: Implement the minimal domain contract and validator**

  实现本计划“内容对象与展示契约”的联合类型；校验唯一 ID/slug、ISO 时间、至少一个领域、至少一个证据、合法 HTTP(S) 原文、完整中文字段、只允许 `approved` 进入公开集合、种子内容必须人工批准，以及自动发布只允许低风险并具有完整审计信息。英文正文可选，不得成为校验失败原因。

- [ ] **Step 5: Run the targeted tests and commit**

  Run: `cd app && npm test -- src/components/StephenSite.test.ts stephen/src/content/validate.test.ts`

  Expected: PASS.

  Commit: `test(stephen): define knowledge content contract`

### Task 2: SAAS-601 建立独立知识库构建并保留完整手册

**Files:**
- Create: `app/stephen/index.html`
- Create: `app/stephen/src/main.tsx`
- Create: `app/stephen/src/App.tsx`
- Create: `app/stephen/src/styles.css`
- Create: `app/stephen/public/fieldbook/index.html`
- Create: `app/vite.stephen.config.ts`
- Modify: `app/package.json`
- Modify: `app/src/components/StephenSite.test.ts`

**Interfaces:**
- Consumes: Task 1 domain contract、现有完整手册
- Produces: `app/dist/stephen/index.html`、`app/dist/stephen/fieldbook/index.html`

- [ ] **Step 1: Add failing shell and build-contract assertions**

  先断言独立配置、双语外壳、四个一级入口、`/fieldbook/` 入口和构建脚本必须存在；断言既有 `build` 精确保持 `vite build`，没有 `build:main`，lockfile 与 `app/vite.config.ts` 不得改变。运行测试并观察因这些新文件/脚本尚不存在而 RED。

- [ ] **Step 2: Configure an isolated Stephen build**

  `vite.stephen.config.ts` 使用独立 `root`、相对资源 `base`、独立 `outDir` 和 `emptyOutDir: true`；不读取或改写 `app/vite.config.ts`，不改变 CRM 主应用入口。

- [ ] **Step 3: Preserve the legacy artifact**

  将选择性恢复的 `app/public/stephen/index.html` 迁移到 `app/stephen/public/fieldbook/index.html`。允许的唯一内容改动是把站内返回链接更新到新知识库首页；迁移前后 8/32/45/22/6、备案和生态入口测试必须相同。

- [ ] **Step 4: Add explicit build scripts**

  ```json
  {
    "build": "vite build",
    "build:stephen": "vite build --config vite.stephen.config.ts",
    "build:all": "npm run build && npm run build:stephen"
  }
  ```

  不增加依赖，不修改 lockfile。

- [ ] **Step 5: Implement the minimal bilingual shell**

  根页只实现 `SAAS-601` 外壳：中英文品牌/导航/状态/法律信息、`今日必读｜雷达专题｜方法工具｜我的收藏` 四个一级入口、三个知识域说明、1/7/30/90 天新路径入口和 `/fieldbook/` 完整旧手册入口。内容、专题、8 个工具、收藏状态和流水线属于后续任务，只显示诚实的未上线状态，不放入伪造数据。

- [ ] **Step 6: Build, verify and commit**

  Run:

  ```bash
  cd app && npm run typecheck && npm test
  npm run build
  npm run build:stephen
  npm run build:all
  ```

  Expected: `npm run build` 仍只生成 CRM 主应用；`build:stephen` 生成 `dist/stephen/index.html` 与 `dist/stephen/fieldbook/index.html`；`build:all` 串行生成两者；所有测试通过，CRM 入口、`app/vite.config.ts` 和 lockfile 均无差异。

  Commit: `feat(stephen): add standalone knowledge hub shell`

> **STOP GATE:** 完成上述两项并提交 `SAAS-601` 证据后必须停止。以下 `SAAS-602`～`SAAS-604` 仅保留为后续顺序计划，当前不得创建其内容、页面、状态、流水线、发布候选或生产部署。

### Task 3: SAAS-602 建立首批可信内容与信源治理

**Files:**
- Create: `app/stephen/src/content/items.ts`
- Create: `app/stephen/src/content/topics.ts`
- Create: `app/stephen/src/content/tools.ts`
- Create: `app/stephen/src/content/sources.ts`
- Create: `docs/content/stephen-editorial-policy.md`
- Create: `docs/content/stephen-source-registry.md`
- Create: `app/stephen/src/content/content.test.ts`

**Interfaces:**
- Consumes: Task 1 contract and validator
- Produces: `knowledgeItems`、`knowledgeTopics`、`knowledgeTools`、`sourceRegistry`

- [ ] **Step 1: Write the failing editorial fixture tests**

  首批公开集合必须至少包含 30 条内容、6 个交叉专题和 8 个可执行工具；三个领域各至少 10 条，至少 12 条内容同时命中两个领域，所有最新条目必须有发布时间和一手或多源证据。

- [ ] **Step 2: Define the source registry**

  每个信源记录 `id`、`name`、`homepage`、`kind`、`authority`、`language`、`cadence`、`redistributionPolicy`、`active`。第一批只启用官方产品/研究、招聘页、公开研究机构、可信商业媒体和明确署名的一线实践者。

- [ ] **Step 3: Author the first approved collection**

  首批 30 条内容全部经过人工终审，比例固定为：10 条 AI 技术解释/更新、8 条复杂销售方法、6 条 AI 岗位变化、6 条组织转型与采用；至少 12 条包含“下一步行动”和配套工具链接。30 条内容、6 个专题和 8 个工具必须有完整中文；英文正文可缺省并明确标记，不阻塞该任务。

- [ ] **Step 4: Document publication rules**

  编辑政策必须写明：事实与推断分离、一手优先、双源校验条件、摘要长度、链接失效处理、纠错删除流程、AI 生成标识、商业授权边界和每季度失效审查。

- [ ] **Step 5: Test and commit**

  Run: `cd app && npm test -- stephen/src/content/content.test.ts`

  Expected: PASS with all coverage and provenance rules satisfied.

  Commit: `content(stephen): seed three-domain knowledge collection`

### Task 4: SAAS-602 实现今日、雷达、专题、工具与详情页

**Files:**
- Create: `app/stephen/src/components/KnowledgeCard.tsx`
- Create: `app/stephen/src/components/EvidenceBadge.tsx`
- Create: `app/stephen/src/components/Filters.tsx`
- Create: `app/stephen/src/pages/TodayPage.tsx`
- Create: `app/stephen/src/pages/RadarPage.tsx`
- Create: `app/stephen/src/pages/TopicPage.tsx`
- Create: `app/stephen/src/pages/ToolsPage.tsx`
- Create: `app/stephen/src/pages/RolesPage.tsx`
- Create: `app/stephen/src/pages/LibraryPage.tsx`
- Create: `app/stephen/src/pages/ItemPage.tsx`
- Create: `app/stephen/src/navigation.ts`
- Create: `app/stephen/src/navigation.test.ts`

**Interfaces:**
- Consumes: Task 3 public collections
- Produces: stable paths `/`、`/radar/`、`/topics/:slug/`、`/tools/`、`/roles/`、`/learn/`、`/items/:slug/`

- [ ] **Step 1: Write navigation and selection tests**

  测试今日页显示 3–5 条、按编辑优先级与时间排序；不足 3 条高价值内容时允许少发而不是凑数；领域筛选采用 AND/OR 显式模式；不存在的 slug 返回站内 404；所有卡片都有 `whyItMatters`、`nextAction` 和证据入口。

- [ ] **Step 2: Implement stable client-side routing without a new router dependency**

  复用轻量路径解析，支持浏览器前进/后退和可分享 URL；Nginx 继续用 `try_files ... /index.html` 回退。

- [ ] **Step 3: Implement the content pages**

  首页先显示“今日 3–5 条”，再显示三域交叉专题和工具入口；详情页固定区分事实摘要、销售含义、岗位/组织含义、下一步行动和证据。

- [ ] **Step 4: Add responsive navigation**

  桌面显示完整七栏目；375 px 宽度显示四项底部导航，内容不横向溢出，正文保持可滚动。

- [ ] **Step 5: Test, build and commit**

  Run: `cd app && npm run typecheck && npm test -- stephen/src/navigation.test.ts && npm run build:stephen`

  Expected: PASS and all stable paths render from the production build.

  Commit: `feat(stephen): ship three-domain knowledge experience`

### Task 5: SAAS-603 增加搜索、收藏、已读与学习状态

**Files:**
- Create: `app/stephen/src/components/SearchBox.tsx`
- Create: `app/stephen/src/state/localLibrary.ts`
- Create: `app/stephen/src/state/localLibrary.test.ts`
- Modify: `app/stephen/src/App.tsx`
- Modify: `app/stephen/src/pages/LibraryPage.tsx`

**Interfaces:**
- Consumes: `KnowledgeItem[]`
- Produces: `searchKnowledge(query, filters)`、`getLibraryState()`、`toggleBookmark(id)`、`markRead(id)`、`setToolProgress(id, state)`

- [ ] **Step 1: Write failing state and search tests**

  测试中英文大小写无关搜索、标题/摘要/标签/行动命中、非法 localStorage 自动回退、删除不存在 ID 幂等，以及换版本后保留仍存在的收藏。

- [ ] **Step 2: Implement versioned local state**

  使用 key `stephen-knowledge-library-v1`，保存 `bookmarkedIds`、`readIds`、`toolProgress` 和 `updatedAt`；页面明确提示本机数据不会跨设备同步。

- [ ] **Step 3: Implement global search and personal library**

  搜索结果默认按相关性再按时间排序；“我的收藏”分为未读、已读、工具进行中、已完成材料和完整手册进度入口。工具材料必须能继续编辑、复制为纯文本并下载为 Markdown，只保存在本机；不提供作品集打包、公开主页、云端分享或 CRM 写入。

- [ ] **Step 4: Test and commit**

  Run: `cd app && npm test -- stephen/src/state/localLibrary.test.ts && npm run build:stephen`

  Expected: PASS.

  Commit: `feat(stephen): add local search and learning library`

### Task 6: SAAS-603 建立每日编辑候选流程与摘要机制

**Files:**
- Create: `docs/content/stephen-daily-editorial-runbook.md`
- Create: `app/stephen/src/content/digests.ts`
- Create: `app/stephen/src/content/digests.test.ts`
- Create: `app/stephen/src/pages/DigestPage.tsx`
- Modify: `app/stephen/src/navigation.ts`

**Interfaces:**
- Consumes: approved `KnowledgeItem[]`
- Produces: `DailyDigest`、weekly digest projections 与受控发布规则；无公开 crawler 或 auto-publish endpoint

- [ ] **Step 1: Define the deterministic digest contract**

  日报展示 3–5 条内容、三域覆盖、预计阅读时长、来源数量和“今天该做什么”；每周新增或实质更新 3–5 条，周报包含本周主线、持续事件、岗位变化与推荐工具。

- [ ] **Step 2: Write failing digest tests**

  测试日报不得包含候选/归档项，不得重复同一事件，不得只有单一领域；没有足够高价值内容时允许少发而不是凑数。

- [ ] **Step 3: Document the daily workflow**

  每日流程固定为：检查 6–10 个白名单公开信源 → 生成候选 → 去重/事件归组 → 核对一手证据 → 补充用户含义和行动 → 确定性风险分级 → 运行内容测试 → 构建预览 → 发布。首批 30 条全部人工批准；之后只有低风险、白名单、无冲突、字段与审计完整的事实更新可在独立批准启用后自动公开。中高风险、第三方评论、来源冲突或证据不足内容必须人工审核。AI 不能自行降级风险或绕过批准状态。

- [ ] **Step 4: Implement digest projections and commit**

  Run: `cd app && npm test -- stephen/src/content/digests.test.ts && npm run build:stephen`

  Expected: PASS.

  Commit: `feat(stephen): add reviewed daily and weekly digests`

### Task 7: SAAS-604 完成合规、可访问性与生产验收

**Files:**
- Modify: `deploy/stephen.nginx.conf`
- Modify: `app/src/components/StephenSite.test.ts`
- Create: `docs/content/stephen-release-checklist.md`

**Interfaces:**
- Consumes: complete production build
- Produces: deployable `dist/stephen` and rollback evidence

- [ ] **Step 1: Extend the deployment contract tests**

  断言 hashed assets 长缓存、HTML 不缓存、`/api/` 404、SPA 路由回退、备案与隐私/版权/纠错入口存在。

- [ ] **Step 2: Run all repository gates**

  Run（未来 `SAAS-604` 获单独授权后）：

  ```bash
  cd app && npm run typecheck && npm test && npm run build && npm run build:stephen
  cd ../packages/g64111 && npm run typecheck && npm test
  cd ../../server && npx tsc --noEmit
  git diff --check
  ```

  Expected: every command exits 0.

- [ ] **Step 3: Browser-test desktop and mobile**

  在 1280×720 和 375×812 验证：滚动、搜索、筛选、返回位置、详情证据、收藏、完整手册、深浅色、中文长标题、无横向溢出、无控制台错误。

- [ ] **Step 4: Run a versioned candidate deployment**

  仅在项目所有者另行批准生产发布后，构建新静态目录，创建候选镜像，运行 `nginx -t`，检查 `lake2ocean.top`、`crm.lake2ocean.top`、`stephen.lake2ocean.top`、`zizai.tech` 与 BJJ Host 均正常后再切换流量。本轮禁止执行本步骤。

- [ ] **Step 5: Verify public behavior and record rollback**

  验证 HTTPS、证书 SAN、主要路径、静态缓存、安全头、备案链接和 `/api/` 隔离；保存旧镜像、回滚命令、状态码和截图。

  Commit: `chore(stephen): complete knowledge hub release gates`

---

## 后续阶段，不进入 MVP

### Phase 2：半自动聚合

- 为每个允许的信源增加 RSS/API/网页适配器，先写候选队列；只有已通过独立启用门的白名单低风险事实更新可自动批准，中高风险与评论性内容继续人工审核。
- 增加内容指纹、相似度去重、事件聚类、链接失效检测与人工审核台。
- 目标更新节奏为每日 1–2 次，不追求分钟级全网覆盖。
- 把“热度”改为“目标用户价值”：相关性、可行动性、证据质量、三域交叉度、新颖性和时效性分别可解释。

### Phase 3：可选账号同步与集成评估

- 用户选择当前目标：转岗、面试、客户研究、商机推进或组织采用。
- 收藏和学习进度可选账号同步，但知识服务与 CRM 租户库物理隔离。
- 不默认建设 CRM 写入桥。任何未来集成都必须另写 ADR，重新评估租户隔离、权限、客户数据边界和用户确认机制，并由项目所有者单独批准；本计划不把它作为既定路线。

### Phase 4：分发能力

- 在内容质量和更新稳定性被验证后，再提供自己的 RSS、REST、MCP 或 Agent Skill。
- API 采用版本化字段、ETag、快照 + 增量游标和明确商业使用规则。
- 不建设 AIHOT 镜像；所有输出来自江湖自有信源登记、编辑判断和行动化加工。

## 成功指标

MVP 北极星指标是“每周被执行的知识行动数”，不是页面浏览量。首批 50 人以内用户重点观察：

- 精选条目进入详情的比例。
- 详情到收藏、工具启动或完整手册任务的转化。
- 用户能否复述“这条变化对我的客户/岗位有什么影响”。
- 一周内至少完成一次工具或学习任务的活跃用户比例。
- 内容发布到纠错的比例、重复率、失效链接率和无证据推断率。
- 6–8 名销售朋友使用一周后的行为访谈：让用户展示实际收藏、工具产出和客户行动，不只收集满意度；至少 6 个有效样本后才作阶段量化判断。

只有当“条目 → 行动”持续发生，且内容质量、人工终审样本、停止开关和回退演练通过后，才讨论扩大自动聚合或账号同步。CRM 集成不因这些指标自动进入开发，仍需独立决策。
