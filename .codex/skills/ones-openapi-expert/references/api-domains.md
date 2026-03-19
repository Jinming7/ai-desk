# API Domains

This file maps ONES OpenAPI capability domains to endpoint families and parameter requirements, grounded in `/Users/jeremypeng/Downloads/openapi.yaml`.

## 1) auth

- `GET /oauth2/authorize`
- `POST /oauth2/token` (`application/x-www-form-urlencoded`)
- `POST /oauth2/introspect`
- `POST /oauth2/revoke`

Common parameters:
- `client_id`, `client_secret`, `code`, `grant_type`, `refresh_token`, `redirect_uri`, `scope`, `state`

Usage:
- OAuth authorization code flow
- token apply/refresh
- token introspection and revocation

## 2) project + issue

Project:
- `GET /project/projects`
- `POST /project/projects`
- `GET /project/projects/{projectID}`
- `PATCH /project/projects/{projectID}`
- `DELETE /project/projects/{projectID}`

Issue core:
- `GET /project/issues`
- `POST /project/issues`
- `GET /project/issues/{issueID}`
- `PATCH /project/issues/{issueID}`
- `DELETE /project/issues/{issueID}`
- `POST /project/publishers/issues` (batch delete)

Issue meta:
- `GET /project/issueTypes`
- `GET /project/issueStatuses`
- `GET /project/issueFields`
- `GET /project/issueFieldGroups`
- `GET /project/issueFields/changeLog`

Common context IDs:
- `teamID`, `projectID`, `issueID`

## 3) issue-comment

- `GET /project/issues/{issueID}/comments`
- `POST /project/issues/{issueID}/comments`
- `GET /project/issues/{issueID}/comments/{commentsID}`
- `PATCH /project/issues/{issueID}/comments/{commentsID}`
- `DELETE /project/issues/{issueID}/comments/{commentsID}`

Common IDs:
- `teamID`, `issueID`, `commentsID`

## 4) issue-attachment

- `GET /project/issues/{issueID}/attachments`
- `POST /project/issues/{issueID}/attachments` (`multipart/form-data`)
- `GET /project/issues/{issueID}/attachments/{attachmentID}`
- `PATCH /project/issues/{issueID}/attachments/{attachmentID}`
- `DELETE /project/issues/{issueID}/attachments/{attachmentID}`

Common IDs:
- `teamID`, `issueID`, `attachmentID`

## 5) issue-watcher

- `GET /project/issues/{issueID}/watchers`
- `POST /project/issues/{issueID}/watchers`
- `DELETE /project/issues/{issueID}/watchers`

Common IDs:
- `teamID`, `issueID`

## 6) worklog (simple/summary)

Simple mode:
- `/project/issues/{issueID}/workLog/simple/timesEstimated`
- `/project/issues/{issueID}/workLog/simple/timesRemaining`
- `/project/issues/{issueID}/workLog/simple/timesSpent`
- `/project/issues/{issueID}/workLog/simple/timesSpent/{timesSpentID}`

Summary mode:
- `/project/issues/{issueID}/workLog/summary/timesEstimated`
- `/project/issues/{issueID}/workLog/summary/timesEstimated/{timesEstimatedID}`
- `/project/issues/{issueID}/workLog/summary/timesSpent`
- `/project/issues/{issueID}/workLog/summary/timesSpent/{timesSpentID}`

Cross-issue worklog:
- `GET /project/workLog/timesEstimated`

Common IDs:
- `teamID`, `issueID`, `timesSpentID`, `timesEstimatedID`

## 7) wiki/page/space/search/convert

Space:
- `GET /wiki/spaces`
- `GET /wiki/spaces/{spaceID}`
- `GET /wiki/spaces/{spaceID}/pages`

Page:
- `POST /wiki/pages` (`multipart/form-data`)
- `GET /wiki/pages/{pageID}`
- `GET /wiki/pages/{pageID}/versions`
- `PATCH /wiki/pages/{pageID}/locked`
- `GET /wiki/pages/{pageID}/export` (deprecated)

Search:
- `GET /wiki/search/pages`
- `GET /wiki/search/spaces`

Convert async:
- `POST /wiki/convert/tasks`
- `GET /wiki/convert/tasks/{taskID}/info`
- `GET /wiki/convert/tasks/{taskID}/data` (`application/octet-stream`)

Common IDs:
- `teamID`, `spaceID`, `pageID`, `taskID`
- optional `requestUserID` where documented

## 8) resource (file)

- `POST /resources/files` (`multipart/form-data`)
- `GET /resources/files/{fileToken}`
- `POST /resources/files/{fileToken}/metadata`

Common IDs:
- `teamID`, `fileToken`

## 9) department

- `GET /account/departments`
- `GET /account/departments/{departmentID}/members`

Common IDs:
- `teamID`, `departmentID`

## 10) app/license

- `GET /appcenter/apps/installedLicenseApps`
- `POST /appcenter/apps/grantUser`
- `GET /license/apps`

Common IDs/fields:
- `userID`, app IDs list

## 11) copilot

- `POST /wiki/ask` (`text/event-stream` response)

Common IDs:
- `teamID`
- optional `requestUserID` where documented

## High-frequency Context Checklist

- `teamID` is required on most business endpoints.
- `requestUserID` appears on several wiki/search/convert endpoints and is only valid for OAuth bot calling mode.
- Typical resource IDs: `projectID`, `issueID`, `pageID`, `spaceID`, `taskID`, `departmentID`, `fileToken`, `timesSpentID`, `timesEstimatedID`.
