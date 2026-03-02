# Release Checklist

## Pre-Deploy
- Confirm `.env` contains valid `DATABASE_URL` and `OPENCLAW_*` values.
- Verify OpenClaw reachability via `GET /api/v1/integrations/openclaw/health`.
- Validate customer portal and agent portal route access map.

## Automated Gates
- `npm run db:migrate`
- `npm run build`
- `npm run test:api-integration`
- GitHub Actions workflow `.github/workflows/ci.yml` must pass.

## Manual Smoke
- Execute [apps/web/e2e/smoke-flow.md](/Users/jeremypeng/Downloads/Workspace/Ticket%20Management/apps/web/e2e/smoke-flow.md).
- Confirm customer shell has zero entry points to `/agent`.

## Rollback
- Roll back web deployment first if UI-only regression.
- Roll back API image if integration regression; keep DB migration history.
