# 自我修养知识库｜每日编辑与受控发布手册 v1

> 状态：`SAAS-606 / IMPLEMENTED-NOT-MERGED`
>
> 当前生产约束：自动发布未启用，停止开关已合上。SAAS-606 只增加非公开候选 manifest 和 GitHub Draft PR 人工审核门，不授权生产部署、流量切换或自动发布。

## 1. 目标与边界

每日编辑流程的目标不是追逐全网热点，而是从 6–10 个已登记公开信源中找出少量、可信、能促成行动的变化，并回答：

1. 发生了什么；
2. 为什么与传统 To B 销售转向 AI 业务有关；
3. 对大客户销售、AI 岗位或组织转型有什么影响；
4. 用户今天可以做什么；
5. 证据在哪里，事实、企业自述和编辑判断分别是什么。

禁止事项：

- 不抓取或转载受版权保护的全文，只登记元数据、必要短摘要、自有分析和原文链接；
- 不把企业案例、效果数字或厂商观点写成独立验证事实；
- 不使用 AIHOT 的数据、API、RSS 或正文，除非未来获得明确商业授权；
- 不接触 CRM、账号、客户数据、租户数据库或工具材料；
- 不向公网提供 crawler、候选写入接口或 auto-publish endpoint；
- AI 不得修改信源白名单、风险等级、审批状态、停止开关或发布记录。

## 2. 当前控制面

权威实现位于：

- 信源登记：`app/stephen/src/content/sources.ts`
- 内容校验：`app/stephen/src/content/validate.ts`
- 候选治理：`app/stephen/src/content/pipeline.ts`
- RSS 读取边界：`app/stephen/scripts/stephen-rss.ts`
- 发现记录与候选模型：`app/stephen/src/content/intake.ts`
- 可选 AI 文案边界：`app/stephen/scripts/stephen-editorial-ai.ts`
- 只读执行入口：`app/stephen/scripts/stephen-editorial-intake.ts`
- 每日审核契约：`app/stephen/scripts/stephen-daily-review.ts`
- 每日审核 CLI：`app/stephen/scripts/stephen-daily-review-cli.ts`
- 每日 Draft PR 工作流：`.github/workflows/stephen-daily-intake.yml`
- 公开集合：`app/stephen/src/content/publicItems.ts`

默认控制值：

```ts
{
  autoPublishingEnabled: false,
  stopSwitchEngaged: true,
  ruleVersion: 'stephen-editorial-v1',
  releaseVersion: 'unreleased'
}
```

这两个开关必须同时由项目所有者在独立发布批准中打开，低风险候选才可能进入 `auto_ready`。修改代码中的默认值、绕开停止开关或将候选直接加入公开集合，都不属于本阶段授权范围。

## 3. 每日节奏

### 3.1 扫描白名单

按 `stephen-source-registry.md` 和 `sources.ts` 中的频率管理 10 个已登记信源，但 SAAS-605 首期机器扫描仅启用两个已验证官方 RSS：OpenAI News 与 Google Cloud AI Blog。

- `twice_daily`：工作日上午和下午各一次；
- `daily`：每日一次；
- `weekly`：每周固定一天；
- `quarterly`：报告发布期或季度复核。

每次扫描只创建“发现记录”，至少包含：稳定候选 ID、`sourceId`、规范原文 URL、原文标题、发布时间、抓取时间、短摘要、短证据摘录、事件键、内容指纹、规则版本和 provenance。页面不可访问、发布时间不明、非 HTTPS、链接主机越界、来源不在登记表或证据冲突时进入 `manual_review`，不进入拟发布候选。

SAAS-606 的机器节奏固定为北京时间 `07:30` 和 `16:30`，GitHub Actions 分别使用 UTC cron `30 23 * * *` 和 `30 8 * * *`。同一天两次运行由全局 concurrency 串行执行，并复用同一个 `codex/stephen-daily-YYYY-MM-DD` 分支和同一个 Draft PR。日内第二次扫描的“新发现数”只统计尚未进入当日 discovery ledger 的非重复 ID，重试同一份报告时该值为 `0`。

### 3.2 形成候选

候选必须补齐三类字段：

- 事实层：标题、短摘要、内容类型、发布时间、证据和来源属性；
- 解释层：为什么重要、销售影响、岗位与组织影响；
- 行动层：目标用户下一步能执行的一个动作，以及关联专题/工具。

AI 可生成摘要初稿、翻译建议、标签建议和影响分析草稿，但编辑必须核对原文；AI 产出的风险等级、信源 ID、事实类型和发布状态一律不采信。无 AI Key、请求失败、限流、超时或返回结构异常时，保留来源元数据并使用明确写着“需人工核验”的确定性回退文案，不编造摘要。

