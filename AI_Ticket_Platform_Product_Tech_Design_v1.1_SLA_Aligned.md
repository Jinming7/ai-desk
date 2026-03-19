# AI-Driven Ticket Management 平台（产品+技术设计 v1.1，SLA对齐版）

版本：v1.1  
日期：2026-03-02  
依据页面：
- ONES Wiki `7RVHB7wF`（✅ONES Service Level Agreement）
- ONES Wiki `RRu62MNG`（Atlassian SLA 调研）

## 1. 本次设计更新（相对 v1.0）

根据你提供的两页 Wiki，本次设计核心变化：
1. SLA 分层明确为“产品可用性承诺 + 服务补偿承诺”，而不是“承诺解决时长”。
2. 补偿机制明确采用 `Service Credit`（账单抵扣），不做现金赔偿。
3. 工单平台内要内建 `SLA Claim`（事故申报+补偿申请）双流程与时限校验。
4. Uptime 采用分钟级计算：`Error Rate > 5%` 的分钟计为 `Downtime Minute`。
5. `Reseller` 场景单独建模：申请主体、结算主体、通知链路都不同。
6. Ticket Portal 需要承接“Raise Request from Ticket Portal”作为受SLA覆盖体验之一。

## 2. 产品层设计（SLA）

### 2.1 SLA 结构（建议对外表达）
- **Availability SLA（可用性）**：按月度 Uptime 百分比承诺（按 plan 分层）。
- **Support Response SLO（支持响应）**：作为 support policy 给出初始响应目标（IRT），不作为法律 SLA 赔付项。
- **Compensation Policy（补偿）**：当 Availability SLA 未达标，可申请 Service Credit。

说明：依据调研页结论，建议不承诺 `Resolution Time` 为法务 SLA，仅在产品运营中作为内部管理指标。

### 2.2 Plan 分层（对齐当前页面）
- Business Plan：SLA 99.9%
- Enterprise Plan：SLA 99.95%

并保留扩展：后续若你定义 Free/Standard/Premium/Enterprise 的全线产品策略，后台可配置映射表，不写死在代码里。

### 2.3 Compensation 梯度（对齐当前页面）
建议先按你页面中的逻辑落地：
- Business：
  - `<99.9% 且 >=99.0%`：5%
  - `<99.0% 且 >=95.0%`：25%
  - `<95.0%`：50%
- Enterprise：
  - `<99.95% 且 >=99.90%`：10%
  - `<99.90% 且 >=99.00%`：25%
  - `<95.0%`：50%

> 以上百分比是“受影响产品当月订阅费”的抵扣比例。

### 2.4 SLA Claim 用户流程（新增）
在 Ticket Portal 增加“申请 SLA 补偿”入口，拆分两步：
1. Incident Report（事故申报）
2. Service Credit Request（补偿申请）

关键规则：
- 申报时限：事故发生月份结束后 `15 个工作日` 内。
- 证据源：ONES 监控日志为唯一判定依据（页面原文口径）。
- 审核结果：通过后在“下一期账单”生效（同一产品续费抵扣）。
- 非现金、不可转让、不续费则作废，且上限不超过该计费周期受影响产品费用。

### 2.5 Reseller 流程（新增）
- 补偿申请由 Reseller 提交/对接。
- Credit 发放给 Reseller，不直接发放给终端客户。
- Reseller 负责与终端客户结算。

## 3. Ticket 平台能力映射（你要做的系统）

### 3.1 外部 Portal 增强模块
新增页面：
- `SLA Status`：展示当前月 uptime、是否触发补偿区间、估算 credit。
- `SLA Claim Center`：发起/跟踪 incident 与 credit 申请。
- `Covered Experience` 说明页：清晰写明覆盖范围（browser-based，API/mobile 默认不覆盖）。

### 3.2 Agent Console 增强模块
新增队列：
- `SLA Claims Queue`：审核、补证、驳回、批准。
- `Reseller Claims`：区分 partner 处理单。

新增字段：
- `claim_type`（incident/credit）
- `claim_deadline_at`
- `billing_cycle`
- `is_reseller_case`
- `credit_percent`
- `credit_amount`

### 3.3 OpenClaw 在 SLA 流程的职责
OpenClaw 不做“最终判定”，做“审单助手”：
- 自动识别是否满足申请时限。
- 自动生成 claim 摘要与证据索引。
- 自动草拟“受理/补证/驳回”回复。
- 自动判定是否触发人工复核（高金额/争议/大客户）。

## 4. 技术设计（SLA落地）

### 4.1 新增核心表（在 v1.0 基础上）
- `sla_coverage_experiences`
  - 记录受覆盖体验（例如：Desk 中 View/Edit/Raise Request）
- `availability_samples`
  - minute 粒度观测值：`total_requests`, `failed_requests`, `error_rate`
- `uptime_monthly_rollups`
  - 月聚合结果：`downtime_minutes`, `monthly_uptime`
- `sla_claims`
  - 申报与补偿主表（状态机）
- `sla_claim_evidences`
  - 证据快照（日志索引、监控图、原始数据哈希）
- `sla_credits`
  - 核准补偿记录（percent/amount/product/billing_cycle）

### 4.2 关键计算规则（系统固化）
- `error_rate = failed_requests / total_requests`
- 当 `error_rate > 0.05`，该分钟计入 `downtime_minutes`
- `monthly_uptime = (1 - downtime_minutes / total_minutes_in_month) * 100`
- 根据 plan+阈值匹配 credit tier

