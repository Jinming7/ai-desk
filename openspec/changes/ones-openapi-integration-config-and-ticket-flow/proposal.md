## Why

当前 Configuration 页虽然有向导外观，但接口语义与 ONES OpenAPI 不一致，导致“测试成功但实际不可用”的误导。需要基于 `/Users/jeremypeng/Downloads/openapi.yaml` 重建配置模型与 customer portal 联动逻辑，确保可创建/可更新/可查询工作项与评论的链路真实可用。

## What Changes

- 新增基于 ONES OpenAPI 的配置向导能力：连接认证、项目发现、工作项接口组、评论接口组、映射与发布。
- 新增“接口测试强校验”规则：必须是结构化 JSON 且满足配置的响应路径约束，禁止 HTML/错误页被判成功。
- 新增“项目先决”流程：先通过 `GET /project/projects` 选定项目，再允许配置 issue type、字段、状态、工作流相关接口。
- 新增 customer portal 联动：可创建工单类型由 support 在配置页从 ONES issue types 中选择白名单。
- 新增状态映射与执行工作流配置：通过 `GET /project/issueStatuses`、`GET /project/issues/{issueID}/workflows`、`POST /project/issues/{issueID}`(execute workflow action) 形成闭环。
- 移除配置中的伪默认路径，要求显式配置并提供占位符校验（issueID/commentsID/workflowID 等）。

## Capabilities

### New Capabilities
- `ones-openapi-connection-and-discovery`: 连接鉴权、项目发现、项目选择、接口测试严格校验。
- `ones-openapi-work-item-comment-contracts`: 工作项与评论相关接口路径配置、参数注入、测试与错误语义。
- `ones-openapi-mapping-and-workflow-state`: 状态映射、字段映射、工作流执行映射与校验规则。
- `customer-ticket-type-whitelist-from-ones`: customer portal 可创建类型由 ONES issue types + support 白名单驱动。

### Modified Capabilities
- None.

## Impact

- 前端：`apps/web` 的 Configuration 向导信息架构、步骤状态机、接口测试与表单验证。
- 后端：`apps/api` 的 configuration test/discovery 服务、路径模板与占位符校验、响应结构校验。
- 数据：配置表新增或规范化 endpoint、mapping、white-list、版本与审计字段。
- 业务流程：customer 创建工单入口依赖 ONES 项目/issue type 配置完成度。
