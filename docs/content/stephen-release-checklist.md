# 自我修养知识库｜SAAS-604 发布候选检查清单 v1

> 当前结论：`NO-GO FOR PRODUCTION / RELEASE CANDIDATE IN PROGRESS`
>
> 原因：首批 30 条内容仍待项目所有者终审；生产部署、流量切换和自动发布启用未获授权。本清单用于形成可审核、可回滚的候选版本，不是部署指令。

## 1. 本次发布范围

允许进入候选版本：

- 独立静态知识库外壳和 `/fieldbook/` 完整旧手册；
- 今日、雷达、专题、岗位、方法工具、本机收藏、日报/周报和说明页；
- 30 条人工终审候选、6 个专题、8 个工具及终审包；
- 本机搜索、收藏、已读、工具材料编辑/复制/Markdown 下载；
- 白名单信源、确定性候选管线、风险队列、抽样、撤回和回滚审计；
- Nginx 独立 Host、HTTPS、安全头、SPA 深链、静态缓存和 `/api/` 404 边界。

明确不在范围：

- CRM 代码、API、数据库、租户、权限或客户数据；
- 账号、云同步、付费、论坛、公共评论、公开投稿和作品集生成；
- 生产部署、流量切换、`main` 合并；
- crawler、公网候选写入接口和 auto-publish endpoint；
- 自动发布启用。默认必须保持 `autoPublishingEnabled=false`、`stopSwitchEngaged=true`。

## 2. 阶段门状态

| 门 | 状态 | 必须证据 |
|---|---|---|
| SAAS-601 独立外壳与旧手册 | PASS | 内容契约、独立构建、旧手册 8/32/45/22/6 保护测试 |
| SAAS-602 信源、30/6/8 候选 | IMPLEMENTED | 10 个白名单信源、30 条候选、6 个专题、8 个工具、终审包 |
| SAAS-602 项目所有者终审 | **PENDING / BLOCKING** | `docs/content/stephen-seed-review-package.md` 逐条明确结论 |
| SAAS-603 本机状态与工具 | PASS | 搜索、localStorage 版本恢复、工具复制/下载、移动端实测 |
| SAAS-603 候选管线与摘要 | PASS | 自动发布双重关闭、风险队列、去重、日报/周报测试 |
| SAAS-604 发布契约 | IN PROGRESS | 本清单、第 3–8 节全部证据 |
| 生产部署授权 | **NOT GRANTED / BLOCKING** | 项目所有者另行书面批准 |

只要任一 `BLOCKING` 项未清零，结论必须保持 `NO-GO`。

## 3. 内容与合规检查

- [ ] 项目所有者逐条批准 30 条首发内容；未批准条目不得进入 `publicItems.ts`。
- [ ] 每条公开内容为 `approved + manual`，中文六字段、证据、风险、审计完整。
- [ ] 企业自述、研究发现、官方事实和编辑推断分层明确。
- [ ] 不含未经授权全文、图表、付费内容或大段原文。
- [ ] 失效链接复核完成；价格、法律、安全和隐私内容在发布日重新核验。
- [x] 页面展示主体：自在创造（北京）智慧科技有限公司。
- [x] 页面展示备案号：京ICP备2026046195号-2，并链接工信部备案系统。
- [x] `/policy/` 提供隐私、本机数据、版权、AI 辅助和纠错说明。
- [x] 纠错统一进入已核验的主站 `https://lake2ocean.top/#wuhu`，并提供 `cs@zizai.tech` 邮件入口。
- [x] 不提供公开评论、回复串、点赞或用户主页。

## 4. 应用与数据边界

- [x] Stephen 生产依赖只导入 `content/publicItems.ts`，不导入候选 `items.ts`。
- [x] 构建产物扫描不含首批候选标题或原文 URL。
- [x] 无 `/api/` 调用、账号、身份 Token、CRM 写入或服务器工具材料存储。
- [x] 本机状态键为 `stephen-knowledge-library-v1`；损坏 JSON 自动清除，旧版本保留仍有效 ID。
- [x] 页面提示搜索词可能存在 URL / 浏览器历史 / 基础访问日志，不应输入客户敏感信息。
- [x] 工具材料可编辑、复制、下载和清除；服务端不能恢复。
- [x] 自动发布默认关闭，停止开关默认合上。
- [x] 中高风险、种子、评论性、来源冲突、证据不足内容不具备自动资格。
- [ ] 发布前再次运行密钥、候选泄漏、CRM/API 路径和非授权文件差异扫描。

## 5. 构建与测试门禁

候选提交必须在干净 worktree 上依次运行，所有命令退出码为 0：

```bash
cd app
npm run typecheck
npm test
npx vitest run --root stephen
npm run build
npm run build:stephen

cd ../packages/g64111
npm run typecheck
npm test

cd ../../server
npx tsc --noEmit

cd ..
git diff --check
git status --short
```

附加静态断言：

- [ ] `app/dist/stephen/index.html`、`fieldbook/index.html` 和哈希 JS/CSS 存在。
- [ ] CRM `npm run build` 仍保持 CRM-only；`build:stephen` 只生成 Stephen。
- [ ] `app/vite.config.ts`、lockfile、`server/**`、`packages/**`、CRM Action/DTO/Store 无本分支差异。
- [ ] 生产包不含 `seedCandidates`、候选标题、私钥、API Key、数据库或 `.env`。
- [ ] 当前 feature branch 的全部候选提交已推送到 GitHub origin，远端 HEAD 与本地一致。

