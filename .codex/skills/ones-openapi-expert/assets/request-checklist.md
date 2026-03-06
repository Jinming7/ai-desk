# Request Checklist (Pre-call)

Use this checklist before building final API calls.

- Confirm `BASE_URL` (e.g. `https://your-domain/openapi/v2`).
- Confirm `ACCESS_TOKEN` and token freshness.
- Confirm `teamID` availability.
- Confirm required resource IDs (`projectID`/`issueID`/`pageID`/`spaceID`/`taskID`/`fileToken`).
- Confirm endpoint scope is granted to OAuth app and token.
- Confirm request body content type (`json` / `x-www-form-urlencoded` / `multipart`).
- For list APIs, define pagination strategy (`limit` + `cursor`).
- For convert/export or streaming calls, define async/SSE handling strategy.
- For upload/download, confirm local file path and output destination.
