# AI-Driven Ticket Management 平台（产品设计 + 技术设计 v1）

版本：v1.0  
日期：2026-03-02  
状态：待你确认

## 1. 目标与定位

### 1.1 产品目标
构建一个 AI-first 的完整工单平台：
- 外部客户通过 Ticket Portal 提单。
- OpenClaw 作为 L1 Agent 自动分析、检索知识库、自动回复并驱动工单状态。
- 无法闭环的问题自动升级到 R&D（后续对接 ONES 项目自动建单）。
- 全流程具备可配置 SLA（首响、解决、暂停/恢复、违约预警）。

### 1.2 设计原则（参考 Jira Service Management）
- 体验：Portal 简洁、低门槛、支持自助解决。
- 流程：状态机清晰、可审计、可追踪。
- AI：默认优先 AI 处理，但必须可控（阈值、回退、人工接管）。
- 运营：SLA/报表可视化，支持持续优化。

### 1.3 视觉方向（参考 ones.com）
- 简洁企业风格、浅色基底、清晰信息层级。
- 表单和列表优先可读性，强调状态标签和时间承诺（SLA）。
- Portal 与 Agent Console 视觉一致但权限分离。

## 2. 用户与核心场景

### 2.1 角色
- Customer：提单、补充信息、确认解决、评价。
- Support Admin：配置流程、SLA、知识库、查看指标。
- R&D Engineer：处理升级工单并回填解决方案。
- System Admin：系统配置、集成、权限、审计。

### 2.2 核心场景
- 场景 A：客户提单 -> AI 命中已知解法 -> 自动回复并置为 `WAITING_CUSTOMER`。
- 场景 B：AI 置信度中等 -> 自动追问补充信息 -> 等待客户回复。
- 场景 C：AI 置信度低/高风险 -> 升级到 R&D（ONES 建单）并同步状态。
- 场景 D：R&D 解决 -> 回传外部工单结果 -> 客户确认 -> 关闭。

## 3. MVP 功能范围（确认版）

### 3.1 外部端（Customer Portal）
- 提单：标题、描述、分类、附件、联系方式。
- 工单列表与详情：状态流转、AI 回复、SLA 倒计时。
- 补充信息：按 AI 追问模板快速补充。
- 满意度反馈：解决后评分与评论。

### 3.2 内部端（Agent Console）
- 队列视图：按优先级、SLA 风险、状态筛选。
- 工单详情：AI 摘要、证据、知识命中、决策理由。
- 人工接管：一键接管 AI 会话。
- 升级管理：查看/跳转 ONES 内部工单。

### 3.3 AI 与知识库
- OpenClaw 编排：分类、实体提取、检索、决策。
- RAG：知识库 + 历史工单答案检索。
- 决策策略：
  - `confidence >= 0.85` -> 自动解答
  - `0.60 <= confidence < 0.85` -> 追问
  - `< 0.60` 或命中高风险规则 -> 升级
- AI 产物：摘要、根因候选、建议处理、回复草稿。

### 3.4 SLA
- First Response Time (FRT)
- Resolution Time (RT)
- 状态暂停/恢复（`WAITING_CUSTOMER` 时暂停 RT）
- 预警（80%/100%）与违约记录

## 4. 端到端流程设计

### 4.1 状态机（外部工单）
`NEW -> AI_REVIEWING -> WAITING_CUSTOMER | ESCALATED | AI_RESOLVED -> RESOLVED -> CLOSED`

说明：
- AI 自动回复后建议统一进入 `WAITING_CUSTOMER`（等待客户确认），避免“AI_RESOLVED 但客户未认可”的语义冲突。
- `RESOLVED` 为已给出最终解法，`CLOSED` 为超时自动关闭或客户确认关闭。

### 4.2 升级流程（到 ONES）
1. Ticket 满足升级条件（低置信/高风险/重复追问失败）。
2. 创建内部升级记录 `internal_ticket`。
3. 调用 ONES API/MCP 在指定项目创建 Issue（类型：Bug/Task 可配置）。
4. 回填 ONES issue key 到外部工单并置为 `ESCALATED`。
5. ONES 状态变化（进行中/已解决）回写到 Ticket Core。
6. 生成客户可读回复并进入 `WAITING_CUSTOMER`。

## 5. OpenClaw 介入设计（你最关心部分）

### 5.1 介入位置
OpenClaw 不直接当系统主数据库，而作为「AI Orchestrator」接在 Ticket Core 后：
- Ticket Core 负责：工单真相源、状态、SLA、审计。
- OpenClaw 负责：理解、检索、决策、内容生成。

### 5.2 集成模式（推荐）
- 触发方式：`ticket.created` / `ticket.customer_replied` 事件触发 OpenClaw。  
- 调用方式：HTTP + 异步队列（避免阻塞提单体验）。
- 返回结果：结构化 JSON（action、confidence、reply、evidence、needs_escalation）。

建议响应结构：
```json
{
  "action": "auto_resolve | ask_info | escalate",
  "confidence": 0.91,
  "reply": "建议客户执行...",
  "reasoning_summary": "命中KB#123，版本一致",
  "evidence": ["kb:123", "ticket:hist-889"],
  "risk_flags": ["security_related"]
}
```

### 5.3 你的云端 OpenClaw 是否可用
当前无法直接判定，需要你提供：
- OpenClaw Base URL
- 鉴权方式（API Key/OAuth）
- 健康检查接口或一个可调用 Agent endpoint

