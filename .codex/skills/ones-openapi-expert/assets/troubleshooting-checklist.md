# Troubleshooting Checklist

## 1) Auth Failures

- Check `Authorization: Bearer <token>` header exists.
- Check token not expired and issued for target tenant/domain.
- For OAuth flow issues, verify `client_id`, `client_secret`, `redirect_uri`, `grant_type`.

## 2) Scope And Permission

- If `403`, verify endpoint-required scope from OpenAPI security section.
- Verify application grant contains this scope.
- Verify caller role (admin/team scope constraints) where endpoint description mentions permission prerequisites.

## 3) Missing Context IDs

- Missing `teamID`: fetch from integration context.
- Missing `projectID`/`issueID`: query list endpoint first.
- Missing `pageID`/`spaceID`: use search/list endpoints first.
- Missing `taskID`: must come from convert task creation response.
- Missing `fileToken`: must come from resource upload response.

## 4) Request Shape Mismatch

- Ensure `Content-Type` matches endpoint contract.
- For multipart calls, ensure field names and file part keys match schema/examples.
- For page creation multipart, keep `cards`/`attachments`/`resources` and IDs consistent.

## 5) Pagination Problems

- If data incomplete, continue with returned `cursor`.
- Respect documented `limit` clamps/defaults.

## 6) Async / Streaming

- Convert task: create -> poll info until done -> fetch data.
- SSE (`/wiki/ask`): consume stream incrementally and handle stream termination/errors.

## 7) Deprecated Route Usage

- If using `GET /wiki/pages/{pageID}/export`, warn and switch recommendation to convert async route.
