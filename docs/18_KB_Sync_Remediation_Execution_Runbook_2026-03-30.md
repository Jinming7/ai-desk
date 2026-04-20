# KB Sync 修复执行技术方案

Date: 2026-03-30

Status: executable

Owner scope: `docs-com` KB sync hardening + shared KB data recovery

Primary objective:

- 阻断本地 `LOCAL_DOCS_COM_PATH` 污染共享 KB
- 确保 `docs-com` 默认走 GitHub remote sync
- 恢复当前生产库中被错误停用的 `docs-com` 文档
- 让 checkpoint 回到真实 remote commit SHA

## 1. 当前结论

本次问题分成两部分：

1. 代码缺陷
2. 事故后遗留数据

代码缺陷已在当前仓库完成修复，核心变化如下：

- 新增显式开关：`GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=false`
- 本地 mirror 只有在显式开启时才允许参与 `docs-com` sync
- 本地 mirror 必须同时满足以下条件才有效：
  - 路径存在
  - 是合法 git worktree
  - `HEAD` 可解析
  - `HEAD` 必须是合法 SHA
  - markdown snapshot 数量大于 `0`
- 无效 local mirror 只会输出 warning 和诊断信息，不再参与 sync
- polling 不再为无效 local mirror 入队
- checkpoint 不再允许写入 `"local"` 或非法 `head`

遗留数据尚未恢复，仍需要在线上环境执行恢复动作。

## 2. 仓库内已完成改动

代码改动落点：

- `apps/api/src/config/env.ts`
- `apps/api/src/modules/github-kb/service.ts`
- `apps/api/src/modules/github-kb/service.test.ts`
- `apps/api/src/tests/github-kb.integration.test.ts`
- `apps/api/src/modules/ai/support-agent.integration-route.test.ts`
- `apps/api/src/modules/ai/support-agent.test.ts`
- `.env.example`

本地安全配置已调整为：

- `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=false`
- `LOCAL_DOCS_COM_PATH=/tmp/__disabled_docs_com_mirror__`

## 3. 已验证结果

已通过：

- `pnpm -C apps/api build`
- `NODE_ENV=test pnpm -C apps/api exec tsx --test src/modules/github-kb/service.test.ts`
- `pnpm -C apps/api test:github-kb`
- `NODE_ENV=test pnpm -C apps/api exec tsx --test src/modules/ai/support-agent.integration-route.test.ts`

说明：

- `github-kb` 集成链路已完整通过
- 本地 docs mirror 测试夹具已升级为真实 git repo，符合修复后的安全约束
- `support-agent.test.ts` 大文件仅做了抽样跑通，不作为本次 KB sync 修复阻塞项

## 4. 最终目标状态

修复完成后的验收标准：

- `docs-com` 默认使用 GitHub remote mode
- local mirror 默认关闭
- 无效本地目录不会影响 status、polling、checkpoint
- `kb_sync_checkpoints.last_synced_commit_sha` 不再出现 `"local"`
- `kb_documents.is_active` 与 `kb_chunks.is_active` 恢复为远端快照真实状态
- `/api/v1/internal/kb/docs-com/status` 中 `kbActive > 0`

## 5. 执行分阶段方案

### Phase A: 代码变更上线

目标：

- 先上线“防再污染”的代码
- 确保恢复数据时不会再次被本地 worker 覆盖

执行步骤：

1. 提交并部署当前仓库代码
2. 确认部署环境中的配置满足：
   - `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=false`
   - 未显式启用 `LOCAL_DOCS_COM_PATH` 作为生产 sync source
3. 如存在独立 worker 进程或 launchd 服务，确认其运行环境也带有相同配置

确认点：

- 新版本服务已部署
- 生产或预发布环境不再隐式启用 local mirror
- 本地机上的 `kb-worker` 未重新启动

失败回滚：

- 若新版本部署异常，先回滚应用版本
- 但不得恢复 `GITHUB_KB_ENABLE_LOCAL_DOCS_MIRROR=true`

### Phase B: 事故数据恢复

目标：

- 清除被污染 checkpoint
- 强制重新以 remote snapshot 为准完成一次 full sync

执行顺序必须固定：

1. 确认 Phase A 已完成
2. 清理坏 checkpoint
3. 触发 remote full sync
4. drain sync jobs
5. 验证 active docs 恢复

#### B1. 重置污染 checkpoint

执行 SQL：

```sql
UPDATE kb_sync_checkpoints
SET last_synced_commit_sha = NULL,
    last_full_synced_commit_sha = NULL,
    updated_at = NOW()
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master';
```

执行后确认：

- `last_synced_commit_sha IS NULL`
- `last_full_synced_commit_sha IS NULL`

失败处理：

- 若 repo_id 不存在，先查询 `kb_repo_registrations` 确认 `BangWork/docs-com` 当前激活 repo id

#### B2. 触发远端 full sync

执行：

