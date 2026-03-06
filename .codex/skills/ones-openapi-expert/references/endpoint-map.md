# Business Action -> Endpoint Map

All mappings are extracted from `/Users/jeremypeng/Downloads/openapi.yaml`.

## Auth

- OAuth 授权码申请
  - `GET /oauth2/authorize`
  - Scope: request parameter `scope` must be subset of app scopes.
- 申请/刷新 access token
  - `POST /oauth2/token`
  - Body: `application/x-www-form-urlencoded`
- token 详情
  - `POST /oauth2/introspect`
- 撤销 token
  - `POST /oauth2/revoke`

## 项目与 Issue

- 获取项目列表
  - `GET /project/projects`
  - Required: `teamID`
- 获取项目详情
  - `GET /project/projects/{projectID}`
- 创建项目
  - `POST /project/projects`
- 更新项目
  - `PATCH /project/projects/{projectID}`
- 删除项目
  - `DELETE /project/projects/{projectID}`

- 查询 issue 列表
  - `GET /project/issues`
  - Common paging: `limit`, `cursor`
- 创建 issue
  - `POST /project/issues`
- 获取 issue 详情
  - `GET /project/issues/{issueID}`
- 更新 issue
  - `PATCH /project/issues/{issueID}`
- 删除 issue
  - `DELETE /project/issues/{issueID}`
- 批量删除 issue
  - `POST /project/publishers/issues`

- issue 类型/状态/字段
  - `GET /project/issueTypes`
  - `GET /project/issueStatuses`
  - `GET /project/issueFields`
  - `GET /project/issueFieldGroups`
  - `GET /project/issueFields/changeLog`

## 评论 / 关注人 / 附件

- 评论列表/创建/详情/更新/删除
  - `GET|POST /project/issues/{issueID}/comments`
  - `GET|PATCH|DELETE /project/issues/{issueID}/comments/{commentsID}`

- watcher 管理
  - `GET|POST|DELETE /project/issues/{issueID}/watchers`

- issue 附件管理
  - `GET|POST /project/issues/{issueID}/attachments`
  - `GET|PATCH|DELETE /project/issues/{issueID}/attachments/{attachmentID}`
  - Upload body: `multipart/form-data`

## 工时

- simple mode
  - timesEstimated/timesRemaining/timesSpent + single timesSpent
- summary mode
  - timesEstimated/timesSpent + single items

Use IDs:
- `issueID`, `timesSpentID`, `timesEstimatedID`

## Wiki / Space / Search / Export

- Space 列表与详情
  - `GET /wiki/spaces`
  - `GET /wiki/spaces/{spaceID}`
- Space Page Tree
  - `GET /wiki/spaces/{spaceID}/pages`
- Page 详情
  - `GET /wiki/pages/{pageID}`
- 创建 Page
  - `POST /wiki/pages` (`multipart/form-data`)
- 锁定 Page
  - `PATCH /wiki/pages/{pageID}/locked`
- Page 历史版本
  - `GET /wiki/pages/{pageID}/versions`
- 搜索 pages/spaces
  - `GET /wiki/search/pages`
  - `GET /wiki/search/spaces`

- 同步导出（deprecated）
  - `GET /wiki/pages/{pageID}/export`
  - OpenAPI description marks this route as deprecated.

- 推荐异步导出
  - `POST /wiki/convert/tasks`
  - `GET /wiki/convert/tasks/{taskID}/info`
  - `GET /wiki/convert/tasks/{taskID}/data`

## 文件资源

- 上传文件
  - `POST /resources/files`
- 下载文件
  - `GET /resources/files/{fileToken}`
- 文件元数据
  - `POST /resources/files/{fileToken}/metadata`

## 部门 / 应用授权

- 部门列表与成员
  - `GET /account/departments`
  - `GET /account/departments/{departmentID}/members`
- 可授权应用列表
  - `GET /license/apps`
- 已安装 license apps
  - `GET /appcenter/apps/installedLicenseApps`
- 给用户授予 app
  - `POST /appcenter/apps/grantUser`

## Copilot

- Copilot Ask
  - `POST /wiki/ask`
  - Response: `text/event-stream`

## Failure Triage Shortcuts

- `401`:
  - bearer token missing/invalid/expired
  - wrong auth type
- `403`:
  - scope missing
  - insufficient role/permission even with valid token
