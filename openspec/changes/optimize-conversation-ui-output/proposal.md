## Why

当前对话界面虽然具备检索功能，但回答展示层级混乱、输入区与消息区割裂、可读性与可执行性不足，用户很难在首屏快速获得“下一步怎么做”。该问题已直接影响用户满意度与自助解决效率，需要立即通过规范化输出与界面重构提升可用性。

## What Changes

- 重构对话主界面布局，统一为“消息流 + 底部输入区”一体化体验，减少空白浪费与视觉割裂。
- 统一消息气泡视觉规则（AI/用户差异化、可读宽度、圆角与阴影规范）并优化滚动区域体验。
- 将回答卡片改为“直接结论 → 执行步骤 → 验证方式 → 来源引用”的固定阅读顺序，提升直观性。
- 强化输入区交互（自适应输入高度、发送按钮反馈、错误重试入口）以降低会话中断率。
- 优化结果信息密度与层级，避免重复内容堆叠，确保首屏信息可执行。

## Capabilities

### New Capabilities
- `conversational-ui-experience`: 定义多轮问答界面的布局、视觉与交互标准，确保输入、消息与状态反馈一致可用。
- `answer-presentation-contract`: 定义检索回答在前端的展示结构与信息优先级，保证输出直观、可执行、可验证。

### Modified Capabilities
- None.

## Impact

- Affected code:
  - `apps/web/src/pages/PortalPage.tsx`
  - `apps/web/src/styles.css`
  - `apps/web/src/lib/types.ts`（如需扩展展示字段）
- Affected APIs:
  - `/api/v1/ai/search`（仅在展示字段映射需要时，保持向后兼容）
- UX impact:
  - 提升对话首屏可读性、降低理解成本、提高用户在无需提单情况下的自助解决率。
