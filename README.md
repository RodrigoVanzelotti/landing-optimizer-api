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

For the simplified Google Cloud V1 (Cloud Run + PostgreSQL, without Redis or
ClickHouse), see [the deployment guide](../landing-optimizer-infra/gcp-v1/README.md).

```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev          # requires Postgres (see infra/docker)
npm run clickhouse:migrate      # requires ClickHouse
npm run start:dev
```

### Docker watch mode
From the sibling `landing-optimizer-infra` repo (Docker Compose 2.23+):

```bash
make watch
# Windows PowerShell / without make:
docker compose -f docker/docker-compose.yml -f docker/docker-compose.watch.yml up --build --watch
```

The API uses the Dockerfile `development` target and `nest start --watch`.
Changes under `src/` synchronize immediately; TypeScript/Nest config changes
restart the service; Prisma/ClickHouse migration changes synchronize and rerun
idempotent deploy commands; package and Dockerfile changes rebuild the image.

## Key endpoints
See [../landing-optimizer-infra/docs/API_CONTRACTS.md](../landing-optimizer-infra/docs/API_CONTRACTS.md).
- `POST /v1/auth/register|login` — operator auth; registration requires a valid tenant invitation (see below).

### Tenants and team invitations

Only the platform owner (`rodrigovanzelotti@gmail.com`) can create tenants through
the dashboard **Clientes** page. Access to `/platform/tenants` is enforced by the
API using the persisted account email, independently of tenant administrator roles.
The page lists tenant details, users, sites and pending invitations; creates new
tenants with a first-admin invitation; issues password-reset links; and archives
or reactivates clients. Customer admins cannot access this page or API.

The operator CLI remains available as a fallback. After applying migrations
(`npm run prisma:deploy`) and generating the client:

```powershell
npm run tenant:create -- --tenant "Acme" --name "Ana Silva" --email "ana@acme.com" --dashboard-url "https://YOUR_DASHBOARD"
```

Set `DATABASE_URL` in the operator shell. The command prints the tenant ID and a
7-day invitation for its first administrator; send that complete URL privately.
It creates no password. The exclusive platform endpoint uses this same provisioning
transaction. Existing `owner` memberships become `admin` in the team migration.
Existing logins keep working.

In **Team members**, an administrator creates invitations for the exact email
domain of their own account, selects admin/editor/viewer and copies the generated
link. Pending invites reserve slots: each tenant has at most 10 registered users
and 3 administrators, including the initial admin. Revoking or expiring an unused
invite frees its reservation. The final administrator cannot be demoted.

Links use `/invite?name=...&email=...#SECRET`; copy the whole link, including the
fragment. The server stores only its hash. An invite binds the email, tenant and
role, expires after 7 days and can be accepted once. Acceptance creates a user in
the existing tenant, never a tenant. No mail is sent automatically; possession of
the secret link authorizes acceptance, so send it only to the intended recipient.
The former `REGISTRATION_ALLOWED_EMAILS` setting is no longer used.

| Role | Operations | Administrative settings (team, settings, billing) |
| --- | --- | --- |
| Admin | All, including experiment approvals | Read, invite, revoke invitations, change roles |
| Editor | All, including experiment approvals | Read only |
| Viewer | Read only | No access |

The API reloads the current membership for access and refresh tokens, so old tokens
do not preserve admin privileges after demotion. Limits and role changes are
serialized by a tenant row lock. Roles are tenant memberships, not global roles.
Set the API's `DASHBOARD_ORIGIN` to the dashboard origin (first origin is used in
invitation URLs). Seed, Postman and onboarding tools now log in to an existing
account; `scripts/seed.mjs` requires `DEMO_EMAIL` and `DEMO_PASSWORD`.

Password reset links last one hour, use a random secret fragment and are stored only
as hashes. A newer reset link replaces prior links. The password changes only when
the user follows the link and submits a new password on `/reset-password`. Acceptance
atomically consumes the token, hashes the new password and increments the account
session version, invalidating all previous access and refresh tokens. The endpoint
never returns a password or password hash. Send reset links privately; email delivery
is manual. The password belongs to the account across its tenant memberships.

Archiving requires typing the tenant name and preserves users, sites and history.
It blocks login, existing tokens, invitations, event/snapshot ingestion and config
reads, including cached server authorization. Restoring clears the archival flag;
still-valid sessions and invitations may work again. Previously downloaded snippet
configuration remains subject to browser/CDN cache lifetimes. The platform owner
cannot archive any tenant containing their own account, to preserve management access.
Apply `20261111150000_platform_management` before deploying this release; it adds
`tenant.archived_at`, `user.session_version` and the `password_reset` table.

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
