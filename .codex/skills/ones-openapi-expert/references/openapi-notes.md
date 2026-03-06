# OpenAPI Notes And Constraints

Source: `/Users/jeremypeng/Downloads/openapi.yaml` (`openapi: 3.0.1`, `info.version: 2.0`).

## Authentication & Scope

- `components.securitySchemes.oauth2` defines authorizationCode flow.
- `authorizationUrl`: `https://your-domain/oauth2/authorize`
- `tokenUrl`: `https://your-domain/oauth2/token`
- Most business endpoints use `security: oauth2` with explicit scopes.
- Always include scope requirements in answer output.

## 401 vs 403

Observed repeated response definitions:
- `401`: authentication credentials incorrect or missing.
- `403`: scope check fails.

Guideline:
- Diagnose 401 as credential/authorization header/token lifecycle problems.
- Diagnose 403 as scope/permission mismatch problems.

## High-Frequency Parameters

- `teamID`: required by a large portion of endpoints.
- `requestUserID`: appears in wiki/search/convert/page endpoints; documented as only valid for OAuth bot calling mode.
- Common IDs: `projectID`, `issueID`, `pageID`, `spaceID`, `taskID`, `departmentID`, `fileToken`, `timesSpentID`, `timesEstimatedID`, `commentsID`, `attachmentID`.

## Body Type Patterns

- `application/json`: most CRUD endpoints.
- `application/x-www-form-urlencoded`: OAuth token exchange (`/oauth2/token`).
- `multipart/form-data`: file upload and complex page creation.
- `text/event-stream`: Copilot ask stream (`/wiki/ask`).
- `application/octet-stream`: convert/export binary downloads.

## Pagination Pattern

- Many list APIs use `limit` + `cursor`.
- Several endpoints describe default and clamp behavior for `limit` (for example default 500, reset to 500 when invalid/out of range).

## Async Task Pattern

- Wiki convert uses a 3-stage task process:
  - create task
  - poll task status/info
  - download task data

## Deprecated / Compatibility Reminders

- `GET /wiki/pages/{pageID}/export` is explicitly marked deprecated in description and points to async convert route.
- Many endpoints include `History` tables (`Added in`, sometimes update notes). Treat these as compatibility hints and mention version sensitivity when relevant.

## Non-Expansion Rule

When users ask about capability not discoverable in this OpenAPI file:
- explicitly answer `不确定（文档未显示）`
- optionally provide nearest documented alternative route, clearly marked as inference.
