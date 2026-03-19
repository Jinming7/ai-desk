## Context

当前实现把 ONES 集成视为“外部同步插件”，而不是 ticket lifecycle 的主系统，导致以下问题：
- customer portal 可创建 ticket 类型与 ONES 项目配置脱节。
- ticket 创建/状态流转在本地优先，ONES 更新失败会造成双边不一致。
- 配置页缺少面向运行的能力（映射版本、发布、审计、重试、健康状态）。
- ONES OpenAPI 能力未结构化沉淀，接口选择与字段映射依赖人工记忆。

本次设计目标是把页面与后端架构统一到 `Configuration` 语义，并默认采用 `ONES primary` 模式：ONES 负责工单事实数据，本地只保留最小关联上下文与运行审计。

## Goals / Non-Goals

**Goals:**
- 将 `/support/admin/ones-sync` 升级为 `/support/admin/configuration`，提供集成配置中枢。
- customer portal 的可创建 ticket 类型、字段约束来源于 ONES 指定项目 issue type/fields。
- ticket create / update / transition / comment 在写路径上优先调用 ONES OpenAPI。
- SLA 流转动作（例如 WAITING_CUSTOMER、RESOLVED）通过配置映射到 ONES workflow transition。
- 支持 ONES webhook 入站并更新本地读模型（用于队列展示、搜索、审计）。
- 配置与运行态可观测：连接状态、映射版本、同步错误、重试队列、trace 关联。

**Non-Goals:**
- 不在本阶段替换 ONES 权限模型（仍由 ONES 控制权限与项目成员）。
- 不在本阶段实现跨多个 ONES 项目的一体化联邦路由。
- 不在本阶段构建全量 ETL 数据仓库；仅做业务运行所需读模型。

## Decisions

### 1) 数据源模式采用双模，但默认 ONES Primary
- 决策：新增 `data_source_mode`，支持 `ones_primary`（默认）与 `local_mirror`（兼容）。
- 原因：
  - `ones_primary` 保证事实唯一，避免双写冲突。
  - `local_mirror` 保留回退通道，支持阶段性迁移与故障演练。
- 备选方案：只保留一种模式。
  - 未采用原因：一次性切换风险高，不利于现网平滑迁移。

### 2) 本地仅存“最小关联上下文 + 读模型 + 审计日志”
- 决策：不本地持久化完整业务字段作为权威数据；本地保留：
  - 外键：`ones_ticket_key`, `ones_project_id`, `ones_issue_type_key`
  - 运行字段：`sync_status`, `sync_error`, `last_sync_at`, `trace_id`
  - 读模型字段：列表展示所需冗余（标题、状态、优先级、SLA 风险、更新时间）
  - 审计字段：操作人、请求响应摘要、重试次数、幂等键
- 原因：兼顾性能（列表快读）与一致性（ONES 为准）。
- 备选方案：完整本地副本。
  - 未采用原因：高一致性成本与字段漂移风险。

### 3) 配置中心拆分为 6 个模块页签
- `Connection`: base URL、鉴权、项目标识、连接测试。
- `Catalog`: 拉取 ONES issue type 与 field schema，支持缓存刷新。
- `Mapping`: create/update/transition/comment 映射，支持版本化与发布。
- `Workflow`: 本地状态到 ONES transition 映射、SLA 事件映射。
- `Webhook`: 事件订阅、签名密钥、幂等策略、重放。
- `Operations`: 健康看板、失败队列、重试与审计。
- 原因：将“配置”与“运行”分层，便于支持团队日常运维。

### 4) 映射引擎采用“声明式映射 + 运行时校验”
- 决策：字段映射使用结构化 DSL（source/target/transform/requiredPolicy），发布版本后进入只读。
- 原因：可审计、可回滚、可测试；避免硬编码 if-else。
- 备选方案：代码里写死字段转换。
  - 未采用原因：变更频繁，维护成本高。

### 5) 状态流转采用“Configuration 映射表驱动”
- 决策：本地状态（OPEN/IN_PROGRESS/WAITING_CUSTOMER/RESOLVED/CLOSED/ESCALATED_RND）映射 ONES transition id。
- 原因：不同 ONES 项目流程不同，必须配置化。
- 备选方案：固定 transition name。
  - 未采用原因：在多项目/多流程场景不可用。

### 6) Webhook 入站以幂等消费为核心
- 决策：`event_id + event_type + ones_ticket_key` 做幂等键；失败进入死信队列并支持手动重放。
- 原因：避免重复更新与乱序覆盖，确保可恢复。
- 备选方案：直接实时处理不落库。
  - 未采用原因：观测性差，故障不可追溯。

## Risks / Trade-offs

- [ONES API 速率限制或连接池打满] → 限流 + 指数退避 + 本地连接池上限 + 批处理重试。
- [映射配置错误导致创建/流转失败] → 发布前 dry-run 校验 + 样例数据回放 + 一键回滚旧版本。
- [Webhook 丢失导致状态漂移] → 定时 reconcile 任务按 ticket key 拉平差异。
- [ONES 流程变更未同步到配置] → 配置漂移检测（schema hash）+ 控制台红色告警。
- [双模期间认知复杂] → 在 UI 明确当前模式、影响范围、最后切换人和时间。

## Migration Plan

1. 新增 Configuration 路由与配置表字段（含 data_source_mode、workflow mapping、webhook config）。
2. 接入 ONES OpenAPI catalog 拉取与缓存，替换 customer portal 静态 ticket type。
3. 创建写路径适配层：create/update/transition/comment 先写 ONES，再写本地上下文。
4. 上线 webhook 入站、幂等表、死信重放。
5. 灰度切换 `local_mirror -> ones_primary`：按项目、按 issue type 逐步启用。
6. 开启 reconcile 作业并监控错误率；达到阈值后移除旧本地写优先逻辑。

Rollback:
- 切回 `local_mirror` 模式，停用 webhook 消费，保留审计日志与失败事件用于补偿。

## Open Questions

- ONES webhook 可提供的事件粒度是否覆盖评论、状态、指派、字段更新全量场景？
- ONES transition API 是否稳定返回可映射的唯一 transition id（而非易变名称）？
- 客户 portal 的字段可见性是否需要按租户/角色二次裁剪（ONES 字段不应全部外露）？
- 是否需要“只读透传模式”：详情页面实时读 ONES，完全不依赖本地读模型？