### 4.3 SLA Claim 状态机（建议）
`DRAFT -> SUBMITTED -> UNDER_REVIEW -> NEED_MORE_INFO | APPROVED | REJECTED -> CREDIT_ISSUED`

并行关系：
- incident 单与 credit 单可绑定同一 `incident_id`
- credit 单必须关联 incident 单

### 4.4 API 草案（新增）
- `POST /api/v1/sla/incidents`
- `POST /api/v1/sla/credits`
- `GET /api/v1/sla/claims/{id}`
- `GET /api/v1/sla/uptime?product=desk&month=2026-02`
- `POST /api/v1/sla/claims/{id}/review`
- `POST /api/v1/sla/claims/{id}/issue-credit`

### 4.5 审计与合规
- 所有 SLA 判定结果保留原始指标快照与判定版本号。
- 判定函数版本化（避免后续规则变更导致追溯不一致）。
- 审核动作全链路留痕（谁、何时、为什么）。

## 5. 与 AI Ticket 主流程的统一

### 5.1 外部客户主路径
1. 提单（Portal）
2. OpenClaw 首轮处理（回复/追问/升级）
3. 若涉及服务可用性争议，转入 SLA Claim 流程
4. 审核通过后生成 credit，写回客户视图

### 5.2 内部 R&D 路径（后续接 ONES）
- AI 判断需升级时，在指定 ONES 项目建单。
- ONES issue 解决后回写 Ticket Core。
- 若问题构成可用性事故，自动触发 SLA incident 草稿。

## 6. 已确认决策（2026-03-02）

你已明确确认：
1. **AI 回复后默认状态统一进入 `WAITING_CUSTOMER`**。
2. OpenClaw 使用云端地址：`https://47.250.122.37/`。
3. 升级到 ONES 的实现细节后续再对接（届时再补项目/字段映射）。

## 7. OpenClaw 接入现状与最小信息清单

### 7.1 当前探测结果
- `https://47.250.122.37/` 返回 `401 Unauthorized`，并带 `WWW-Authenticate: Basic realm="Restricted"`。
- `/health`、`/healthz` 当前返回 OpenClaw Control 前端 HTML，不是机器可用健康接口。
- 结论：当前需要认证信息后，才能继续 API 探测与正式接入。

### 7.2 你需要提供的最小信息（我拿到即可直接集成）
1. Basic Auth 用户名与密码（或等价访问方式）。
2. 可调用的 Agent API 路径（若你不清楚，我会在拿到认证后自动探测）。
3. 鉴权方式（二选一）：
   - 仅 Basic Auth；
   - Basic Auth + API Key/Bearer Token（请给 header 名称与示例）。
4. 期望超时与并发上限（可先用默认：30s 超时、每租户并发 5）。

## 8. 下一步（可直接执行）

我收到上面 4 项后，直接完成：
1. **OpenClaw 连通性验证**（健康检查 + 示例 ticket 推理请求）。
2. **集成适配层设计定稿**（重试、熔断、幂等、审计）。
3. **端到端时序图**：Portal -> OpenClaw -> Ticket Core -> SLA Engine（ONES 升级节点预留）。
4. **DB DDL 初稿**：PostgreSQL 可直接迁移。
5. **接口契约文档**：先交付 OpenClaw 契约，ONES 契约留待你后续提供项目信息后补全。

## 9. OpenClaw 联调诊断（2026-03-02）

### 9.1 已验证结论
- 网关 WebSocket 可握手（`wss://47.250.122.37/` 返回 `101`，并收到 `connect.challenge` 事件）。
- `connect` 请求协议为 RPC 帧：`{type:'req', id, method, params}`，其中 `method='connect'`。
- `client.id` 必须使用 `openclaw-control-ui`（非任意字符串）。
- 当前存在两类配置约束：
  1. `origin not allowed`（需配置 `gateway.controlUi.allowedOrigins`）。
  2. `CONTROL_UI_DEVICE_IDENTITY_REQUIRED`（需安全上下文设备身份）。

### 9.2 当前阻塞
- 通过脚本/非浏览器环境无法完成 Control UI 设备身份校验，导致 `connect` 被拒绝。
- `https://47.250.122.37/__openclaw/control-ui-config` 当前返回前端 HTML，推断反向代理把配置接口回退到了 SPA。

### 9.3 建议修复（服务端）
1. 在 OpenClaw 网关配置中显式允许来源：
   - `gateway.controlUi.allowedOrigins` 包含你的控制台域名（建议使用正式域名，不用裸 IP）。
2. 若必须在非安全上下文运行，临时开启：
   - `gateway.controlUi.allowInsecureAuth=true`（仅测试环境）。
3. 反向代理（Nginx）中为配置接口与网关接口设置独立 `location`，避免被 `try_files ... /index.html` 吞掉。
4. 生产环境建议：
   - 使用受信任证书 + 域名（保证 secure context）。
   - 关闭 `allowInsecureAuth`。

### 9.4 集成侧固定参数（Ticket Core -> OpenClaw）
- 网关地址：`wss://47.250.122.37/`（后续建议替换为域名）。
- `connect` 必填：
  - `minProtocol=3`, `maxProtocol=3`
  - `client.id='openclaw-control-ui'`
  - `role='operator'`
  - `scopes=['operator.admin','operator.approvals','operator.pairing']`
  - `auth.token` / `auth.password`（至少一个）
