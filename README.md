# ai-desk / NexusFlow (M1 + M2 Skeleton)

AI-first ticket management platform skeleton with:
- M1: Ticket core, state machine, portal/list/detail/agent queue APIs.
- M2: OpenClaw adapter interface and integration wiring.

## Stack
- `apps/web`: React 18 + TypeScript + Tailwind
- `apps/api`: Node.js + Express + TypeScript + PostgreSQL

## Quick Start
1. Copy env:
   - `cp .env.example .env`
2. Start Postgres:
   - `docker compose up -d`
3. Install dependencies:
   - `npm install`
4. Run migrations:
   - `npm run db:migrate`
5. Start dev servers:
   - `npm run dev`

Web: `http://localhost:5173`
API: `http://localhost:4000`

## API Contract
- OpenAPI: `apps/api/openapi.yaml`

## Notes
- Secrets are loaded from environment only.
- OpenClaw integration is behind `OPENCLAW_*` env values with safe fallback behavior.
