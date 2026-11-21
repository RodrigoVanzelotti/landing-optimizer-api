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

### Insight approval and experiment preparation

The dashboard groups experiments into five stages: awaiting approval (also
containing approved proposals ready to start), experimenting, results available,
expired, and denied. Approving an insight remains the only approval required for
its experiments; the board does not introduce another review step.

Unstarted proposals expire exactly seven elapsed days after the experiment's
`createdAt`, not after the insight's creation or approval. Approval and scheduling
do not renew this deadline. Running tests, genuinely paused tests that already
started, completed tests and refused proposals do not expire. Pausing/cancelling
a schedule before any start cannot bypass expiry. A valid approved or scheduled
proposal may be refused without running it.

Expiry is derived at read/write time: list/detail responses add `expiresAt`
(nullable ISO timestamp) and `expired`; the stored lifecycle status and audit
history remain intact. Expired records stay readable, but mutations return 409.
Writes guard the deadline inside the transaction and atomic experiment update,
so a stale browser cannot start an expired test. No expiration job, database
migration or change to the IA module is needed for this rule.

Insights and experiments use a one-to-many relationship: each experiment has
an optional `insightId`, while each insight returns `approvedAt`,
`experimentsReadyAt` and an `experiments` list (`id`, `name`, `status`).

Business decision: approving an insight also authorizes/approves its experiments.
They must be ready within **24 hours after insight approval**, without a second
human approval. Preparation will use batch processing in the IA module. The UI
communicates preparation, the deadline, readiness and overdue status without
exposing that technical mechanism. Approval does not automatically start a test
or publish a site configuration.

`POST /ai/suggestions/:id/approve` requires an editor and atomically records the
approval and its audit event; it does **not** generate experiments, call IA,
enqueue work or create placeholder results. `approvedByUserId` is stored for
approval inheritance and excluded from the public insight listing. Repeated
approvals are idempotent.

The internal `AiService.completeExperiments(tenantId, insightId, proposals)` is
the API integration point for future completed results. It rejects unapproved
insights, validates the complete delivery, creates multiple `approved`
experiments with inherited approval records, and records readiness/audit in one
transaction. Repeated deliveries do not create duplicates. It does not invoke
or implement the IA module and has no user-facing HTTP route. The future
authenticated worker/callback, batch execution and throughput controls remain
to be implemented with the IA module. The 24-hour commitment depends on that
integration; this change implements state, validation and communication only.

An insight may provide an optional `experimentProposals` array (at most 10 text
experiments). These are optional possibilities, not ready-made experiment records.
Completed deliveries use the same proposal shape. Each entry has `selector`, `proposedValue`, optional `originalValue`,
optional `name`, and optional `type` (`copy`, `cta`, `headline`). Proposals are
validated against safe selectors and current brand guidelines when preparation
results arrive. Earlier single `selector`/`proposedValue` payloads remain readable.
An insight without ready-made proposals can also be approved for later preparation.

`GET /sites/:id/ai/suggestions?insightId=...` loads a particular origin insight,
including older records. `/experiments` and `/approvals` accept `insightId` as
well as their existing site/status filters. All queries retain tenant/site scope.
The former `materialize` endpoint and the manual `/sites/:id/ai/analyze` route
are removed. Internal `AiService.analyze` remains available for the API/IA
automatic generation workflow, whose scheduling/throughput is future work.

Apply migration `20261121220000_insight_approval_experiments` before releasing
the API/dashboard. It preserves existing associations without inventing prior
approvals. Explicitly approving a legacy insight retains existing experiments,
approves its earlier drafts and preserves live/terminal states; it never duplicates them.
Ambiguous or cross-workspace legacy associations stop migration for review.
The migration removes the old `experiment_id` column: coordinate application
with API rollout so the earlier API revision is no longer serving insight requests.

### Optional insight evidence contract

The dashboard and API support variable insight cards. This step prepares the
contract; the Python IA module, its automatic traffic-triggered insight generation
and batch experiment preparation are separate work. No manual insight generation
is available in the dashboard or its public control-plane routes.

`AiClient` accepts these optional fields on each suggestion returned by
`/internal/analyze` (illustrative references, not real site data):

```json
{
  "kpiKeys": ["ctaClicks", "ctaClicksPerView"],
  "designContext": {
    "selector": "#cta",
    "observation": "Hipótese: uma chamada mais específica pode esclarecer o próximo passo."
  }
}
```

