# SAAS-211｜曹经理个人闭环与 G4 阶段门执行计划

> **执行方法：** 使用 `superpowers:executing-plans` 按检查点逐项实施；新增验收行为遵循 `superpowers:test-driven-development`，完成声明前使用 `superpowers:verification-before-completion`。本任务的独立审查按仓库 `/review` 路由执行，但不启动子代理。

**任务：** SAAS-211

**目标：** 用一个可重复、全合成、无外部网络的曹经理个人旅程串起文件导入、三类受控 Job、人审后正式落库、干系人聚焦、可证伪假设、关系雷达解释和 5 个 Matter 组合，并以现有迁移/回滚、租户、RBAC、敏感 ACL 与零自动正式写入证据关闭 G4 阶段门。

**架构：** SAAS-211 原则上不新增生产能力。新增一个 Fastify + Prisma 的阶段门集成测试，复用真实 multipart 上传、AgentJob control/run、ReviewBatch、Intelligence/Focus、Hypothesis、Relationship Radar 和 Matter Portfolio 路由；两个模型调用只在既有 dependency seam 注入固定合成 JSON，关系雷达继续使用生产确定性 handler。测试在每个机器生成阶段捕获正式权威快照，证明只有用户明确采纳或命令才会改变正式数据。敏感 ACL 使用当前角色、父级 scope、creator/share/reviewer grant 与 revoke 的现有权威实现，不新增经理特权。若 RED 暴露生产缺陷，只做最小非共享修复并先更新本计划；涉及共享文件、schema/migration、重大偏差或真实凭据/数据时立即停止请示。

**技术栈：** TypeScript、Vitest、Fastify inject、Prisma SQLite 测试库、现有 PostgreSQL 运维集成脚本。无新依赖。

## 全局约束

- **基线：** `origin/main@9cccff76c7f22fbf2449a7507ef6ad5be789ec10`；PR #45 已合并，精确 main SHA 的 GitHub Actions run `33846049824` 为 12/12 success。
- **工作区：** `/Volumes/PowerData/江湖APP/.worktrees/saas-211-g4-acceptance`。
- **分支：** `codex/saas-211-g4-acceptance`；SAAS-211 是唯一 `IN_PROGRESS`，不得启动 SAAS-301。
- 不修改 `app/src/App.tsx`、App package/lock/Vite/dist、Docker Compose、根级公共脚本、workflow、Nginx、主站导航、跨站入口或任何“自我修养”专属路径。发现必改时先停下并逐文件请示。
- 不使用飞书、企查查、AI 厂商或客户的真实凭据/数据。文件上传使用测试内存中的合成 `.txt`；模型 handler 只调用本地 stub，既不联网也不读取环境密钥。
- 所有持久化查询与命令继续 tenant-scoped；viewer 写入在 CommandRun/AuditEvent 之前拒绝；manager-shaped member 不因名称或角色获得私密正文。
- AI/Agent 输出只可形成 ResearchBriefSnapshot、ReviewBatch Candidate、RelationshipRadarSnapshot 和未提交 draft。Person/Relation/Evidence/Commitment/Focus/Hypothesis/status 只有明确用户采纳或命令后才可变化。
- SQLite 与 PostgreSQL 只运行既有版本化 migration 与验证路径；不改 schema/migration，不执行 `db push` 处理生产，不部署生产或 Mac mini。
- 开发阶段只跑受影响的 Server 定向测试。独立审查完成后只跑一次完整本地验收；代码未变化不重复已通过的全量矩阵。
- 计划、验收测试、治理收口分别形成独立本地 commit；最终候选完成后一次性 push，只认可 branch-tip 精确 SHA 的 12-job CI。禁止 skip-ci、force-push、空提交或降低门禁。

## 固定验收 fixture

