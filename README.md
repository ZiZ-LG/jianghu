# 江湖 (Game of JiangHu) · 销售干系人管理 SaaS

面向复杂大客户/大项目销售的「干系人作战地图」——可视化经营客户内部权力关系网（侦探墙 L1–L4），用 **G64111 趋赢力**方法论打分，多人云端协作。

## 仓库结构

```
docs/        设计文档：产品设计方案.md（PRD）、G64111-评分规格.md（核心算分）
app/         前端：Vite + React + TypeScript（侦探墙 + 趋赢力 + 全字段录入）
server/      后端：Fastify + Prisma + JWT（多租户 SaaS API）
参考文件/     原始原型与方法论素材
```

## 架构

- **前端** React/Vite，乐观本地更新 + 云端同步（数据契约 = `app/src/store.ts` 的 Action）
- **后端** Fastify + Prisma，多租户（按 `tenantId` 隔离）、JWT 认证、RBAC（owner/admin/member/viewer）、计费/席位
- **数据库** 开发 SQLite（零配置）；生产改 `server/prisma/schema.prisma` 的 `provider = "postgresql"` + `DATABASE_URL` 即用 Postgres（字段未用原生 enum/json，跨库可移植）
- **核心算法** G64111 趋赢力评分引擎 `app/src/lib/g64111.ts`（17 单测，严格对齐 [评分规格](docs/G64111-评分规格.md)）

## 本地运行

**1) 后端**（端口 3001）
```bash
cd server
npm install
npm run generate      # 生成 Prisma 客户端
npm run db:push       # 建库（SQLite dev.db）
npm run dev
```

**2) 前端**（端口 5173）
```bash
cd app
npm install
npm run dev
```

打开 http://localhost:5173 → **注册工作区** → 「载入示例」体验完整场景，或「新建客户」从零开始。

## 已实现（可付费 SaaS 骨架）

- ✅ **多租户 + 认证（大陆友好）**：**手机号 / 邮箱 + 密码**注册登录（个人即可用，无需企业资质）；JWT 会话、刷新自动恢复、租户级数据隔离
- ✅ **RBAC**：owner/admin/member/viewer；成员（手机号/邮箱）邀请/移除
- ✅ **云端持久化的完整 CRUD**：客户/商机/干系人/角色/关系/BI/UCV/日志，全部存后端 DB
- ✅ **G64111 趋赢力引擎**：实时重算、741 竞争策略、可配置权重
- ✅ **侦探墙**：L1–L4 关系分层、5 角色、支持度、FORM 能源版、拖拽
- ✅ **免费多人协作 + 自愿捐赠**：产品免费（宽松 50 席），可配置 Donate 入口（爱发电链接 / 个人收款码，`server/.env` 的 `DONATE_URL`/`DONATE_QR_URL`）——个人收款无需商户号
- ✅ **AI 战略推演台（BYO 模型）**：输入假设策略 → 按 G64111 推演对趋赢力分项的影响、风险、下一步行动、话术。模型**用户自配**（OpenAI 兼容：DeepSeek/通义千问/Kimi/智谱/OpenAI/OpenRouter/Ollama），Key 经 AES 加密存服务端、用用户自己额度调用（平台零 token 成本）；内置「演示模式」无需 Key 即可体验
- ✅ **AI 关系推断补全**：图算法（共同邻居）+ LLM/mock 挖掘潜在人际关系 → 候选（含置信度/证据/来源），画布以**灰虚线 ❓** 呈现待确认；**人审采纳才建边、绝不自动写库**（去重排除已连接/已采纳/已忽略）
- ✅ **企查查自动建图（BYO Key + 无 Key 回退）**：输入公司名 → 拉取关键人。配企查查 Key 取权威工商数据；**未配 Key 自动回退 AI 联想**（用自配模型，标注"待核实"）；全无配置时给 G64111 典型角色清单。预览勾选 → 一键导入为节点（带"📥 来源·待验证"溯源日志），销售后续指派角色 + 核实

## 走向真实生产（剩余）

- 🔒 **安全加固**：JWT 改 httpOnly cookie + refresh token、限流、审计日志；手机号注册可加短信验证码（需短信服务商）
- 🐘 **Postgres + 部署 + 备案**：切 provider + 托管 Postgres；Docker/CI；大陆上线需域名 **ICP 备案**
- 💳 **（可选·需注册公司）微信登录 + 微信支付**：微信网站应用扫码登录与微信支付商户收款均需**企业认证（营业执照）**；个人阶段用「手机号登录 + 捐赠」替代
- 🤖 **路线图 V1+**：MCP/CLI 接口（见 [产品设计方案 §10](docs/产品设计方案.md)）；AI 战略推演台、关系推断、企查查自动建图均已落地

详见各子目录 README：[app/README.md](app/README.md)。
