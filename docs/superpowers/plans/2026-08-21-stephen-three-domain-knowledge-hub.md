# 自我修养三域知识库 MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan status:** `SYNCHRONIZED / SAAS-601_COMPLETE / SAAS-602_IMPLEMENTED_OWNER_REVIEW_PENDING / SAAS-603_COMPLETE / SAAS-604_LOCAL_RC_COMPLETE / PRODUCTION_NOT_AUTHORIZED`
>
> **Current authorization:** `SAAS-601` 已完成。项目所有者已授权按 `SAAS-602 → SAAS-603 → SAAS-604` 持续形成发布候选；生产部署、流量切换、自动发布启用、`main` 合并和 CRM 变更仍未授权。
>
> **Execution isolation:** branch `codex/stephen-knowledge-hub`; worktree `/Volumes/PowerData/江湖APP/.worktrees/stephen-knowledge-hub`; base `e20e6f76407389aefbac35ca184efbb5c2f83852`.

**Goal:** 将 `stephen.lake2ocean.top` 从单篇“AI 销售面试手册”升级为面向传统 To B 销售个人的“AI 技术 × 大客户销售 × AI 岗位与组织转型”行动型知识库，同时完整保留现有手册。

**Architecture:** 第一版采用独立的 React/Vite 静态内容应用，不接入 CRM 后端、租户数据库或用户身份系统。首发 30 条结构化内容先保持候选状态，集中完成人工终审后才进入公开集合并随构建发布；现有单文件手册迁移到 `/fieldbook/` 作为常青内容。后续只有来自 6–10 个白名单公开信源、通过确定性校验的低风险事实更新，才可在停止开关、审计、回退和独立发布批准齐备后自动发布；中高风险、来源冲突、评论性或证据不足内容始终进入人工审核。自动发布默认关闭，本轮只形成发布候选，不启用生产发布。

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

桌面端与移动端一级栏目均固定为四项：

1. `今日必读`：每天展示 3–5 条经过审核、与目标用户高度相关的变化。
2. `雷达专题`：承载 AI 技术、大客户销售、岗位与组织三个视角、交叉筛选、6 个专题及岗位与组织入口。
3. `方法工具`：承载 8 个行动工具、1/7/30/90 天学习路径和完整旧手册入口。
4. `我的收藏`：承载本机收藏、已读、工具进度和已完成材料。

移动端使用短标签 `今日｜专题｜工具｜我的`。专题页、岗位与组织页、学习页、工具页和详情页保留独立固定链接，但不增加平级一级导航。

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
    public/robots.txt                  # 抓取边界；本机收藏不参与索引
    public/sitemap.xml                 # 仅列出已批准公开固定路由
    src/
      main.tsx
      App.tsx
      domain.ts                        # 内容契约
      content/
        items.ts                       # 终审候选；不进入生产应用依赖图
        publicItems.ts                 # 生产公开集合；只接收项目所有者已批准内容
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

**Interfaces:**
- Consumes: 从 `f4ef4a9` 选择性迁移的 `app/public/stephen/index.html`、`app/src/components/StephenSite.test.ts` 与 `deploy/stephen.nginx.conf`
- Produces: `KnowledgeItem`、`EvidenceRef`、风险/发布/审计类型、两套学习路径常量、`validateKnowledgeItems(items)` 与旧手册保护性契约

- [x] **Step 1: Write the failing legacy preservation test**

  先用现有 `app/public/stephen/index.html` 锁定旧手册源：必须保留 8 个模块、32 个术语、45 项任务、22 道销售题、6 道管理题及备案/生态入口。内容契约同时锁定新路径 `1/7/30/90` 与旧手册路径 `3/7/14/30`，不得互相改写；目标 `/fieldbook/` 路径的失败测试和迁移留在 Task 2，保证两个任务都能独立 RED → GREEN。

- [x] **Step 2: Write the failing content validation tests**

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

