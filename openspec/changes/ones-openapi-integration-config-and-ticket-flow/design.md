## Context

当前实现存在两个核心问题：
1) Configuration 页面存在与 ONES OpenAPI 不一致的路径/语义，导致测试结果不可相信；
2) customer portal 可创建工单类型未严格由 ONES issue type + support 策略控制。

本设计以 `/Users/jeremypeng/Downloads/openapi.yaml` 为唯一事实源，重构配置与运行链路，覆盖项目发现、工作项、评论、状态与工作流映射，以及 customer 侧类型约束。

## Goals / Non-Goals

**Goals:**
- 构建 ONES OpenAPI 集成配置中枢：连接、端点、映射、发布。
- 严格落地真实接口链路：`project -> issue types/fields/status -> issue/comment CRUD -> workflow transition`。
- 配置页支持参数化模板与上下文注入（issueID/commentsID/workflowID）。
- customer portal 新建工单类型由 support 白名单控制，来源于 ONES issue types。
- 提供强校验测试与可审计配置版本。

**Non-Goals:**
- 不实现 ONES 文档未显示的能力（例如未在 OpenAPI 出现的专用工单门户接口）。
- 不在本变更实现完整双向实时同步引擎（webhook 增强可后续迭代）。
- 不替换现有支持队列/SLA 全部逻辑，仅补齐 ONES 接口配置与调用闭环。

## Decisions

### 1) 采用四层配置模型（Connection / Endpoints / Mapping / Publish）
- Decision: 把配置拆为四层，避免一个超长表单导致耦合。
- Rationale: 前置依赖清晰，能够在每一层单独测试和阻断。
- Alternative: 单页面平铺。
- Why not: 无法表达前置依赖和状态门禁。

### 2) Endpoint 配置采用“模板 + 运行时上下文注入”
- Decision: 支持 `{{issueID}}/{{commentsID}}/{{workflowID}}/{{projectID}}` 等占位符；测试时必须可解析。
- Rationale: 兼顾可配置性与运行时动态参数需求。
- Alternative: 所有路径硬编码。
- Why not: 不能适配不同 ONES 租户路径习惯。

### 3) 测试成功定义从“HTTP 200”提升为“协议正确 + 结构正确”
- Decision: Test 必须满足：HTTP 成功 + JSON 响应 + 响应路径可解析。
- Rationale: 避免 HTML 404 页被误判成功。
- Alternative: 仅看 status code。
- Why not: 误报高，生产风险高。

### 4) Customer 类型策略采用“ONES 源列表 + support 白名单”
- Decision: `allowedIssueTypeIDs` 独立存储；customer 仅可见和提交白名单类型。
- Rationale: 既保持 ONES 为源，又保留支持团队产品策略控制。
- Alternative: customer 直接暴露全部 issue types。
- Why not: 缺少治理，易暴露不适用类型。

### 5) 状态流转采用“状态映射 + 工作流执行映射”双表
- Decision: 拆分为 `statusMap`（内部状态->外部状态）与 `transitionMap`（业务动作->workflowID）。
- Rationale: 状态展示与执行动作不是同一维度，拆分更稳定。
- Alternative: 单一映射表。
- Why not: 维护困难，无法表达同状态多动作。

## Risks / Trade-offs

- [ONES 接口权限不足导致 403] → 在每个 endpoint 配置项展示必需 scope，并在测试错误里直出 scope 提示。
- [字段/类型漂移导致创建失败] → 引入配置发布前校验，阻断未映射必填字段。
- [支持人员误配路径模板] → 模板占位符实时校验 + 试运行请求。
- [分页列表读取性能问题] → 项目与 issue 列表默认分页并延迟加载下一页。
- [配置更新影响运行中的 customer 提单] → 使用版本化配置，发布采用原子切换。

## Migration Plan

1. 新增配置结构字段（连接参数、endpoint 模板、mapping、whitelist、版本元数据）。
2. 将现有 Configuration UI 改造为分步流程，并保留旧数据迁移兼容层。
3. 对接 ONES project/issue/comment/status/workflow 真实路径配置与测试。
4. 发布 customer portal 类型来源切换：本地静态 -> ONES whitelist。
5. 灰度发布：先内部 support 环境，后 customer 环境。
6. 回滚策略：保留上一版本配置，出现故障一键回切。

## Open Questions

- OpenAPI 中 issue workflow 获取接口的请求/返回字段在不同版本是否完全一致（需联调样本确认）。
- issue field 必填规则是否存在项目级覆盖（需确认最终校验源）。
- 是否需要在配置页增加“按 issue type 分组的字段映射模板继承机制”。
