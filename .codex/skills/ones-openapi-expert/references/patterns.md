# Common Call Patterns

## OAuth Authorization Code Flow

1. Redirect user:
   - `GET /oauth2/authorize?client_id=...&response_type=code&redirect_uri=...&scope=...&state=...`
2. Receive callback with `code`.
3. Exchange token:
   - `POST /oauth2/token`
   - Content-Type: `application/x-www-form-urlencoded`
   - `grant_type=authorization_code`
4. Refresh token:
   - `POST /oauth2/token`
   - `grant_type=refresh_token`
5. Introspect token:
   - `POST /oauth2/introspect`
6. Revoke token:
   - `POST /oauth2/revoke`

## Cursor Pagination (`limit` + `cursor`)

Pattern:
1. Call endpoint with `limit` and optional `cursor`.
2. Read response page info/cursor fields.
3. Continue while next cursor exists.
4. Stop when no next cursor / has-next false.

Notes:
- Some endpoints document default/max `limit` (for example many search/department endpoints default 500 and clamp >500 or <=0).
- Do not assume offset paging where cursor paging is defined.

## Multipart Upload

Use `multipart/form-data` for:
- `POST /project/issues/{issueID}/attachments`
- `POST /wiki/pages`
- `POST /resources/files`

Rules:
- Send textual fields and file parts in one multipart request.
- Keep part key names aligned with documented schema/examples.
- For page creation, preserve relation among `cards`, `attachments`, `resources`, and referenced random IDs.

## SSE Stream Consumption

Endpoint:
- `POST /wiki/ask`

Response type:
- `text/event-stream`

Client behavior:
1. Open streaming HTTP request.
2. Read chunk/event frames incrementally.
3. Parse SSE lines (`event:`, `data:`) and handle partial payload assembly.
4. Detect stream completion and abort signals.
5. Handle documented Copilot-specific error codes (such as 409/510/511/512/513/601/602/604/605).

## Async Convert Task (Three-Step)

1. Create task:
   - `POST /wiki/convert/tasks`
2. Poll status:
   - `GET /wiki/convert/tasks/{taskID}/info`
3. Download task data:
   - `GET /wiki/convert/tasks/{taskID}/data` (binary)

Recommendation:
- Prefer this route for page export flows over deprecated sync export endpoint.

## Binary Download

Typical content type:
- `application/octet-stream`

Use cases:
- `GET /wiki/convert/tasks/{taskID}/data`
- `GET /wiki/pages/{pageID}/export` (deprecated endpoint, still binary)

Handling:
- Save raw bytes to file.
- Determine extension from requested format or response headers.
