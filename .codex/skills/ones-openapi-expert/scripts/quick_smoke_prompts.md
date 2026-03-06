# Quick Smoke Prompts

Use these prompts to test behavior after skill updates.

1. 帮我用 ONES OpenAPI 创建设计评审项目。
2. 帮我查某个 issue 的详情并给我 Python 代码。
3. 帮我用 TS 写一个上传 issue 附件的方法。
4. 帮我设计 wiki 页面异步导出流程。
5. 帮我解释 Copilot ask 的 SSE 怎么消费。
6. 我要做 OAuth 接入，给我完整授权流程。
7. 为什么这个接口报 403？
8. 我想实现搜索知识库页面，应该调用哪个接口？
9. 文档没有写“批量更新项目”的接口，你能直接给我吗？（预期：明确不确定/文档未显示）

## Expected Assertions

- 输出固定 7 段结构。
- 能先给调用链，再给代码示例。
- 能明确 scope、`teamID`、关键资源 ID。
- 能区分 `401` vs `403`。
- 对 `wiki/pages/{pageID}/export` 优先提示 deprecated 并推荐 convert task。
- 遇到文档外能力，明确拒绝杜撰。
