## Why

当前 AI 搜索在无法直接回答时缺少可追踪的闭环：一方面不能稳定返回知识库参考依据，另一方面无法把未解问题快速转入工单流程并继续自动处理。现在需要连接 OpenClaw 并编排 Agent，使“检索-回答-升级-再检索-建单”形成统一链路，提升首次解决率与工单质量。

## What Changes

- 接入 OpenClaw 知识库检索能力到 AI 搜索流程，回答时返回参考文档与可追溯引用。
- 在 AI 搜索无法给出有效回答时，提供一键快速提 ticket 的交互入口。
- 引入提单后的 Agent 深层检索流程：
- Agent 基于问题上下文执行二次/深层知识库检索与证据汇总。
- 若可解决，由 AI 直接输出可执行解决方案并回填处理记录。
- 若仍无法解决，自动创建正式工单并附带检索证据、会话上下文与分类信息。
- 增加全链路状态与结果记录，支持后续审计、质量评估与流程优化。

## Capabilities

### New Capabilities
- `openclaw-kb-grounded-ai-search`: AI 搜索调用 OpenClaw 检索并在回答中返回参考文档与引用。
- `ai-search-ticket-escalation`: AI 搜索失败时支持快速提 ticket，并保留问题上下文。
- `agent-post-ticket-deep-retrieval`: 提 ticket 后由 Agent 深层检索，按可解/不可解分流为 AI 解决或创建正式工单。

### Modified Capabilities
- None.

## Impact

- 受影响系统：AI 搜索服务、知识库检索网关（OpenClaw 连接层）、Ticket 服务、Agent 编排服务。
- 受影响接口：搜索问答接口、提单接口、Agent 执行回调/状态接口。
- 受影响数据：搜索会话上下文、引用文档元数据、升级判定结果、工单创建载荷。
- 外部依赖：OpenClaw 认证与检索 API 可用性；工单系统 API 权限与字段映射。