- [x] **Step 3: Run the tests and verify RED**

  Run: `cd app && npm test -- src/components/StephenSite.test.ts`

  Expected: FAIL because the typed contract and validator do not exist;既有旧手册源完整性断言继续 PASS。

- [x] **Step 4: Implement the minimal domain contract and validator**

  实现本计划“内容对象与展示契约”的联合类型；校验唯一 ID/slug、ISO 时间、至少一个领域、至少一个证据、合法 HTTP(S) 原文、完整中文字段、只允许 `approved` 进入公开集合、种子内容必须人工批准，以及自动发布只允许低风险并具有完整审计信息。英文正文可选，不得成为校验失败原因。

- [x] **Step 5: Run the targeted tests and commit**

  Run: `cd app && npm test -- src/components/StephenSite.test.ts`

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

- [x] **Step 1: Add failing shell and build-contract assertions**

  先断言独立配置、双语外壳、四个一级入口、`/fieldbook/` 入口和目标旧手册必须存在，并在目标文件上重复 8/32/45/22/6 与备案/生态入口完整性断言；断言既有 `build` 精确保持 `vite build`，没有 `build:main`，lockfile 与 `app/vite.config.ts` 不得改变。运行测试并观察因这些新文件/脚本尚不存在而 RED。

- [x] **Step 2: Configure an isolated Stephen build**

  `vite.stephen.config.ts` 使用独立 `root`、与独立二级域名根路径一致的 `base: '/'`、独立 `outDir` 和 `emptyOutDir: true`；这样 `/fieldbook/` 及后续固定链接都从 Stephen Host 根目录解析资源。配置不读取或改写 `app/vite.config.ts`，不改变 CRM 主应用入口。

- [x] **Step 3: Preserve the legacy artifact**

  将选择性恢复的 `app/public/stephen/index.html` 迁移到 `app/stephen/public/fieldbook/index.html`。允许的唯一内容改动是把站内返回链接更新到新知识库首页；迁移前后 8/32/45/22/6、备案和生态入口测试必须相同。

- [x] **Step 4: Add explicit build scripts**

  ```json
  {
    "build": "vite build",
    "build:stephen": "vite build --config vite.stephen.config.ts",
    "build:all": "npm run build && npm run build:stephen"
  }
  ```

  不增加依赖，不修改 lockfile。

- [x] **Step 5: Implement the minimal bilingual shell**

  根页只实现 `SAAS-601` 外壳：中英文品牌/导航/状态/法律信息、`今日必读｜雷达专题｜方法工具｜我的收藏` 四个一级入口、三个知识域说明、1/7/30/90 天新路径入口和 `/fieldbook/` 完整旧手册入口。内容、专题、8 个工具、收藏状态和流水线属于后续任务，只显示诚实的未上线状态，不放入伪造数据。

- [x] **Step 6: Build, verify and commit**

  Run:

  ```bash
  cd app && npm run typecheck && npm test
  npm run build
  npm run build:stephen
  npm run build:all
  ```

  Expected: `npm run build` 仍只生成 CRM 主应用；`build:stephen` 生成 `dist/stephen/index.html` 与 `dist/stephen/fieldbook/index.html`；`build:all` 串行生成两者；所有测试通过，CRM 入口、`app/vite.config.ts` 和 lockfile 均无差异。

  Commit: `feat(stephen): add standalone knowledge hub shell`

> **SAAS-601 GATE RECORD:** 上述两项已完成并留下验证证据。项目所有者随后授权继续执行 `SAAS-602`～`SAAS-604` 发布候选；生产部署、流量切换、自动发布启用、`main` 合并和 CRM 变更仍禁止。

`SAAS-601` 完成证据（2026-08-23）：

