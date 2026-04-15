# Cal.flare → Cloudflare D1 Migration Plan

> Plan-mode note: this file lives here because plan mode only permits edits to the designated plan file. On approval, the first execution step will copy it to `docs/plans/d1-migration.md`.

## Context

**Why**: `cal.flare` is a throwaway exploration to see whether a Cal.com-shaped app can run entirely on the Cloudflare stack (Workers + D1). D1 is SQLite-based and its Prisma adapter has real limits (no interactive transactions, limited JSON filter support, no `$transaction(async)` callback form, migrations via Wrangler). The codebase is Postgres-native today.

**Prerequisites (NOT in this plan — executed first)**:
1. Migrate Next.js → vinext (use `migrate-to-vinext` skill)
2. Swap NextAuth → better-auth
3. Confirm app runs on Workers against a local Postgres container (via Hyperdrive in prod)

Only after those three checkpoints are green do we start this plan. This keeps one variable moving at a time.

**Scope of this plan**: replace the Postgres datasource with D1, rewrite every Postgres-specific query, convert interactive transactions, and stand up Wrangler-driven migrations.

**Success criterion**: golden path (signup → create event type → book slot → cancel/reschedule) passes end-to-end against a local D1 database bound to a Worker.

---

## What we know (from exploration)

- **Schema**: 146 models, 2,852 lines. Postgres-specific surface:
  - 6 array columns (`String[]` / `Int[]`): `CalVideoSettings.instantMeetingParameters`, `Booking.scheduledJobs`, `Availability.days`, `OAuthClient.disabledIds`, `OAuthClient.redirectUris`, `EventTypeCustomInput.contains`
  - 14 `@db.Uuid`, 5 `@db.Time`, 1 `@db.Date`
  - No `@db.Citext`, no `@db.Jsonb`, no `pgvector`, no `tsvector`/FTS
  - `previewFeatures = ["views"]` only — nothing exotic
- **Raw SQL**: 12 production files. Features used: `::text/::int` casts, `EXTRACT(EPOCH FROM …)`, recursive CTEs (feature flags hierarchy), `?` JSON operator, `ANY()`, `::int[]`, `cardinality()`, `UNION ALL`, `FOR UPDATE`. All have SQLite equivalents.
- **Prisma JSON path filters**: 8 files use `where: { jsonField: { path: [...], equals: … } }` — these do NOT work on SQLite/D1. Highest-risk item.
- **Interactive transactions**: 15 callbacks across 11 files. 4 critical (bookings, seats, reassignment, user+profile sync), 5 non-critical, plus batched-form uses that are already D1-safe.
- **No Prisma middleware (`$use`) or client extensions (`$extends`)** — clean client surface.

### Critical files

**Schema**
- `packages/prisma/schema.prisma`

**Raw SQL (rewrite for SQLite)**
- `packages/features/bookings/repositories/BookingRepository.ts` (EXTRACT EPOCH)
- `packages/features/bookings/lib/handleSeats/create/createNewSeat.ts` (FOR UPDATE)
- `packages/features/eventtypes/lib/getEventTypesPublic.ts` (`::text`)
- `packages/features/users/repositories/UserRepository.ts` (casts + tx)
- `packages/features/webhooks/lib/repository/WebhookRepository.ts` (UNION + `?` + `ANY` + `cardinality`)
- `packages/features/flags/features.repository.ts` (recursive CTE)
- `packages/features/flags/repositories/PrismaUserFeatureRepository.ts` (recursive CTE)
- `packages/features/flags/repositories/PrismaTeamFeatureRepository.ts` (recursive CTE)
- `packages/lib/apps/getInstallCountPerApp.ts`
- `packages/trpc/server/routers/viewer/availability/team/listTeamAvailability.handler.ts`
- `packages/trpc/server/routers/viewer/bookings/get.handler.ts`
- `packages/trpc/server/routers/viewer/eventTypes/listWithTeam.handler.ts`