- 曹经理使用当前租户 owner 身份完成 G4 个人闭环；“带两名下属的 manager scope”属于 G5，不在 SAAS-211 伪造。另建名为区域经理的普通 member 只用于证明敏感正文不会因经理身份自动可见。
- 一个 Customer 下建立 5 个 active Matter；组合必须返回全部 5 个并按公开注意力桶排序。`4–5` 是验收样本，不变成硬上限。
- 通过真实 `/api/post-meeting/import/upload` multipart 路径导入一份合成会议文件，验证加密持久化、幂等来源投影和响应/审计不泄露正文。
- 三张 Job Card 必须精确为：`pre_meeting_brief@core-206.v1` / `read_only`、`post_meeting_extract@core-206.v1` / `candidate`、`relationship_radar@saas-212.v1` / `draft`。均由 owner 显式启用后运行。
- 拜访简报必须携带来源、时间与未知项；会后抽取必须先产生带 quote/confidence/source 的 Candidate 与 ReviewBatch；审核前 Account/Opportunity/Person/Edge/EvidenceEvent/PlanAction/Interaction/IntelligenceItem/StakeholderFocus/SalesHypothesis 逐表快照不变。
- 曹经理明确采纳后才建立 Interaction、Person/Relation/Evidence/Commitment；随后通过正式命令确认 StakeholderFocus、建立含 expected signal 与 falsification condition 的 SalesHypothesis、链接反对 Evidence。状态建议可返回 `contradicted`，但正式状态保持原值，直到曹经理明确确认。
- 关系雷达必须返回六个独立 signal；每个干预项具备 reason/source/time/ruleVersion/action，来源下钻需当前授权与精确 revision。draft 始终 `uncommitted`，雷达运行前后正式权威不变。
- 敏感 ACL 矩阵至少覆盖 creator、manager-shaped member、shared reader、explicit reviewer、grant revoke、viewer owner-scope、cross-tenant 和 role downgrade；隐藏与不存在 ID 同形失败，撤销在下一次请求即时生效。
- 自动外发、Forecast/stage/key-person 自动修改与未审候选正式写入计数为 0；AccessToken/WeCom/sync 等外部执行记录不得因旅程产生。

## Task 1｜锁定治理状态与无共享文件方案

**Files:**
- Create: `docs/superpowers/plans/2026-09-04-saas-211-g4-stage-gate.md`
- Modify: `docs/商业版开发待办清单v1.md`

- [x] 核对 main/PR/CI、商业清单依赖、worktree/branch 与唯一任务状态。
- [x] 记录真实 main 精确 SHA 和 12-job CI；将 SAAS-211 从 `READY` 改为唯一 `IN_PROGRESS`。
- [x] 固定无真实第三方数据、无生产、无 Mac mini、无自我修养、无共享文件的默认实施范围。
- [x] 将计划与启动状态形成独立本地治理 commit；本阶段不 push。

## Task 2｜以 RED 测试串起曹经理完整个人旅程

**Files:**
- Create: `server/tests/g4-commercial-journey.test.ts`

- [ ] 先写一个跨功能集成测试，使用真实 Fastify/Prisma 和真实上传/业务路由；以缺少或不完整的阶段门断言取得可解释 RED。
- [ ] 注入 `createPreMeetingHandler` 与 `createPostMeetingHandler` 的本地固定 provider seam；断言调用参数不进入持久化/响应，绝不联网。
- [ ] 建立 5-Matter fixture，列出并显式启用三类 Job，分别运行并验证正确 actionMode/outputRef。
- [ ] 在 pre-meeting、post-meeting 和 radar 三个机器阶段前后捕获正式权威快照；除对应受控 snapshot/candidate/audit 外正式数据必须逐表相等。
- [ ] 从 ReviewBatch detail 生成明确的人审 payload，验证一次采纳、幂等 replay、改 payload 冲突，以及正式 Person/Relation/Evidence/Commitment/Interaction 只在人审后出现。
- [ ] 通过正式命令建立 IntelligenceItem、StakeholderFocus 与 SalesHypothesis；链接反对 Evidence 后验证 suggestion 不自动改正式状态，再由用户命令确认 `contradicted`。
- [ ] 运行 relationship radar，验证六维、解释四元组、当前来源下钻、不可变 snapshot、未提交草稿与零正式写；读取 5-Matter portfolio 并验证全部可见、注意力排序、解释和零读副作用。

### 定向验证

```bash
cd server
npm run test:db:push
DATABASE_URL=file:./test.db npx vitest run tests/g4-commercial-journey.test.ts
```

## Task 3｜锁定敏感 ACL 与越权零写矩阵