- 基线：`e20e6f76407389aefbac35ca184efbb5c2f83852`；
- 方案同步：`335e713`；线上旧站选择性迁移：`007defd`；内容契约：`bc20e68`；独立外壳：`6b6aa01`；
- TDD：内容契约先出现 2 个预期失败，外壳先出现 2 个预期失败；修复 favicon 与文档语言属性时各追加一次 RED → GREEN；
- 前端：30 个测试文件、245 项测试通过；CRM 与 Stephen TypeScript 检查通过；
- 构建：`npm run build` 保持 CRM-only，`build:stephen` 与 `build:all` 产物完整；
- 浏览器：1280×720 与 375×812 通过；移动端 `scrollWidth=375`、`scrollY=900`、`scrollHeight=2874`；中英文切换后文档 `lang=en`；根页与 `/fieldbook/` 控制台 0 错误；
- 明确未做：30 条内容、6 个专题、8 个工具、收藏状态、内容流水线、自动发布、生产部署、流量切换、CRM 变更和 `main` 合并。

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
- Produces: `seedCandidates`（终审候选）、空的 `approvedKnowledgeItems`（终审后才写入）、`knowledgeTopics`、`knowledgeTools`、`sourceRegistry`

- [x] **Step 1: Write the failing editorial fixture tests**

  首批终审候选集合必须包含 30 条内容、6 个交叉专题和 8 个可执行工具；三个领域各至少 10 条，至少 12 条内容同时命中两个领域，所有最新条目必须有发布时间和一手或多源证据。项目所有者终审前，公开集合必须保持为空。

- [x] **Step 2: Define the source registry**

  每个信源记录 `id`、`name`、`homepage`、`kind`、`authority`、`language`、`cadence`、`redistributionPolicy`、`active`。第一批只启用官方产品/研究、招聘页、公开研究机构、可信商业媒体和明确署名的一线实践者。

- [x] **Step 3: Author the first review collection**

  先完成首批 30 条候选及逐条核验材料，比例固定为：10 条 AI 技术解释/更新、8 条复杂销售方法、6 条 AI 岗位变化、6 条组织转型与采用；至少 12 条包含“下一步行动”和配套工具链接。30 条内容、6 个专题和 8 个工具必须有完整中文；英文正文可缺省并明确标记，不阻塞该任务。全部候选完成后集中生成一次“30 条内容终审包”交项目所有者批量审核；审核前保持 `candidate`，不得伪装成 `approved` 或进入生产公开集合。等待审核时继续执行所有不依赖终审的页面、工具、测试与文档。

- [x] **Step 4: Document publication rules**

  编辑政策必须写明：事实与推断分离、一手优先、双源校验条件、摘要长度、链接失效处理、纠错删除流程、AI 生成标识、商业授权边界和每季度失效审查。

- [x] **Step 5: Test and commit**

  Run: `cd app && npx vitest run --root stephen src/content/content.test.ts`

  Expected: PASS with all coverage and provenance rules satisfied；候选集合与公开集合严格分离，未经项目所有者批准的种子内容不会进入公开集合。

  Commit: `content(stephen): seed three-domain knowledge collection`

  Source-governance evidence（2026-08-23）：已通过项目规定的 `/browse` 实时打开并核验 10 个公开信源；登记文件、编辑与版权规则已建立；Stephen 独立测试必须使用 `npx vitest run --root stephen ...`，因为 CRM 主 Vitest 配置仅包含 `app/src/**/*.test.ts`。

  Seed-review evidence（2026-08-23）：先写入 30/6/8 规模、分类配比、三域覆盖、时效窗口、信源引用和候选/公开集合隔离断言并得到缺少 `items.ts` 的预期 RED；随后完成 30 条候选、6 个专题、8 个工具和 `docs/content/stephen-seed-review-package.md`。独立内容测试 5/5 通过，Stephen TypeScript 检查通过；全部种子仍为 `candidate + manual + pending_owner_review`，`approvedKnowledgeItems` 仍为空，等待项目所有者整批终审，不构成 SAAS-602 最终批准。

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
- Create: `app/stephen/src/pages/LearnPage.tsx`
- Create: `app/stephen/src/pages/LibraryPage.tsx`
- Create: `app/stephen/src/pages/ItemPage.tsx`
- Create: `app/stephen/src/content/publicItems.ts`
- Create: `app/stephen/src/navigation.ts`
- Create: `app/stephen/src/navigation.test.ts`