```bash
curl 'https://nexus-flow-desk.vercel.app/api/v1/internal/kb/docs-com/ensure' \
  -H 'content-type: application/json' \
  -H 'x-portal-surface: internal' \
  --data '{"mode":"full","actor":"internal_operator","runLimit":0}'
```

预期：

- 返回成功
- enqueue 一个 `docs-com` 的 `full` sync job

失败处理：

- 若返回 validation error，先检查部署配置是否仍在尝试 local mirror
- 若返回 repo registration mismatch，先查询当前 active registration

#### B3. drain jobs

执行：

```bash
curl 'https://nexus-flow-desk.vercel.app/api/v1/internal/kb/sync/run' \
  -H 'content-type: application/json' \
  -H 'x-portal-surface: internal' \
  --data '{"limit":4}'
```

重复执行直到满足：

- 没有 `queued/running` 的 `docs-com` sync jobs
- 最新 checkpoint 变成真实 SHA
- `kbActive > 0`

#### B4. 验证恢复结果

API 验证：

```bash
curl 'https://nexus-flow-desk.vercel.app/api/v1/internal/kb/docs-com/status?limit=10' \
  -H 'x-portal-surface: internal'
```

必须确认：

- `sourceSnapshot.mode = remote`
- `overview.kbActive > 0`
- `checkpoint.lastSyncedCommitSha` 是真实 SHA
- `checkpoint.lastFullSyncedCommitSha` 是真实 SHA
- `recentJobs` 中不存在新的 `after_commit_sha = local` 相关污染迹象

数据库补充验证：

```sql
SELECT branch, last_synced_commit_sha, last_full_synced_commit_sha, updated_at
FROM kb_sync_checkpoints
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master';
```

```sql
SELECT
  COUNT(*) AS kb_total,
  COUNT(*) FILTER (WHERE is_active = true) AS kb_active
FROM kb_documents
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
  AND branch = 'master';
```

```sql
SELECT id, sync_mode, source, status, before_commit_sha, after_commit_sha, updated_at
FROM kb_sync_jobs
WHERE repo_id = 'ba9854da-2076-4144-874c-efe82b4ef335'
ORDER BY updated_at DESC
LIMIT 20;
```

### Phase C: 观察期

目标：

- 确认系统不再回退到 local mirror
- 确认 polling/worker 稳定

观察项：

- 新产生的 checkpoint 均为 SHA
- 新产生的 polling job 不带 `"local"`
- `docs-com` status 的 `sourceSnapshot.mode` 维持 `remote`
- `kbActive` 持续大于 `0`

建议观察时间：

- 至少 1 个 polling 周期
- 最好观察 2 到 3 个 polling 周期

## 6. 风险与控制

### 风险 1: 代码未上线就执行数据恢复

后果：

- 恢复后仍可能被旧 worker 再次污染

控制：

- 必须先完成 Phase A，再做 Phase B

### 风险 2: 本地 worker 被自动重启

后果：

- 再次向共享数据库写入错误 checkpoint

控制：

- 确认 launchd 未加载
- 确认独立 worker 副本未运行
- 确认本地 `.env` 中 local mirror 默认关闭

### 风险 3: 误在错误 repo_id 上执行 SQL

后果：

- 重置了错误的 checkpoint

控制：

- 先查 `kb_repo_registrations`
- 确认当前 active 的 `BangWork/docs-com` repo id 后再执行

## 7. 回滚原则

本次方案分两种回滚：

1. 代码回滚
2. 数据回滚

代码回滚原则：

- 仅在新版本引入非 KB sync 相关严重故障时回滚
- 不允许通过重新启用 local mirror 来“临时恢复”

数据回滚原则：

- 本方案优先使用“重新 remote full sync”恢复，不设计回滚到 `"local"` checkpoint
- 若 full sync 失败，应继续排查 sync 原因，不要重新写回坏 checkpoint

## 8. 新 Session 执行指令

如果要在新 session 中继续执行，请直接使用下面这段作为开场指令：

```text
请严格按照 /Users/jeremypeng/Downloads/Workspace/TicketManagement/docs/18_KB_Sync_Remediation_Execution_Runbook_2026-03-30.md 执行 KB sync 修复，不要重新设计方案。

执行要求：
1. 先确认代码修复是否已在当前工作区完成并通过 build / github-kb 测试。
2. 再按文档顺序执行 Phase A -> Phase B -> Phase C。
3. 每一步都要先说明目标、再执行、再给出确认结果。
4. 不允许跳步，不允许把 local mirror 当作生产来源。
5. 如果要动线上 checkpoint，先把 SQL 和目标 repo_id 再确认一遍。
6. 最终只给我：执行了什么、结果是什么、还剩什么。
```

## 9. 本次执行建议

建议下一次实际操作从这里开始：

1. 打开本 runbook
2. 确认代码已部署
3. 执行 checkpoint reset
4. 执行 remote full sync
5. 验证 `kbActive > 0`

这五步是当前最短恢复路径。