我下一步可以直接帮你执行连通性验证（健康检查 + 一次真实样例推理）并给出可用性报告。

## 6. 技术架构（MVP）

### 6.1 服务拆分
- `portal-web`：外部门户（Next.js）
- `agent-web`：内部控制台（可同仓前端多应用）
- `ticket-core`：工单、状态机、SLA、权限（FastAPI）
- `ai-gateway`：OpenClaw 适配层（重试、超时、幂等）
- `kb-service`：知识库检索（Postgres + pgvector）
- `integration-ones`：ONES 建单/回写同步
- `worker`：异步任务（队列消费者）

### 6.2 数据与中间件
- DB：Supabase PostgreSQL（你已提供连接串）
- 向量：pgvector（同库）
- 缓存/队列：Redis + Celery/RQ（二选一）
- 对象存储：S3 兼容（附件）

### 6.3 事件模型（建议）
- `ticket.created`
- `ticket.ai.processing_started`
- `ticket.ai.action_selected`
- `ticket.escalated`
- `ticket.sla.breaching`
- `ticket.resolved`

## 7. 数据模型（关键表）

### 7.1 工单域
- `tickets`
- `ticket_messages`（客户/AI/人工消息）
- `ticket_status_history`
- `ticket_participants`

### 7.2 AI 域
- `ai_runs`（每次推理记录）
- `ai_decisions`（action/confidence/reason）
- `ai_evidences`（命中的 KB/历史工单）

### 7.3 SLA 域
- `sla_policies`
- `sla_targets`（按优先级映射 FRT/RT）
- `sla_timers`（start/pause/resume/due/breached_at）
- `sla_events`

### 7.4 集成域
- `internal_tickets`（本地升级单）
- `ones_mappings`（外部 ticket id <-> ONES issue id/key）
- `integration_logs`

## 8. SLA 方案（可直接落地）

### 8.1 优先级目标（示例）
- P1：FRT 15 分钟，RT 4 小时
- P2：FRT 1 小时，RT 8 小时
- P3：FRT 4 小时，RT 2 工作日
- P4：FRT 1 工作日，RT 5 工作日

### 8.2 计时规则
- FRT：`ticket.created` 到第一次“有效回复”（AI 或人工）。
- RT：`ticket.created` 到 `RESOLVED`。
- 暂停：状态进入 `WAITING_CUSTOMER` 即暂停 RT。
- 恢复：客户回复后恢复 RT。
- 违约：超过 due_at 记录 `breached`，保留审计。

### 8.3 升级与通知
- 80% 时长：预警给支持负责人。
- 100%：标红 + 自动升级优先级（可配置）。

## 9. API 设计草图（MVP）

### 9.1 外部 API
- `POST /api/v1/portal/tickets`
- `GET /api/v1/portal/tickets/{id}`
- `POST /api/v1/portal/tickets/{id}/messages`
- `POST /api/v1/portal/tickets/{id}/close`

### 9.2 内部 API
- `GET /api/v1/agent/tickets`
- `POST /api/v1/agent/tickets/{id}/takeover`
- `POST /api/v1/agent/tickets/{id}/escalate`

### 9.3 集成 API
- `POST /api/v1/integrations/openclaw/analyze`
- `POST /api/v1/integrations/ones/issues`
- `POST /api/v1/integrations/ones/webhook`

## 10. 安全与合规

- 客户与内部数据逻辑隔离（tenant + role）。
- OpenClaw 输入输出审计（便于回放与复盘）。
- 敏感字段脱敏（邮箱/电话/token）。
- 附件防病毒扫描（可后置到 Phase 2）。

## 11. 里程碑建议（6 周 MVP）

- Week 1-2：Ticket Core + Portal 基础 CRUD + 状态机 + SLA timer
- Week 3：OpenClaw 接入（分析/追问/自动回复）
- Week 4：KB 检索 + AI 证据链 + Agent Console
- Week 5：ONES 升级建单 + 双向状态同步
- Week 6：指标看板 + UAT + 灰度上线

## 12. 与你当前输入的差异说明

- `ai-desk` 仓库当前几乎为空（仅 README），建议以本设计作为绿地实现蓝图。
- 你提供的 ONES Wiki 链接当前在 MCP 中无法直接读取到正文（权限/空间映射问题），本版先按你口述需求设计。
- 数据库连接串已可作为目标环境，但正式落地前建议先做最小连通与权限测试。

## 13. 需要你确认的决策（确认后我就进入实施设计细化）

1. **状态语义**：是否采用“AI 回复后进入 `WAITING_CUSTOMER`”作为默认，而不是直接 `AI_RESOLVED`？
2. **SLA 口径**：是否按上面的 P1-P4 目标值执行，还是你有既定 SLA 表？
3. **OpenClaw 接入**：请提供 base URL + 鉴权方式，我可直接做连通性验证。
4. **ONES 项目映射**：升级后默认创建哪种 issue type（Bug/Task/需求）？
5. **MVP 优先级**：是否按 6 周节奏推进，还是你希望先做“可演示版（2-3 周）”？

---

如果你确认本版方向，我下一步会输出：
- v1.1 系统时序图（提单->AI->升级->回写）
- DB Schema 初稿（可直接迁移）
- OpenClaw/ONES 集成接口契约（请求/响应字段）
- 前后端信息架构与页面清单（按 ones.com 风格）