**Interfaces:**
- Consumes: Task 3 contracts、topics、tools 与独立的 production public collection；终审候选不进入生产应用依赖图
- Produces: stable paths `/`、`/radar/`、`/topics/`、`/topics/:slug/`、`/tools/`、`/roles/`、`/learn/`、`/library/`、`/items/:slug/`

- [x] **Step 1: Write navigation and selection tests**

  测试今日页显示 3–5 条、按编辑优先级与时间排序；不足 3 条高价值内容时允许少发而不是凑数；领域筛选采用 AND/OR 显式模式；不存在的 slug 返回站内 404；所有卡片都有 `whyItMatters`、`nextAction` 和证据入口。

- [x] **Step 2: Implement stable client-side routing without a new router dependency**

  复用轻量路径解析，支持浏览器前进/后退和可分享 URL；Nginx 继续用 `try_files ... /index.html` 回退。

- [x] **Step 3: Implement the content pages**

  首页先显示“今日 3–5 条”，再显示三域交叉专题和工具入口；详情页固定区分事实摘要、销售含义、岗位/组织含义、下一步行动和证据。

- [x] **Step 4: Add responsive navigation**

  桌面显示四个一级入口；专题、岗位与组织、学习和详情通过所属栏目进入并保留固定链接。375 px 宽度显示四项底部导航，内容不横向溢出，正文保持可滚动。

- [x] **Step 5: Test, build and commit**

  Run: `cd app && npm run typecheck && npx vitest run --root stephen src/navigation.test.ts && npm run build:stephen`

  Expected: PASS and all stable paths render from the production build.

  Commit: `feat(SAAS-602): ship three-domain knowledge experience`

  Page evidence（2026-08-23）：路由与选择测试先因缺少 `navigation.ts` 得到预期 RED，随后 6/6 通过；内容测试 5/5、Stephen TypeScript、主站 Stephen 保护测试和生产构建均通过。桌面一级导航严格保持四项，专题、岗位、学习和详情使用独立固定链接。浏览器实测 1280×720 与 375×812 无横向溢出，移动端四项导航、页面滚动、AND/OR 筛选、专题四段框架、详情证据、8 个工具和中英文外壳可用，控制台 0 错误；生产预览直接打开专题与工具固定链接返回 200。另在浏览器验证中发现“页面不显示候选但候选正文仍被打包”的隐性泄漏，随后以第二轮 RED → GREEN 增加 `publicItems.ts` 物理隔离：App 只静态导入生产公开集合，候选文件不在生产依赖图，构建产物不得含未终审正文。

### Task 5: SAAS-603 增加搜索、收藏、已读与学习状态

**Files:**
- Create: `app/stephen/src/components/SearchBox.tsx`
- Create: `app/stephen/src/state/localLibrary.ts`
- Create: `app/stephen/src/state/localLibrary.test.ts`
- Create: `app/stephen/src/state/search.ts`
- Create: `app/stephen/src/state/LibraryContext.tsx`
- Modify: `app/stephen/src/App.tsx`
- Modify: `app/stephen/src/components/KnowledgeCard.tsx`
- Modify: `app/stephen/src/pages/RadarPage.tsx`
- Modify: `app/stephen/src/pages/ToolsPage.tsx`
- Modify: `app/stephen/src/pages/ItemPage.tsx`
- Modify: `app/stephen/src/pages/LibraryPage.tsx`

**Interfaces:**
- Consumes: `KnowledgeItem[]`
- Produces: `searchKnowledge(query, filters)`、`getLibraryState()`、`toggleBookmark(id)`、`markRead(id)`、`setToolProgress(id, state)`