### 3.3 去重与事件归组

候选按以下顺序去重：

1. 规范 URL：去除查询参数和片段后相同；
2. 事件键：SAAS-605 用规范化标题和 UTC 发布日生成跨来源确定性键；
3. 内容指纹：规范化标题、摘要和发布日期形成的确定性指纹。

重复记录不删除，标记为 `duplicate` 并保留自身证据与溯源；SAAS-606 人工审核时再将同一事件的多个真实独立证据挂到主候选的 `evidence`。标题措辞不同的跨来源内容本阶段不做自动语义归组；复杂语义聚类仍留到第二阶段。

### 3.4 字段与证据校验

进入风险判断前必须通过：

- 完整中文标题、摘要、用户意义、销售影响、岗位组织影响和下一步行动；
- 至少一个知识域和一条证据；
- HTTPS 规范 URL、合法 ISO 时间、合法候选状态；
- 主信源出现在证据中；
- 公开集合还要通过 `validateKnowledgeItems`，并且只能包含 `approved`。

采集层缺失来源、日期、HTTPS URL 或存在冲突时进入 `manual_review`，以便保留可追溯元数据；只有已经形成完整正式候选、进入 `pipeline.ts` 后仍缺少必填字段或结构非法，才进入 `rejected`。两层状态不可互换，也不允许人工直接把错误状态改成公开。

## 4. 确定性风险矩阵

风险由显式信号计算，忽略候选中任何预填的 `riskLevel`。

| 等级 | 典型信号 | 处理方式 |
|---|---|---|
| 低 | 普通官方产品事实、研究元数据 | 只有满足全部自动资格条件时才标记为可自动发布 |
| 中 | 客户案例、量化效果、岗位趋势、编辑推断、第三方评论 | 始终人工审核 |
| 高 | 价格与商业条款、安全与隐私、法律监管、证据不足、来源冲突 | 始终人工审核，必要时暂停整批 |

未知或空风险信号按高风险处理。任何来源冲突直接提升为高风险，不能由 AI 或编辑手工降级绕过规则。

## 5. 队列与自动资格

管线只有四种输出：

- `duplicate`：重复发现，仅留审计；
- `rejected`：字段或结构不完整，退回修复；
- `manual_review`：中高风险，或低风险但任一控制门未满足；
- `auto_ready`：只是具备发布资格，不等于已经发布。

低风险自动资格必须同时满足：

1. 非首批种子内容；
2. 风险确定为低；
3. 无来源冲突；
4. 主信源及全部证据信源均在白名单、状态有效，并明确允许低风险事实自动处理；
5. 全部证据均为 `official` 且 `allowlisted`；
6. 字段完整，审计由当前规则重新生成；
7. `autoPublishingEnabled=true`；
8. `stopSwitchEngaged=false`；
9. 已获得独立的生产发布授权。

首批 30 条种子内容无论风险高低都必须由项目所有者逐条终审；AI、脚本或批量操作不能替代这道门。

## 6. 人工审核清单

审核人逐条确认：

- 原文可访问，标题、日期、发布主体和页面含义一致；
- 企业自述、研究发现、媒体报道、编辑推断没有混写；
- 短摘要没有复制长段原文，也没有改变限定条件；
- 效果数字保留样本、时间、口径和“企业自述”属性；
- 法律监管内容没有被写成面向用户的法律意见；
- 三域标签与内容真实相关，没有为了覆盖率强行打标；
- “下一步行动”可执行，不要求用户上传客户敏感数据；
- 相关工具和专题链接正确；
- 重复事件已经合并；
- 最终决定、审核人、时间、规则版本和备注已记录。

## 7. 日报与周报生成

日报只从公开 `approved` 集合投影：

- 优先 3–5 条；高价值内容不足时允许 1–2 条或明确空报；
- 尽量覆盖三个知识域，不用低价值条目凑覆盖率；
- 同一事件只出现一次；
- 展示预计阅读时长、独立来源数和“今天该做什么”。

周报选取当周 3–5 条新增或实质更新，组织为：本周主线、持续事件、岗位变化和推荐工具。日报、周报都不是新的事实来源，只是对同一批准集合的确定性投影。

## 8. 抽样、停止与异常处理

自动发布启用前，所有候选 100% 人工审核。未来若获得启用授权：