**Files:**
- Modify: `server/tests/g4-commercial-journey.test.ts`

- [ ] 使用当前租户的 manager-shaped member、普通 member 与 viewer，以及同一 app 注册的外部租户 owner。
- [ ] 私密 SourceArtifact 对非创建者 owner/admin/member 一律隐藏；切为 `matter_shared` 后只有同时具备当前 Matter scope 与 `source.read_shared` 的读取者可见。
- [ ] ReviewCandidate 的 shared read 不等于 review；只有当前版本显式 reviewer grant 可采纳，撤销或 role downgrade 后 replay 即时拒绝且 Person/Interaction/CommandRun/AuditEvent 不增加。
- [ ] viewer 即使拥有 Customer/Matter 归属也只能读取有权共享元数据，Job/control/review/source mutation 均在业务或审计写前拒绝。
- [ ] cross-tenant、无 scope、已撤销与不存在资源使用相同安全形状，不暴露标题、正文、quote、ciphertext 或存在性。
- [ ] 对响应、AgentRun、CommandRun、AuditEvent 做敏感标记扫描；只允许加密正文位于既有 Transcript 存储。

### 定向验证

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/g4-commercial-journey.test.ts \
  tests/sensitive-resource-acl.test.ts \
  tests/sensitive-acl-routes.test.ts \
  tests/review-batch-routes.test.ts
```

## Task 4｜复核 G4 migration、回滚、Inbox 与 Job 阶段门

**Files:**
- No production file changes expected.
- Test evidence comes from existing focused suites and `scripts/test-postgres-ops-integration.sh`.

- [ ] 定向运行 Candidate migration/rollback、Inbox parity、Source/ACL、ReviewBatch、AgentJob、ResearchBrief、Hypothesis/verification、Radar 和 Portfolio 套件。
- [ ] 验证所有 G4 SQLite marker/expand migration report 为 ok；PostgreSQL rendered schema 与版本化 migration 由最终完整运维集成覆盖。
- [ ] 验证 ReviewBatch 全 reject、accept replay、逐项冲突整批回滚；Job disabled/revoke/timeout/budget/candidate/read-only/draft policy 继续 fail closed。
- [ ] 静态检查不存在自动外发、Forecast/stage/key-person 正式写入、第二 Candidate/Customer/Matter/Commitment 权威或 legacy fallback。

### 定向验证

```bash
cd server
DATABASE_URL=file:./test.db npx vitest run \
  tests/candidate-migration.test.ts \
  tests/candidate-inbox-cutover.test.ts \
  tests/sensitive-acl-migration.test.ts \
  tests/source-artifact-migration.test.ts \
  tests/review-batch-migration.test.ts \
  tests/agent-job-migration.test.ts \
  tests/research-brief-migration.test.ts \
  tests/intelligence-focus-migration.test.ts \
  tests/sales-hypothesis-migration.test.ts \
  tests/hypothesis-commitment-review-migration.test.ts \
  tests/relationship-radar-migration.test.ts
