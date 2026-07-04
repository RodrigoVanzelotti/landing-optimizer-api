# Landing Optimizer — Control-Plane API

NestJS + Fastify service that manages tenants, sites, experiments, approvals,
signed site config, analytics reads (ClickHouse), and AI orchestration.

## Stack
- NestJS 10 + Fastify, strict TypeScript
- Prisma + PostgreSQL (app data, RLS-enforced tenant isolation)
- ClickHouse (analytics), Redis (config cache + rate limit)
- Ed25519 config signing (verified in-browser by the snippet)
- JWT auth (short-lived) + role guards; Zod validation everywhere

## Setup
```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev          # requires Postgres (see infra/docker)
npm run clickhouse:migrate      # requires ClickHouse
npm run start:dev
```

## Key endpoints
See [../landing-optimizer-infra/docs/API_CONTRACTS.md](../landing-optimizer-infra/docs/API_CONTRACTS.md).
- `POST /v1/auth/register|login` — operator auth
- `POST /v1/sites` — create a site (generates keys + ingest key)
- `GET /v1/sites/:id/snippet` — install snippet + GTM + CSP guidance
- `POST /v1/experiments` … `/approve` `/start` `/rollback` `/kill` — lifecycle
- `POST /v1/events` (public) — ingestion; `GET /v1/config/:siteId` (public) — signed config
- `GET /v1/analytics/*` — overview / funnel / sections / experiment results

## Modules
| Module | Responsibility |
| --- | --- |
| `common/*` | Prisma, Redis, crypto/signing, auth guards, audit, Zod pipe, filters. |
| `modules/auth` | Register/login/refresh, JWT issuance. |
| `modules/sites` | Site CRUD, key generation, snippet, origins, signed config publish. |
| `modules/experiments` | Lifecycle state machine + approvals gating + rollback/kill. |
| `modules/events` | Public ingestion: key/origin check, rate limit, PII scrub, ClickHouse write. |
| `modules/analytics` | ClickHouse client + read queries + significance stats. |
| `modules/ai` | Client to the FastAPI AI service; suggestion persistence + materialization. |
| `modules/approvals` / `modules/audit` | Review queue + audit log reads. |

## Tests
```bash
npm test        # pure-logic unit tests (state machine, stats, signing)
```