- [x] **Step 1: Write failing state and search tests**

  测试中英文大小写无关搜索、标题/摘要/标签/行动命中、非法 localStorage 自动回退、删除不存在 ID 幂等，以及换版本后保留仍存在的收藏。

- [x] **Step 2: Implement versioned local state**

  使用 key `stephen-knowledge-library-v1`，保存 `bookmarkedIds`、`readIds`、带状态的 `toolMaterials` 和 `updatedAt`；页面明确提示本机数据不会跨设备同步。

- [x] **Step 3: Implement global search and personal library**

  搜索结果默认按相关性再按时间排序；“我的收藏”分为未读、已读、工具进行中、已完成材料和完整手册进度入口。工具材料必须能继续编辑、复制为纯文本并下载为 Markdown，只保存在本机；不提供作品集打包、公开主页、云端分享或 CRM 写入。

- [x] **Step 4: Test and commit**

  Run: `cd app && npx vitest run --root stephen src/state/localLibrary.test.ts && npm run build:stephen`

  Expected: PASS.

  Commit: `feat(SAAS-603): add local search and learning library`

  Local-library evidence（2026-08-23）：状态与搜索测试先因缺少 `localLibrary.ts` 得到预期 RED，随后 7/7 通过；覆盖中文字段、英文原文标题、AND/OR、损坏 JSON 恢复、跨版本有效 ID 保留、幂等收藏/已读、单工具材料更新、清除和安全 Markdown 文件名。生产浏览器实测搜索跳转与查询回显、本机逐字自动保存、进度改为完成、刷新后材料仍在、我的收藏归档、复制 API 被拒时的 legacy fallback、Markdown 下载触发、损坏存储恢复为空状态；375×812 输入区无横向溢出且控制台 0 错误。所有内容与工具状态仅写当前浏览器 `localStorage`，不访问 CRM、账号或运行时后端。

### Task 6: SAAS-603 建立每日编辑候选流程与摘要机制

**Files:**
- Create: `docs/content/stephen-daily-editorial-runbook.md`
- Create: `app/stephen/src/content/pipeline.ts`
- Create: `app/stephen/src/content/pipeline.test.ts`
- Create: `app/stephen/src/content/digests.ts`
- Create: `app/stephen/src/content/digests.test.ts`
- Create: `app/stephen/src/pages/DigestPage.tsx`
- Modify: `app/stephen/src/App.tsx`
- Modify: `app/stephen/src/navigation.ts`

**Interfaces:**
- Consumes: approved `KnowledgeItem[]`
- Produces: `DailyDigest`、weekly digest projections 与受控发布规则；无公开 crawler 或 auto-publish endpoint

- [x] **Step 1: Define and test the deterministic candidate pipeline**

  候选管线必须完成规范 URL / 事件键 / 内容指纹三层去重、中文与证据字段校验、显式风险信号分级、自动资格判断、人工队列、确定性抽样，以及单条撤回与版本回滚审计。候选自带的风险等级不得影响确定性结果；生产发布默认关闭，停止开关默认合上。

- [x] **Step 2: Document the daily workflow and control gates**

  每日流程固定为：检查 6–10 个白名单公开信源 → 生成候选 → 去重/事件归组 → 核对一手证据 → 补充用户含义和行动 → 确定性风险分级 → 运行内容测试 → 构建预览 → 经批准发布。首批 30 条全部人工批准；之后只有低风险、白名单、无冲突、字段与审计完整的事实更新可在独立批准启用后自动公开。中高风险、第三方评论、来源冲突或证据不足内容必须人工审核。AI 不能自行降级风险或绕过批准状态。

- [x] **Step 3: Define the deterministic digest contract**

  日报展示 3–5 条内容、三域覆盖、预计阅读时长、来源数量和“今天该做什么”；每周新增或实质更新 3–5 条，周报包含本周主线、持续事件、岗位变化与推荐工具。