- 冷启动阶段对 `auto_ready` 发布结果执行 100% 事后抽样；
- 稳定后抽样率不得低于 20%，由 `selectDeterministicAuditSample` 按内容指纹确定，避免人为挑样；
- 发现事实错误、版权投诉、来源政策变化、规则异常或连续重复时，立即合上停止开关；
- 停止开关合上后，所有合格低风险内容也只能进入 `manual_review`，不能进入 `auto_ready`。

## 9. 单条撤回与版本回滚

单条问题处理：

1. 记录撤回原因、操作者、时间和当前 release version；
2. 将条目从公开集合撤出或标记归档；
3. 重跑内容测试与 Stephen 构建；
4. 形成新候选版本；
5. 保留 `published → withdrawn` 审计链，不删除历史。

整批问题处理：

1. 合上停止开关；
2. 指定上一稳定 release version；
3. 记录操作者、时间和回滚来源版本；
4. 恢复上一稳定静态构建；
5. 验证首页、详情、备案、旧手册和 `/api/` 隔离；
6. 保留 `published → withdrawn → rolled_back` 或 `published → rolled_back` 审计链。

`createPublicationRecord`、`withdrawPublication` 和 `rollbackRelease` 只生成不可丢失的生命周期记录，不执行服务器部署。生产回滚仍须在 SAAS-604 的独立发布授权下执行。

## 10. 每日收尾证据

每次编辑批次至少保存：

- 扫描信源数、发现数、去重数、拒绝数、人工队列数和自动资格数；
- 规则版本、候选 release version、停止开关状态；
- 内容测试、TypeScript 检查和 Stephen 构建结果；
- 人工批准人及逐条结论；
- 撤回、纠错、抽样或回滚记录；
- 明确写明“是否发生生产发布”。

当前阶段的标准答案应为：**未发生生产发布；自动发布关闭；停止开关合上。**

## 11. SAAS-605 本地执行与配置

本地验证命令：

```bash
cd app
npx tsc --noEmit -p stephen/tsconfig.json
npx tsc --noEmit -p stephen/tsconfig.editorial.json
npx vitest run --root stephen
npm run build:stephen
```

只读实时扫描入口：

```bash
cd app
node --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts
```

脚本只向标准输出写 JSON，不修改仓库、公开集合或服务器。单个配置来源发生网络、content type、重定向、大小或解析漂移错误时，扫描脚本以非零状态报告异常并仍输出有界的部分报告；SAAS-606 工作流只在该报告通过完整结构与控制门校验后继续生成候选，因此成功来源不会因单源故障丢失，损坏或不完整报告仍会失败关闭。“没有通过筛选的新内容”在每日 PR 阶段作为正常成功处理。

如果本机设置了 `HTTP_PROXY` / `HTTPS_PROXY`，而 Node 直连 Google 域名出现 `UND_ERR_CONNECT_TIMEOUT`，使用当前 Node 的环境代理开关运行：

```bash
node --use-env-proxy --experimental-strip-types stephen/scripts/stephen-editorial-intake.ts
```

这只改变本机传输路径，不放宽 HTTPS、主机、重定向、大小或 content type 校验。GitHub `ubuntu-latest` runner 无代理时不需要该参数。

可选模型变量只能通过 GitHub Secrets 注入，并一次性完整配置：

- `EDITORIAL_AI_BASE_URL`
- `EDITORIAL_AI_MODEL`
- `EDITORIAL_AI_API_KEY`

API Key 不得出现在仓库、命令参数、日志、artifact 或 PR。SAAS-606 不创建 artifact，也不创建生产 Environment、SSH 密钥、Nginx 修改或发布流水线；这些仍属于 SAAS-607～SAAS-608 的后续阶段门。

## 12. SAAS-606 每日候选 Draft PR 人工审核门

### 12.1 触发、权限与运行边界

工作流只使用 `ubuntu-latest`，支持定时触发与 `workflow_dispatch`，单次超时 20 分钟。顶层权限只有：

```yaml
permissions:
  contents: write
  pull-requests: write
```

只使用 GitHub 自带 `GITHUB_TOKEN`、`actions/checkout@v4`、`actions/setup-node@v4` 和 runner 中的 GitHub CLI，不使用 PAT、第三方 PR Action、`pull_request_target` 或 artifact。候选分支使用普通 push，不 force-push。复用候选分支前，工作流会在受信任 checkout 上确认该分支相对目标 base 只修改当天的 `review-manifest.json` 和 `discovery-ledger.json`，并确认两者都存在且为 `100644 blob`；删除整文件、symlink、可执行文件以及任何脚本、依赖、workflow 或其他路径变化，都会在执行候选分支代码前失败关闭。

