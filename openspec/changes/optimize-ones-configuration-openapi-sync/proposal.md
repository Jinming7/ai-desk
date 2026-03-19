## Why

当前 ONES 集成仍停留在“配置页 + 局部同步”阶段，无法支撑“ONES 作为工单主系统（System of Record）”的真实运行模式。现在需要将 Configuration 升级为可落地的集成控制中心，使客户提单、状态流转、字段映射、双向同步策略与运维审计形成闭环。

## What Changes

- 将内部导航与页面命名从 `ONES Sync` 统一升级为 `Configuration`，并重构为“集成配置中枢”。
- 新增“ONES OpenAPI 知识图谱驱动”的配置体验：可视化展示接口能力、字段来源、状态流转映射、Webhook 事件映射。
- 支持按 ONES 指定项目读取可创建 ticket type（issue type）及字段定义，customer portal 动态展示可提单类型。
- 客户提交 ticket 时，优先调用 ONES 创建 issue，并保存最小本地关联上下文（外键与审计），不再本地复制完整业务字段。
- SLA/状态流转改为通过映射调用 ONES 更新 issue 状态，并支持回写失败重试与补偿。
- 引入“数据源模式”配置：`ones-primary`（推荐）与 `local-mirror`（兼容），明确读写路径与一致性策略。
- 支持 ONES 侧变更通过 webhook 入站更新本地视图（状态、指派、评论、关闭等），并具备幂等消费与死信处理。
- 在 support portal 展示 ONES 同步健康状态、失败原因、重试入口与 trace 关联。

## Capabilities

### New Capabilities
- `configuration-hub`: 统一管理 ONES 集成配置、连接测试、映射发布、同步策略与审计。
- `ones-openapi-knowledge-map`: 基于 ONES OpenAPI 知识图谱管理 endpoint/field/workflow/webhook 的语义映射。
- `ones-primary-ticket-lifecycle`: 以 ONES 为主系统处理 ticket 创建、状态流转、评论同步、关闭与升级链路。
- `ones-webhook-ingestion`: 处理 ONES webhook 回调，完成本地读模型更新、幂等校验与重放。

### Modified Capabilities
- （无）

## Impact

- 前端：`/support/admin/ones-sync` 改造为 `/support/admin/configuration`，support 与 customer portal 的 ticket type/field 展示逻辑更新。
- 后端：新增 ONES 适配层编排、映射运行时、webhook 消费器、同步任务与审计 API。
- 数据库：新增/调整配置表、映射版本表、webhook 事件表、同步任务表、最小关联上下文字段。
- 运维：新增 ONES 凭据管理、签名校验、重试与告警策略。
- 风险：从本地写优先迁移到 ONES 写优先，涉及状态一致性与故障补偿流程变更。
