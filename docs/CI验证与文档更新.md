# CI 验证与文档更新

本规则减少同一输入的重复执行，保留代码全量验证、main 检查和生产验收。PR 的检查报告必须区分本次实际执行与经核验复用。实现位于 `scripts/ci_validation.py`，工作流为 `.github/workflows/ci.yml`。

## 触发与完整检查

功能分支在创建或更新 PR 时运行 CI。普通功能分支 push 不再另跑同一套 CI；没有 PR 的分支须先开 PR，或从 Actions 手动运行。main push 与手动运行始终全量执行。重新运行的 attempt 也全量执行。Stephen 独立工作流不变。

原13项检查内容不变：domain-contracts、App、Server、G64111、PDE kernel、5个工作区依赖审计、production-images、PostgreSQL operations 和 CRM publisher Docker 回归。新增 validation-plan 与 validation-gate，因此完整运行有15个实际 job。代码、依赖锁、CI配置、脚本、部署文件或其他未知文件发生变化时执行全量。

## 允许复用的文档范围

只允许这两份普通、非可执行、有效UTF-8 Markdown 文档改变：

- `docs/商业版开发待办清单v1.md`
- `docs/CRM-API发布与回滚.md`

文档必须均存在，不能是软链接、可执行文件或含NUL的二进制文件，单份不超过2MB。其他 Markdown（包括本规则）按代码输入处理。全部非白名单 Git 路径、文件模式与 blob ID 组成指纹；不能仅看本次提交路径，因为 PR 之前可能还有代码改动。

仅 PR 首次 attempt 可以复用，且须同时核对以下证据：

1. 同仓库、同 PR、同来源分支/仓库、同 base SHA，来源 head 是当前 head 的祖先；首次 PR 也可使用精确 base main 的完整成功。
2. 非白名单输入指纹相同，白名单文档确有变化。
3. 先按创建顺序确定最新前序 run，再刷新该 run 最新 attempt。其 workflow 和完整15个 job 均 completed/success。缺失、多余、重复、跳过或失败均不接受；不能从更新失败退回旧成功。
4. 来源 artifact 绑定精确 run ID、attempt、head、事件、分支和输入指纹，ZIP 只含一个受大小限制的 context.json。API清单不完整、artifact缺失/过期/不明或绑定不匹配均不接受。
5. 来源 run 与原始完整执行的证明均在6小时以内。连续文档提交必须追溯并重新验证最初的 FULL run，复用 run 不能冒充完整执行，也不能刷新原证明有效期。

证据不满足时回到全量执行。计划生成失败时，所有原 required-check 名称仍实际执行 guard 并失败；汇总门也失败，不以整个 job 被跳过的成功状态放行。GitHub 的 skipped job 可满足 required check，因此这里保留 always() 与显式 guard。[GitHub 条件与跳过规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)

## 复用时观察什么

validation-plan 的摘要和 context artifact 显示 REUSE、当前 head、原始完整 run URL/attempt 与理由。7项可复用 job 执行 guard，并明确写出“本次没有重新执行这些测试”；原测试步骤显示 skipped。5项依赖审计和 production-images 仍在本次执行。最终15个 job 必须全部成功，validation-gate 核对所有结果。FULL 来源只接受实际全量运行。

全量代码测试内容、依赖审计、镜像构建、main 与 Stephen 检查以及生产发布前后验收保持各自标准。CI 成功不等于生产验收，也不自动授权发布或合并。

## PostgreSQL 长检查的可见性

`ci_postgres_progress.py` 启动原有 `test-postgres-ops-integration.sh`，原脚本、测试场景、命令和退出结果不变。包装器每60秒报告持续时间、距离上次输出时间与最近实际出现的 `..._OK=1` 检查点，同时保留原输出与非零退出码、向自身子进程组转发终止信号。

心跳只证明包装进程当时仍活着，不能证明测试持续推进或已经通过。若检查点不变，应结合原日志与最终 job 结果判断；不能从心跳、耗时或局部成功推定整体通过。它不取消、重跑或降低任何检查。

## 验证与回退

策略回归覆盖代码/未知文件与文件模式变更、文档异常、main/manual/重跑、最新失败、缺失/跳过 job、证据绑定、有效期、连续复用、API/ZIP 异常，以及 required-check guard 与汇总失败关闭。包装器回归覆盖真实输出、沉默、失败退出与信号。

首次代码提交必须在 GitHub 实际完整运行；后续仅白名单文档提交须实际观察 REUSE、7项 guard、6项新执行及完整汇总。测试夹具不替代这两次真实工作流证据。撤回本优化提交即可恢复原触发与全量检查，不涉及运行数据或生产环境。