- [x] **Step 4: Write failing digest tests**

  测试日报不得包含候选/归档项，不得重复同一事件，不得只有单一领域；没有足够高价值内容时允许少发而不是凑数。

- [x] **Step 5: Implement digest projections and commit**

  Run: `cd app && npx vitest run --root stephen src/content/digests.test.ts src/navigation.test.ts && npm run build:stephen`

  Expected: PASS.

  Commits:

  - `feat(SAAS-603): add governed editorial pipeline`
  - `feat(SAAS-603): add reviewed daily and weekly digests`

  Pipeline evidence（2026-08-23）：测试先因缺少 `pipeline.ts` 得到预期 RED，安全证据 URL 断言也先得到预期 RED，随后 7/7 通过；覆盖默认双重关闭、低风险资格与实际发布分离、中高风险人工队列、种子/冲突/评论边界、缺失字段与非 HTTPS 证据拒绝、三层去重、确定性抽样和不丢历史的撤回/回滚审计。`npm run typecheck` 通过；当前 `autoPublishingEnabled=false` 且 `stopSwitchEngaged=true`，无 crawler、公网写入端点或生产发布动作。

  Digest evidence（2026-08-23）：测试先因缺少 `digests.ts` 得到预期 RED，`/digest/` 也先得到路由 RED，随后摘要 6/6、路由 6/6 通过；覆盖只读 `approved`、事件与规范 URL 去重、最多 5 条、三域优先覆盖、不凑数、阅读时长/信源/行动字段、周内新增或实质更新、本周主线/持续事件/岗位变化/推荐工具和非法日期拒绝。公开集合仍为空，新页诚实显示无简报，不依赖 `items.ts` 候选集合。

### Task 7: SAAS-604 完成合规、可访问性与生产验收

**Files:**
- Modify: `deploy/stephen.nginx.conf`
- Modify: `app/src/components/StephenSite.test.ts`
- Modify: `app/stephen/src/App.tsx`
- Modify: `app/stephen/src/navigation.ts`
- Modify: `app/stephen/src/pages/ItemPage.tsx`
- Modify: `app/stephen/src/styles.css`
- Modify: `app/stephen/public/fieldbook/index.html`
- Create: `app/stephen/src/pages/PolicyPage.tsx`
- Create: `app/stephen/public/robots.txt`
- Create: `app/stephen/public/sitemap.xml`
- Create: `docs/content/stephen-release-checklist.md`

**Interfaces:**
- Consumes: complete production build
- Produces: deployable `dist/stephen` and rollback evidence

- [x] **Step 1: Extend the deployment contract tests**

  断言 hashed assets 长缓存、HTML 不缓存、`/api/` 404、SPA 路由回退、备案与隐私/版权/纠错入口存在。

  Deployment-contract evidence（2026-08-23）：新断言先因缺少 assets/HTML 缓存 location 和 `PolicyPage.tsx` 得到 2 个预期 RED，随后 Stephen 保护测试 8/8、路由测试 6/6、TypeScript 和 Stephen 构建通过。新增 `/policy/` 及隐私/版权/纠错深链，复用已实时核验的主站 `#wuhu` 与 `cs@zizai.tech`，不新建论坛或后端表单。Nginx 新 location 重复保留安全头，避免 `add_header` 局部配置导致父级安全头不继承。

- [x] **Step 2: Run all repository gates**

  Run（已执行）：

  ```bash
  cd app
  npm run typecheck
  npm test
  npx vitest run --root stephen
  npm run build
  npm run build:stephen
  npm run build:all

  cd ../packages/g64111
  npm run typecheck
  npm test

  cd ../../server
  npx tsc --noEmit

  cd ..
  git diff --check
  ```

  Expected: every command exits 0.

  Gate evidence（2026-08-23，代码提交 `6c8f273`）：App TypeScript、30 files / 247 tests、CRM build；Stephen 5 files / 31 tests 与独立 build；G64111 TypeScript 与 2 files / 32 tests；Server TypeScript；`git diff --check` 全部退出 0。CRM 与 Stephen 产物串行构建后并存。后续 completion audit 又显式运行 `build:all`，并把泄漏扫描扩大到 69 个中文标题、英文原题、证据标题和原文 URL，生产包命中 0；无密钥、数据库或 `.env`，业务源码无 API 调用。`app/vite.config.ts`、lockfile、`server/**`、`packages/**`、CRM Action/DTO/Store 均无本分支差异。