```

## Task 5｜独立审查与一次完整本地验收

**Files:**
- Review all changes since `9cccff76c7f22fbf2449a7507ef6ad5be789ec10`.

- [ ] 测试提交完成后，用仓库 `/review` 方法独立检查 scope、ACL、人审、幂等、审计、敏感数据、三类 Job actionMode 和测试真实性；阻断项先修复并形成独立本地 commit。
- [ ] 独立审查通过且代码稳定后，只运行下面一次完整本地验收；如无代码变化，不重复已经通过的矩阵。
- [ ] 检查精确 changed-file allowlist、自我修养零变化、共享文件零变化、secret/DB/build artifact、`git diff --check` 和工作树 clean 预条件。

### 完整本地验收（仅一次）

```bash
cd packages/domain-contracts && npm run typecheck && npm test
cd packages/g64111 && npm run typecheck && npm test
cd packages/pde-kernel && npx tsc --noEmit && npm test
cd app && npx tsc --noEmit && npm test
APP_BUILD_DIR="$(mktemp -d)" && npm run build -- --outDir "$APP_BUILD_DIR"
cd server && npm run generate && npx tsc --noEmit && npm test
npx prisma validate --schema prisma/schema.prisma
npx prisma validate --schema prisma/postgres/schema.prisma
npm run schema:postgres:check
cd .. && bash scripts/test-postgres-ops-integration.sh
```

同时运行五工作区 production/full `npm audit`；若仅 audit endpoint 400/500/503 且没有漏洞发现，按 steering 记录为传输失败并仅在远端重跑失败 job，不能降低阈值或改依赖/workflow。

## Task 6｜本地治理收口、单次 push 与精确 SHA CI

**Files:**
- Create: `docs/SAAS-211-G4阶段门验收记录.md`
- Modify: `docs/superpowers/plans/2026-09-04-saas-211-g4-stage-gate.md`
- Modify: `docs/商业版开发待办清单v1.md`

- [ ] 先形成独立验收测试 commit；再以独立 docs commit 记录本地测试数量、审查结果、迁移/恢复证据、回滚边界、零共享/自我修养/生产触碰，并将 SAAS-211 标为 `DONE`、G4 标为 PASS、SAAS-301 标为 `READY` 但明确禁止启动。
- [ ] 确认所有本地 commit 共同构成一个 SAAS-211 候选，工作树 clean；一次性 push `codex/saas-211-g4-acceptance`，不创建 PR。
- [ ] 只跟踪最终 branch-tip SHA 的权威 push CI；达到精确 12/12 前 SAAS-211 不视为对外完成，SAAS-301 不启动。
- [ ] 真失败则最小修复形成新 SHA；纯 audit endpoint 400/500/503 且日志无漏洞发现时只重跑失败 job，不重跑成功 job、不加空提交。
- [ ] 12/12 后核对 clean、远端 SHA、`origin/main` drift、自我修养相对 base 零变化和 branch protection 要求；停止并请求创建 PR 的单独批准，不合并、不部署。
- [ ] SAAS-211 完成后只读提出独立 CI 治理方案；不得在本任务修改 `.github/workflows/ci.yml`、公共脚本或仓库保护设置。

## G4 接受标准

- [ ] Candidate 单表 migration/rollback 与 Inbox parity 全绿；不存在平行候选权威或 fallback 双读。
- [ ] 一份合成文件通过真实上传路径进入加密 SourceArtifact；无真实妙记、凭据、客户数据或外部网络。
- [ ] 三类 Job Card/Run 精确匹配固定版本与 actionMode，停用/撤权下一次运行立即生效。
- [ ] 拜访简报有来源/时间/未知项；会后候选有 quote/confidence/source；人审前正式数据零变化，人审后幂等原子写入。
- [ ] Intelligence/Focus/Hypothesis/verification 由明确用户命令产生；反对 Evidence 只形成 `contradicted` 建议，直到用户确认才改变正式状态。
- [ ] Radar 无总分，每项解释 reason/source/time/ruleVersion/action 且来源可下钻；source drift/revoke 只降级或隐藏，不抬高严重度。
- [ ] 5 个 Matter 全部进入组合，无硬截断；注意力排序、来源与未提交草稿可解释，读模型零写。
- [ ] creator/share/reviewer/revoke/viewer/cross-tenant/current-role ACL 矩阵全绿；经理身份不自动取得敏感正文。
- [ ] 自动外发、自动 stage/Forecast/key-person/Relation/Evidence/Focus/Commitment 正式修改和越权正式写入均为 0。
- [ ] Domain、Server、App、G64111、PDE、SQLite/PostgreSQL migration/恢复及 exact branch-tip 12-job CI 全绿。
- [ ] 共享文件、自我修养、生产、阿里云、Mac mini 和 main 均未触碰。

## 回滚

SAAS-211 默认只增加验收测试与治理记录，不增加运行时行为或数据库结构。放弃候选时可按逆序 revert 治理收口、验收测试与启动计划 commit；不得删除或重写既有 Candidate、SourceArtifact、ReviewBatch、Interaction、AgentRun、ResearchBriefSnapshot、IntelligenceItem、StakeholderFocus、SalesHypothesis、RelationshipRadarSnapshot、MethodologyPack/Binding、Commitment、AuditEvent、CommandRun 或 migration history。若验收发现并修复生产缺陷，回滚方法必须在收口记录中按具体提交补充，生产动作仍需单独批准。