两个 cron 会随工作流进入默认分支而被 GitHub 登记，但 `review` job 默认失败关闭：只有仓库变量 `STEPHEN_DAILY_SCHEDULE_ENABLED` 被项目所有者显式设为字符串 `1`，schedule 事件才会执行。变量缺失、为空或为其他值时，定时运行只显示为 skipped，不扫描来源、不读取 AI Secrets、不写分支或 PR；`workflow_dispatch` 不受该开关影响。定时和人工 live 运行都必须从仓库默认分支执行并以默认分支为 base，只有实际执行的 live 路径会读取 AI Secrets；fixture 模式强制以被 dispatch 的非默认功能分支为 base，不能指向 `main`，也不会注入 AI Secrets。

### 12.2 同日复用与项目所有者删除

每个北京时间日期只维护：

- 分支：`codex/stephen-daily-YYYY-MM-DD`；
- 非公开候选：`app/stephen/review-candidates/YYYY-MM-DD/review-manifest.json`；
- 发现 ledger：`app/stephen/review-candidates/YYYY-MM-DD/discovery-ledger.json`；
- 同一个 open Draft PR。

`review-manifest.json` 只包含拟发布候选，状态固定为 `pending_owner_review / not_published`，不会被 `publicItems.ts` 导入。`discovery-ledger.json` 记录当天已经出现过的候选 ID 和每次扫描统计。项目所有者可在 PR 分支中删除 manifest 内不合格条目的完整 JSON 对象；由于该 ID 仍在 ledger 中，当天下一次运行不会把它重新加回。

如果同 head/base 已有 open Draft PR，工作流只更新该 PR；如果 PR 已转为非 Draft，工作流失败关闭；如果同一 head/base 出现多个 PR，工作流因状态歧义失败；如果同日 PR 已关闭或合并，工作流不重新创建。没有拟发布条目且不存在既有 Draft PR 时，运行正常成功但不创建空 PR。

PR 查询必须使用当前仓库 owner 限定的 `owner:branch` head，并校验返回的 head repository、head ref、base ref 和是否跨仓库；同名 fork 分支不得被识别为当日审核 PR。初次判定后，工作流在推送候选分支、创建 PR 和编辑 PR 之前都重新获取并校验该精确身份与状态；发现变化立即失败关闭。GitHub API 不提供跨“校验—修改”两次请求的通用原子条件更新，因此仍保留一个极窄的 API 竞态窗口；工作流串行化、普通非 force push、GitHub 的同 head/base PR 约束与临近修改的重新校验共同将其限制为失败关闭路径。

### 12.3 PR 审核信息

Draft PR 必须显示：

- 扫描来源数与失败来源数；
- 新发现数、重复数、拒绝数和 `manual_review` 数；
- 当前 manifest 中的拟发布条目数；
- 每条候选的原文 HTTPS 链接、确定性风险级别、风险原因、候选摘要和文案模式；
- 删除不合格条目的操作说明；
- “AI 只生成候选文案”“未批准”“未发布”“不触发生产部署”的显式提示。

AI 返回对象中的 `riskLevel`、`editorialStatus`、`reviewState` 或 `publicationState` 一律丢弃。风险来自 SAAS-605 pipeline decision；审核和发布状态由 SAAS-606 固定为待项目所有者审核与未发布。`auto_ready`、开放的自动发布开关、释放的停止开关、HTTP 原文 URL 或非 Draft PR 状态都会失败关闭。

### 12.4 fixture dry-run 与真实测试 Draft PR

本地 fixture dry-run：

```bash
cd app
SAAS606_OUTPUT_ROOT=$(mktemp -d /tmp/saas606-dry-run.XXXXXX)
node --experimental-strip-types stephen/scripts/stephen-daily-review-cli.ts generate \
  --report stephen/scripts/fixtures/saas-606-intake-report.json \
  --date 2026-08-24 \
  --mode fixture \
  --output-root "$SAAS606_OUTPUT_ROOT" \
  --body-file .saas-606/pr-body.md
```

真实流程验收必须从 SAAS-606 功能分支 dispatch，并把测试 PR base 指回同一功能分支：

```bash
gh workflow run stephen-daily-intake.yml \
  --ref codex/stephen-daily-candidate-pr \
  -f mode=fixture \
  -f editorial_date=2026-08-24 \
  -f target_base=codex/stephen-daily-candidate-pr
```

验收 PR 的 head 为 `codex/stephen-daily-test-2026-08-24`，因此即使误合并也只进入功能分支，不直接影响 `main`、正式公开集合或生产站点。验收完成后停在项目所有者审核门；不得在 SAAS-606 中合并 `main`、部署或开始 SAAS-607。