Neither block is mandatory, and they can be combined: two KPIs, one KPI plus
a captured element, or another supported selection. `expectedImpact` remains
optional and is displayed as a hypothesis. Up to six distinct KPI references
are accepted per suggestion. The future IA module must preserve these fields
in its response schema and consume the supplied KPI catalog without truncating
away the references it uses; its current fixed schema/prompt does not do this yet.
Its explanation should separate observed facts from the proposed hypothesis,
use only catalog figures, and avoid causal claims or guaranteed improvements.

The API supplies `metrics.kpis`, a catalog with keys, measured values, labels,
units and definitions from the same 30-day report used by the dashboard (complete
UTC days, excluding today and known bots). Keys include `pageViews`, `sessions`,
`ctaClicks`, `conversions`, `formStarts`, `formCompletions`, `ctaClicksPerView`,
`conversionsPerView`, `formCompletionRate`, and `section:<id>:views|deadClicks|rageClicks|dwellMs`.
Models select keys; they do not supply authoritative numeric evidence.

Before persistence, the API resolves selected keys and design selectors against
that site's report and latest sanitized page map. Unknown references fail the
analysis before any suggestions are written. Resolved `kpis`, `analysisPeriod`
(range, coverage, session/page-view sample and optional comparison period), and
optional `designContext` (captured text/path/time plus model interpretation) are
stored in the existing suggestion JSON payload, without a database migration.
Ratios with no denominator remain null; comparisons require complete history.
KPIs are site- or section-level observations, not proof that a specific element
caused a result. Element observations describe a capture, not necessarily today's design.

Legacy responses without references remain compatible and are shown without
verified evidence; no current values are attached retroactively. Sites without
page views and demonstration-provider results cannot create new insights.

See [../landing-optimizer-infra/docs/API_CONTRACTS.md](../landing-optimizer-infra/docs/API_CONTRACTS.md).
- `POST /v1/auth/register|login` — operator auth; registration requires a valid tenant invitation (see below).

### Dashboard sessions

`POST /v1/auth/login` accepts `{ email, password, rememberMe?: boolean }`.
Persistence is disabled by default. With `rememberMe: true`, the secure HttpOnly
refresh cookie survives browser restarts; otherwise it is a browser session cookie
(browser session-restore settings can retain these cookies).

`JWT_ACCESS_TTL` defaults to 900 seconds and `JWT_REFRESH_TTL` to 2592000 seconds
(30 days). The refresh token expiry is fixed at login and preserved on renewal;
the final access token is capped at that deadline. Persistent cookie Max-Age also
shrinks to the time remaining. Check deployment overrides of `JWT_REFRESH_TTL`
when rolling out this policy. Existing refresh tokens retain their original expiry
and become nonpersistent on refresh; users opt in at their next login. Invitation
acceptance creates a nonpersistent session. Password resets, removed memberships
and archived tenants continue to invalidate access. Logout clears the browser cookie;
it does not revoke previously copied JWTs on the server.

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

Administrators can remove another member in **Team members** after confirmation.
`DELETE /v1/team/members/:id` removes only that tenant membership, immediately
blocking access and refresh tokens for it. The account, other memberships and
history are preserved; pending invitations sent by the removed member are revoked.
Self-removal and removal of the last administrator are rejected. Existing accounts
remain subject to the current invitation rule that rejects already registered emails.

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

Conversion goals of kind `url` match incoming `page_view` paths (exact, prefix,
contains or regex); `form_submit` matches native submissions, optionally by the
exact sanitized form selector. Both retain the source event and generate a
`conversion` with the configured goal name. They apply prospectively, without
backfilling earlier traffic. Explicit `event` goals use `conversion(name)`.

Experiment results count each exposed session once per variant and only count
matching conversions after exposure, up to the experiment end. Sessions use the
existing daily privacy salt. A selected primary goal filters these results;
without one all conversion goals count. Drafts/AI suggestions can select a goal
through `PATCH /v1/experiments/:id` with `primaryGoalId` (or null to clear it).

```bash
npm test        # pure-logic unit tests (state machine, stats, signing)
```

For the opt-in SQL attribution tests, start disposable PostgreSQL 16 and
ClickHouse 24.3 containers named `lo-goals-postgres-check` and
`lo-goals-clickhouse-check`, then run with `GOAL_SQL_INTEGRATION=1`. These tests
replace the `events` table inside those dedicated containers; never point them
at a live database. The ordinary test run skips these two integration cases.