## 6. Nginx 与候选镜像门禁

配置契约：

- [x] `server_name stephen.lake2ocean.top` 独立，不覆盖主站或 CRM Host。
- [x] HTTP 仅重定向到 Stephen HTTPS；ACME 与健康检查保留。
- [x] `/api/` 明确 404。
- [x] SPA 深链回退 `/index.html`。
- [x] `/assets/` 只返回真实文件，哈希资源一年 `immutable` 缓存。
- [x] 根 HTML 与旧手册 HTML 使用 `no-store, no-cache, must-revalidate`。
- [x] HSTS、nosniff、DENY frame、referrer 与 permissions 安全头在新增 location 中保留。
- [ ] 在与生产相同 Nginx 版本上运行 `nginx -t`；本地字符串测试不能替代真实语法检查。
- [ ] 构建候选镜像或版本化静态目录，不覆盖当前生产目录。
- [ ] 记录候选镜像 digest / 静态目录版本 / Git SHA / 构建时间。

## 7. 浏览器验收矩阵

桌面 1280×720 与移动 375×812 均检查：

- [ ] 首页滚动、3–5 条上限和无内容时的诚实空状态；
- [ ] `/radar/` 搜索、中英文原文标题、AND/OR 筛选和清除；
- [ ] 六个专题、岗位入口、详情证据与原文链接；
- [ ] 八个工具的逐字本机保存、状态、复制 fallback、下载与重置；
- [ ] 我的收藏：收藏/已读/进行中/完成/清除全部；
- [ ] `/digest/` 日报、周报、日期、空状态和三域指标；
- [ ] `/policy/#privacy`、`#copyright`、`#correction` 深链与反馈外链；
- [ ] `/fieldbook/` 旧手册、术语搜索、任务、题库、主题切换和打印入口；
- [ ] 浏览器前进/后退、滚动位置、固定移动导航和页脚；
- [ ] 中文长标题、英文外壳、`html.lang`、键盘焦点和 reduced motion；
- [ ] 无横向溢出、无控制台错误、主要站内链接无 404。

终审前可验证空状态和通用交互；包含公开卡片、详情、收藏和非空摘要的最终验收必须在 30 条批准并进入公开集合后重跑。

## 8. 共享服务器回归矩阵（仅在另行部署授权后执行）

在切流前，对候选镜像和当前线上分别核验：

| Host | 关键检查 | 允许影响 |
|---|---|---|
| `lake2ocean.top` | 首页、备案、卧虎藏龙反馈 | 0 回归 |
| `crm.lake2ocean.top` | 登录页/API 健康/静态资源 | 0 回归 |
| `stephen.lake2ocean.top` | 根页、深链、手册、说明页、HTTPS | 本次候选范围 |
| `zizai.tech` | 官方网站首页与 HTTPS | 0 回归 |
| BJJ Host | 既有 Host 与证书 | 0 回归 |

- [ ] `nginx -t` 通过后才允许 reload。
- [ ] reload 前保存当前 Nginx 配置和静态目录版本。
- [ ] 不执行 `docker compose down -v`，不删除任何数据库卷。
- [ ] CRM/Postgres 容器、端口、数据卷和环境变量不变。
- [ ] 证书 SAN / 有效期覆盖 Stephen Host。
- [ ] 80/443、安全组、DNS 与 CDN 实际状态在发布窗口再次核验。

## 9. 回滚方案

候选切流前必须记录：

```text
previous_git_sha=
candidate_git_sha=
previous_static_version=
candidate_static_version=
previous_nginx_config_backup=
candidate_image_digest=
rollback_operator=
rollback_verified_at=
```

回滚触发条件：

- 任一既有 Host 异常；
- Stephen 根页、深链、旧手册或备案入口不可用；
- HTML 引用不存在的哈希资源；
- `/api/` 不再 404；
- 证书、安全头、缓存或页面内容与候选证据不一致；
- 未批准候选内容进入生产包；
- 事实错误、版权投诉或风险规则异常要求整批停止。

回滚动作仅在另行部署授权后执行：恢复上一静态版本和 Nginx 配置，`nginx -t`，reload，再重跑五个 Host 与 Stephen 关键路径。不得通过删除卷、重建 CRM 数据库或覆盖历史审计实现回滚。

## 10. 最终签署

| 角色 | 结论 | 姓名 | 时间 | 证据 |
|---|---|---|---|---|
| 内容终审 | PENDING |  |  | 30 条终审包 |
| 工程门禁 | PENDING |  |  | 全量命令输出 |
| 浏览器验收 | PENDING |  |  | 桌面/移动截图与控制台 |
| Nginx/镜像 | PENDING |  |  | `nginx -t`、digest、回滚记录 |
| 项目所有者生产授权 | **NOT GRANTED** |  |  | 另行明确授权 |

只有五行全部具备可追溯证据，且最后一行为明确 `GO`，才可执行生产部署或流量切换。