**Prisma JSON path filters (must be rewritten — Prisma SQLite can't do this)**
- `packages/trpc/server/routers/viewer/apps/toggle.handler.ts`
- `packages/trpc/server/routers/viewer/eventTypes/util.ts`
- `packages/trpc/server/routers/viewer/slots/types.ts`
- `packages/features/handleMarkNoShow.ts`
- `packages/lib/server/username.ts`
- `apps/web/lib/team/[slug]/getServerSideProps.tsx`
- `apps/web/components/setup/AdminUser.tsx`
- `apps/web/app/api/logo/route.ts`

**Interactive transactions (critical — keep atomicity)**
- `packages/features/bookings/lib/handleNewBooking/createBooking.ts:139`
- `packages/features/bookings/lib/handleSeats/create/createNewSeat.ts:44`
- `packages/features/bookings/repositories/BookingRepository.ts:2022`
- `packages/trpc/server/routers/viewer/users/_router.ts:73`

**Interactive transactions (non-critical — can batch or go non-atomic)**
- `packages/trpc/server/routers/viewer/eventTypes/heavy/update.handler.ts:421`
- `packages/features/watchlist/lib/repository/WatchlistRepository.ts:16,274,308`
- `packages/features/holidays/repositories/HolidayRepository.ts:102`
- `packages/features/credentials/handleDeleteCredential.ts:167,196`
- `packages/features/auth/signup/utils/createOrUpdateMemberships.ts:22`

---

## Agent team topology

Five agent roles. Each stream owns a disjoint set of files so they can run in parallel without stepping on each other. A single **Lead** (the orchestrating session) does schema + integration, waits for streams, then runs verification.

| Agent | Role | Files owned | Can run in parallel with |
|---|---|---|---|
| **Lead** | Orchestrator, schema owner, Prisma/Wrangler wiring, verification | `packages/prisma/**`, `wrangler.toml`, DI/container bootstrap | (drives others) |
| **Schema Agent** | Convert `schema.prisma` PG→SQLite, generate initial migration | `packages/prisma/schema.prisma` | nothing (must finish first) |
| **Raw-SQL Agent** | Rewrite 12 raw-SQL sites to SQLite dialect | Raw-SQL file list above | JSON Filter Agent, Tx Agents |
| **JSON Filter Agent** | Eliminate Prisma `path:` filters (shift to app-side filter or `json_extract` raw) | 8 JSON-path files above | Raw-SQL Agent, Tx Agents |
| **Tx-Critical Agent** | Convert 4 critical interactive `$transaction(async)` sites — preserve atomicity via batched arrays, optimistic locking w/ retry, or unique-constraint races | Critical tx files above | Tx-NonCritical Agent |
| **Tx-NonCritical Agent** | Convert 11 remaining tx callbacks to batched or sequential non-atomic form | Non-critical tx files above | Tx-Critical Agent |

**Coordination rule**: schema changes block everyone. Once Schema Agent ships Phase 1, the four surgery agents run in parallel from the same branch, each on an isolated worktree (use `isolation: "worktree"` on Agent calls). Lead rebases and merges after each stream completes.

---

## Phase 1 — Foundation (Lead + Schema Agent, sequential)

Goal: a compilable schema, generated Prisma client against D1 adapter, empty D1 database provisioned, first migration applied.

1. **Provision D1** (Lead)
   - `wrangler d1 create cal-flare-dev`
   - Add binding to `wrangler.toml`; add `DATABASE_URL` dev shim for Prisma generate
2. **Add Prisma D1 adapter** (Lead)
   - Install `@prisma/adapter-d1`
   - Update `packages/prisma/index.ts` to instantiate `PrismaClient({ adapter: new PrismaD1(env.DB) })` in Worker runtime; keep Node driver for tests/scripts behind a branch
   - Enable `previewFeatures = ["driverAdapters"]` alongside `"views"`
3. **Convert schema** (Schema Agent)
   - Swap `provider = "sqlite"`
   - `String[]` / `Int[]` → JSON-encoded `String` (document denormalization; 6 columns)
   - `@db.Uuid` → plain `String` (application-layer validation)
   - `@db.Time` → `String` (HH:MM:SS) — 5 columns
   - `@db.Date` → `String` (YYYY-MM-DD)
   - `Json` → `String` with JSON-parse wrappers in repositories (~60 columns; mechanical)
   - Enums: Prisma SQLite handles native enums as CHECK constraints — keep declarations, verify generated SQL
   - Remove any Postgres-only defaults (`gen_random_uuid()` → app-generated UUID in repo layer)
4. **Generate initial migration** (Lead)
   - `prisma migrate diff --from-empty --to-schema-datamodel ./schema.prisma --script > migrations/0001_init.sql`
   - `wrangler d1 migrations apply cal-flare-dev --local`
5. **Verify** `prisma generate` succeeds and Worker boots with a trivial `prisma.user.count()` query.

**Exit criteria**: schema compiles, migration applies, trivial query runs end-to-end.

---

## Phase 2 — Parallel surgery (4 agents, parallel worktrees)

Each agent works on an isolated worktree, ships a branch, Lead reviews + merges sequentially. Reviews happen as branches land — no big-bang merge at the end.

### Stream A — Raw SQL (Raw-SQL Agent)
Conversion table the agent follows:
- `::text` / `::int` casts → drop or use `CAST(x AS TEXT/INTEGER)`
- `EXTRACT(EPOCH FROM (a - b)) / 60` → `(julianday(a) - julianday(b)) * 1440` (minutes)
- `ARRAY[x]::int[]` / `ANY()` → decompose to `IN (?, ?, ?)` parameterized
- `cardinality(array)` → `json_array_length(col)` if stored as JSON text
- `jsonb ? 'key'` → `json_extract(col, '$.key') IS NOT NULL`
- `gen_random_uuid()` → generate in application code (e.g., `crypto.randomUUID()`)
- `FOR UPDATE` → SQLite has no row-level locking; replace with optimistic retry pattern (see Stream C)
- Recursive CTEs (`WITH RECURSIVE`) → supported in SQLite; watch `PRAGMA recursive_triggers` and depth; verify feature-flag hierarchy depth < 1000

Deliverable: all 12 raw-SQL files pass local smoke tests against D1.

### Stream B — Prisma JSON path filters (JSON Filter Agent)
Two tactics per call-site, pick the cheaper one:
- **Shift filter to application layer**: fetch by hard column filters, then `.filter()` in JS on parsed JSON (fine where row count is small — team settings, admin setup, logo config)
- **Rewrite as `$queryRaw` with `json_extract`**: when row count is large (likely `handleMarkNoShow`, event-type util)

Deliverable: zero occurrences of `path: [` inside `where:` blocks across `packages/` and `apps/`.

### Stream C — Critical transactions (Tx-Critical Agent)
- **createBooking.ts**: convert 2-op tx (optional update + create) to array-form `$transaction([cancel, create])`
- **createNewSeat.ts**: `FOR UPDATE` has no SQLite equivalent. Replace with **optimistic concurrency**: read seat count → insert with a unique `(bookingId, email)` index → on conflict, re-read and retry up to N times. Requires adding a unique index.
- **BookingRepository.ts:2022 (reassignment)**: refactor sub-function calls so ops are collected into an array, then `$transaction([...ops])`
- **users/_router.ts:73**: split into two batched transactions (user core update, then profile sync) — accept tiny window of inconsistency, log if sync fails, add a reconciliation job later

Deliverable: no `$transaction(async` callbacks remain in critical booking/auth paths.

### Stream D — Non-critical transactions (Tx-NonCritical Agent)
Convert to either array-form `$transaction([...])` or plain sequential awaits. Order:
1. `eventTypes/heavy/update.handler.ts` (host groups)
2. `holidays/HolidayRepository.ts` (cache refresh — sequential is fine)
3. `credentials/handleDeleteCredential.ts` (two tx sites)
4. `watchlist/WatchlistRepository.ts` (three tx sites)
5. `auth/signup/createOrUpdateMemberships.ts` (array form — it's a clean upsert pair)

Deliverable: zero interactive `$transaction(async` outside test fixtures.

---

## Phase 3 — Integration (Lead, sequential)

1. **Wire migrations into CI/dev workflow**
   - Add `yarn db:migrate:d1:local` → `wrangler d1 migrations apply cal-flare-dev --local`
   - Add `yarn db:migrate:d1:remote` for deployed DB
   - Remove `prisma migrate dev` references from scripts
2. **Repository-layer JSON codecs**
   - For every Json column, touch the repository that reads/writes it and add explicit `JSON.parse` on read, `JSON.stringify` on write. This is the one place business logic legitimately touches Prisma, per the existing `agents/rules/data-repository-pattern.md`.
3. **Array column codecs**
   - Same treatment for the 6 array columns (store as JSON strings, decode in repositories)
4. **Test seed data**
   - Convert `packages/prisma/seed.ts` to issue D1-compatible inserts (no bulk arrays, no `ON CONFLICT ... RETURNING`)
5. **Remove Postgres-specific dev infra**
   - Update `.env.example`, `docker-compose` references, local dev docs

---

## Phase 4 — Verification (Lead)

End-to-end smoke on a local Worker bound to local D1. No Postgres process involved at this stage.

1. `wrangler dev` bootstraps the Worker
2. Run `yarn type-check:ci --force` — zero errors
3. Golden path Playwright suite (existing fixtures):
   - Create user → login
   - Create event type
   - Book a slot
   - Reschedule
   - Cancel
   - Delete credential
4. Spot checks for converted hotspots:
   - Seat booking under concurrent attackers (script spawns 20 parallel bookings against a 5-seat event; expect exactly 5 to succeed)
   - Feature-flag hierarchy resolution for a 3-level team tree
   - Webhook priority lookup returns correct ordering
5. Inspect the D1 SQL console post-run to confirm all JSON fields round-trip cleanly

---

## Risks and explicit non-goals

**Risks**
- Optimistic locking for seats will double-book on app crash mid-retry — acceptable for throwaway, document as a caveat
- Recursive CTE depth in feature-flag lookup: if a team tree goes deeper than SQLite's default, the flag system silently returns the wrong answer. Add a depth guard during conversion.
- 1000-row default D1 return limit: the event-type list endpoint and admin user list may truncate. Add `LIMIT` parameters and pagination where the raw query returns > 1k rows.
- Prisma D1 adapter is still marked as beta — expect at least one upstream bug during integration

**Non-goals for this plan**
- Real concurrency/atomicity guarantees equivalent to Postgres
- Background job runner migration (Trigger.dev → CF Queues) — separate plan
- Read replicas / Hyperdrive fallback
- Production data migration — this is a greenfield D1 instance

---

## Order of operations (single-dev view)

```
Phase 1 (Lead + Schema Agent, sequential)          ~1–2 days
  └─ exit: schema compiles, trivial query works

Phase 2 (4 agents in parallel worktrees)           ~3–5 days wall-clock
  ├─ Stream A: raw SQL
  ├─ Stream B: JSON path filters
  ├─ Stream C: critical transactions
  └─ Stream D: non-critical transactions
     (Lead reviews + merges each branch as it lands)

Phase 3 (Lead, sequential)                         ~1–2 days
  └─ exit: migrations wired, codecs in place, seed runs

Phase 4 (Lead)                                     ~1 day
  └─ exit: golden path passes on D1
```

Estimated wall-clock with the 4-agent parallelization: ~7–10 days. Single-threaded would be ~3–4 weeks.
