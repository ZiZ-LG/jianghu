# 自我修养首批白名单信源登记

> - 版本：SAAS-605-v1
> - 核验日期：2026-08-24
> - 数量：10（国际 7，中国大陆 3）
> - 首期机器入口：2（OpenAI、Google Cloud）
> - 公开方式：仅元数据、必要短摘要、自有分析与原文链接
> - 自动发布：默认关闭

| ID | 信源 | 地域 | 类型与权威 | 扫描节奏 | 自动资格 | 核验结论 |
|---|---|---|---|---|---|---|
| `openai-news-rss` | OpenAI News RSS | 国际 | 厂商官方新闻 | 每日两次 | 仅低风险官方事实 | 已接机器入口；案例效果和性能数字按企业自述标识 |
| `anthropic-news` | Anthropic News / Engineering / Privacy | 国际 | 厂商官方材料 | 每日 | 仅低风险官方事实 | 暂无已验证官方 RSS/API，首期不抓 HTML，仅保留人工发现资格 |
| `google-cloud-ai-blog` | Google Cloud AI & ML Blog | 国际 | 厂商官方工程博客 | 每日 | 仅低风险官方事实 | 已接机器入口；产品事实、工程建议和客户效果分开归属 |
| `anthropic-careers` | Anthropic Careers | 国际 | 厂商官方招聘页 | 每日 | 人工审核 | 岗位存在性为核验日官方事实，能力趋势属于编辑归纳 |
| `nist-ai-rmf` | NIST AI RMF | 国际 | 美国政府官方框架 | 每周 | 人工审核 | 自愿框架，不写成普遍强制法律义务 |
| `eu-ai-act` | European Commission AI Act Portal | 国际 | 欧盟官方法律与指南 | 每日 | 人工审核 | 法律与时间线一律高风险人工终审 |
| `stanford-ai-index-2026` | Stanford HAI 2026 AI Index | 国际 | 学术原始研究汇编 | 每季度 | 人工审核 | 只引用公开指标并保留章节和基准边界 |
| `aliyun-model-studio` | 阿里云百炼 Model Studio 官方文档 | 中国大陆 | 厂商官方文档 | 每日 | 人工审核 | 覆盖产品、地域、计费、评测、隐私与 Agent 身份；不同套餐分开核验 |
| `aliyun-careers` | 阿里云社会招聘 | 中国大陆 | 厂商官方招聘页 | 每日 | 人工审核 | 岗位名称与检索结果只作为核验日快照 |
| `tencent-cloud-ai` | 腾讯云 AI 官方文档 | 中国大陆 | 厂商官方文档 | 每日 | 人工审核 | 覆盖混元、ADP、兼容 API 和计费；产品能力不等于客户成效 |

## 本轮来源调整

- 只给 `openai-news-rss` 和 `google-cloud-ai-blog` 增加版本化 `ingestion` 配置；其余 8 个来源仍是已批准人工信源，不会因为在登记表中而被脚本抓取。
- 2026-08-24 使用项目规定的浏览器只读复核：OpenAI RSS 返回 `text/xml`，Google Cloud AI RSS 返回 `application/xml`，均包含标题、原文链接和发布时间。核验快照分别显示 1,143 条和 20 条；条目数只作当次连通性证据，不是产品承诺。
- Anthropic News 页面未暴露 RSS alternate link，`/news/rss.xml`、`/rss.xml`、`/feed.xml` 和 `/news/feed.xml` 均返回 404，因此失败关闭，不新增 HTML 解析器。
- 增加阿里云百炼、阿里云招聘和腾讯云 AI 三个中国大陆官方来源，结构化标记 `originRegion`。
- 移除 AWS AI Blog、Microsoft WorkLab 和 LinkedIn Economic Graph，避免 10 个首发名额过度集中在海外单一厂商或单一劳动力平台。
- 微信公众号、CSDN、X 可作为后续候选发现渠道，但首批事实优先采用可稳定回溯的大陆厂商官方文档和招聘页；候选发现渠道不能直接获得发布资格。

## 扫描与交叉验证边界

- 流水线最多每日执行两次，只处理以下两个字面量机器入口：
  - `https://openai.com/news/rss.xml`
  - `https://cloudblog.withgoogle.com/products/ai-machine-learning/rss/`
- Feed 请求与条目链接分开限制主机：OpenAI 仅允许 `openai.com`；Google Feed 仅允许 `cloudblog.withgoogle.com`，条目仅允许 `cloud.google.com`。不接受通配符主机、HTTP、越界重定向、Cookie 或认证信息。
- 单次 Feed 上限为 1 MB、40 条、2 次同白名单主机重定向和 10 秒超时；DTD、ENTITY、非 RSS 2.0、非 XML content type 或结构漂移直接失败关闭。
- 每条种子结论至少需要两项可追溯事实；跨企业或行业判断至少覆盖两个不同来源 ID。
- 白名单不是信任豁免：客户效果、岗位趋势、方法建议、法律、价格、安全和跨来源归纳仍按规则转人工。
- 来源页面出现访问阻断、政策变化、重定向异常或内容结构失效时，暂停该来源的自动资格，保留其他来源和人工流程。
- 新增、替换或重新启用来源必须修改版本化登记并经过项目所有者批准；AI 无权自行调整。

## SAAS-605 候选记录契约

机器入口只生成发现记录和待审候选，不修改 `publicItems.ts`。每条记录保留：稳定 `candidateId`、`sourceId`、原始标题、规范 URL、发布时间、抓取时间、最多 280 字符来源摘要、最多 160 字符证据摘录、事件键、内容指纹、确定性风险信号、`ruleVersion` 与 RSS provenance。

- 候选 ID 由 `sourceId + canonical URL` 确定，同一条新闻在不同时段重复运行保持不变。
- URL、事件键、内容指纹三层去重同时支持当前批次和外部传入的历史集合；重复只标记，不删除审计信息。
- 缺来源、日期、HTTPS、允许主机或存在来源冲突时进入 `manual_review`，不进入候选列表。
- RSS 正文不会进入候选；仅保留有长度上限的纯文本短摘录。
- AI 只能返回六个编辑文案字段，不能返回或覆盖信源、风险、证据级别、审批状态和发布状态；无 Key、限流、超时或格式异常时使用有归属的确定性回退文案。