- [x] **Step 3a: Browser-test the approved empty-collection baseline on desktop and mobile**

  在 1280×720 和 375×812 验证：滚动、搜索、筛选、返回位置、详情证据、收藏、完整手册、深浅色、中文长标题、无横向溢出、无控制台错误。

  Browser evidence（2026-08-23）：根页、雷达、六个专题、岗位、工具、学习、收藏、摘要、说明、旧手册及未批准详情 404 状态均可直接访问；移动端全部页面滚动到底，页脚不被固定导航遮挡；搜索、AND/OR、历史前进后退、工具保存/刷新/复制/下载/重置、工具进行中/完成/清除、损坏本机状态恢复、策略深链、旧手册术语/任务/题库/主题/打印均通过，控制台 0 错误。修复跳过链接焦点、旧手册 Google Fonts 外部请求和 375px 章节导航后复验通过。最终 Lighthouse mobile 为 Performance 100、Accessibility 100、Best Practices 100、SEO 100。

- [ ] **Step 3b: Re-test approved public-content journeys after owner review**

  30 条内容获逐条批准并进入 `publicItems.ts` 后，重跑公开卡片、真实详情证据与原文、收藏/已读及非空日报/周报；在此之前不得为测试而把候选注入生产集合。

- [ ] **Step 4: Run a versioned candidate deployment**

  仅在项目所有者另行批准生产发布后，构建新静态目录，创建候选镜像，运行 `nginx -t`，检查 `lake2ocean.top`、`crm.lake2ocean.top`、`stephen.lake2ocean.top`、`zizai.tech` 与 BJJ Host 均正常后再切换流量。本轮禁止执行本步骤。

- [ ] **Step 5: Verify public behavior and record rollback**

  验证 HTTPS、证书 SAN、主要路径、静态缓存、安全头、备案链接和 `/api/` 隔离；保存旧镜像、回滚命令、状态码和截图。

  Final evidence commit: `docs(SAAS-604): record Stephen local release candidate`

  Local candidate evidence（2026-08-23）：已生成未上传生产的 `/private/tmp/stephen-knowledge-hub-6c8f273.tar.gz`，SHA-256 为 `37562b57cf5d6898617146aa277e2a8f7a01d00d4b5e8e492e9c1b62f8dce386`。本机没有 Nginx，因此没有把字符串契约冒充真实 `nginx -t`；Step 4/5 仍受生产授权、证书和共享 Host 回归门约束。

  Completion audit evidence（2026-08-23）：按目标原文重新执行 App `typecheck`、247 项全量测试、31 项 Stephen 独立测试、`build`、`build:stephen` 与 `build:all`，并执行 G64111 类型检查/32 项测试、Server `npx tsc --noEmit`、`git diff --check` 和允许范围差异检查，全部通过。最终 Stephen 静态包同时包含根页、旧手册、爬虫控制和哈希资源；对 69 个候选中文标题、英文原题、证据标题及原文 URL 的精确扫描命中 0。提交 `ef3171e` 对应 GitHub Actions 运行 `32660677560` 的 12 个作业全部成功。除项目所有者内容终审及其后的公开内容旅程复测外，没有发现其他未完成的本地发布候选要求。

  SAAS-604 commits：

  - `77728c6 chore(SAAS-604): harden Stephen release contracts`
  - `64bec16 fix(SAAS-604): close Stephen browser QA gaps`
  - `6c8f273 feat(SAAS-604): publish Stephen crawl controls`

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
