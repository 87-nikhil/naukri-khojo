# Multi-user portal and automation architecture

## Purpose

This document describes the staged evolution of Naukri Khojo from its current single-user local browser automation worker into a service for many portal accounts. The first durable job-hunt queue increment is now implemented behind an opt-in environment flag. It is not yet a claim of 100-user readiness.

## Current architecture and limit

The main portal authenticates users with MongoDB-backed accounts and JWTs. Its jobs, resumes, applications, and reports are generally filtered by `userId`.

Automation is a separate Express service that still defaults to local-only operation. Its original single-user mode stores one profile, job state, platform sessions, email settings, contacts, and reports in `.automation/` (or one configured `AUTOMATION_DATA_DIR`). The store now resolves account sessions into isolated directories while leaving the legacy owner in the original path. `portal-owner.json` binds each directory to one portal account.

This protects the current local setup. The automation store now supports portal-account-scoped directories under `AUTOMATION_DATA_DIR/users/`, with one browser profile and run lock per account. A legacy owner continues using its existing root directory; other accounts get separate directories. Do not remove the owner check or point several accounts at one unscoped data directory. Shared-disk, multi-replica automation still needs an external state/object store and a distributed worker queue.

## Recommended target

Keep the Vercel app as the authenticated web/API layer. Move long-running automation to a separate worker service backed by shared persistent infrastructure:

```text
Browser
  | authenticated portal API (JWT)
  v
Portal API / Vercel functions ---- MongoDB (user-owned records)
  | enqueue job with userId
  v
Durable queue (Redis/BullMQ or managed equivalent)
  | claim one task with lease + idempotency key
  v
Automation worker containers
  | isolated browser context and secrets for one user/task
  +---- MongoDB (job state, profile references, outcomes)
  +---- Private object storage (resume files, evidence, attachments)
```

Vercel functions should authenticate requests, validate input, read/write short operations, and enqueue work. They should not own browser sessions, scheduler state, or long-running application runs. Workers should be deployable separately and scale independently from web requests.

## Data ownership and records

Every user-created or user-visible record must have an immutable `userId` owner. Enforce the owner in database queries and in service-layer functions; never rely on the client to provide a trusted owner ID.

Recommended record groups:

| Data | Suggested storage | Ownership and notes |
|---|---|---|
| Account and authentication | MongoDB `User` | Existing account ID remains the owner key. Never expose password hashes. |
| Candidate profile and preferences | MongoDB `CandidateProfile` (or an expanded profile document) | Unique index on `userId`; use an explicit merge policy for fields imported from the existing `Resume` record. |
| Resume documents | Private object storage plus MongoDB metadata | Store object key, owner, content type, size, checksum, and timestamps. Do not store public URLs. |
| Jobs and applications | Existing MongoDB models, migrated/retained with `userId` | Add compound indexes for common owner queries and idempotency keys. |
| Automation run/task | MongoDB `AutomationRun` plus durable queue | Fields include `userId`, task type, status, attempts, lease, timestamps, and idempotency key. |
| Portal sessions | Existing JWT/session system | Require a stable hosted `JWT_SECRET`; do not use process-random secrets in serverless deployments. |
| Platform/Gmail credentials | Secret manager or encrypted credential store | Encrypt with a KMS-managed key; decrypt only inside the worker for the owning user. Never put secrets in job payloads/logs. |
| Contact book and cold email | MongoDB collection keyed by `userId` | Unique compound key `{ userId, emailNormalized }`; campaigns reference owned contact IDs. |
| Reports and evidence | MongoDB metadata + private object storage | Every read/download checks `userId`; use short-lived signed URLs after authorization. |

Do not copy `portalUserId` into one global local JSON file and treat that as multi-tenancy. A single owner marker is an intentional one-account lock, not a scalable ownership model.

## Authentication and request isolation

1. Keep the existing portal login and JWT flow as the entry point.
2. On every authenticated API route, derive `userId` from the verified token (`req.user._id`). Ignore or reject client-supplied `userId` values.
3. Scope reads, updates, deletes, exports, and status lookups by both record ID and authenticated `userId`, for example `findOne({ _id: id, userId: req.user._id })`.
4. Queue messages include `userId` and a record ID, but workers re-load the record with an owner-scoped query before execution.
5. Use short-lived, one-purpose worker credentials or internal service authentication. Never send the user's portal JWT, password, Gmail app password, or platform cookies in a queue message.
6. Protect uploaded files, reports, screenshots, and cold-email contacts with the same ownership checks as API records.
7. Rate-limit login per account and IP with a shared store (Redis or gateway), not an in-memory map in each serverless instance.

## Worker isolation and concurrency

- A task is claimed atomically with a lease, owner ID, and idempotency key. A worker crash allows lease expiry and safe recovery.
- Never retry an application submission when its outcome is uncertain. Require reconciliation before another submit attempt, matching the existing worker safety behavior.
- Use a separate browser context and temporary download directory per task/user. Do not share cookies, local storage, profile directories, or browser pages between users.
- Enforce one active automation run per user initially. Different users may run concurrently, subject to a global worker capacity limit.
- Limit workers globally and per user; bound browser memory/CPU, timeouts, queue depth, attachment size, and retries.
- Store no process-local scheduler as the source of truth. Use a durable scheduler/queue and distributed locks so multiple worker replicas cannot enqueue duplicate daily runs.
- Ensure temporary resume and evidence files are deleted after upload or retention expiry. Define a retention policy before launch.

## Profile synchronization policy

Choose one source of truth for each field before implementing bidirectional sync.

- Portal `User` is authoritative for account email and account ID.
- The user's resume/profile record is authoritative for imported name, skills, experience, roles, and resume text.
- Automation-only preferences (cities, salary, notice period, authorized submission choices, and platform connections) remain in the candidate profile unless and until the main portal has corresponding fields.
- Merge only fields that are present and validated. An absent resume value must not erase an existing user-entered automation value.
- Keep an audit timestamp/source for imported fields so users can see when profile data was synchronized.
- Never infer consent or enable automatic submission from login or resume import.

## Migration plan

### Phase 1: ownership audit and schema preparation

- Audit every route and report/export for owner-scoped queries.
- Add/confirm `userId` fields and compound indexes for profiles, contacts, runs, and any state currently held only in JSON.
- Add migration tooling that maps existing records to the currently linked portal account only after verifying the current `portal-owner` and profile binding.
- Keep the local worker behavior unchanged during this phase.

**Progress:** Existing portal jobs, resumes, reports, applications, and queue runs have `userId` ownership. A durable `AutomationRun` Mongo model and an atomic per-user active-run pointer have been added. The run-history/status endpoints always scope queries to the authenticated user. Automation HTTP requests now carry an `AsyncLocalStorage` account scope through JSON reads/writes, report saves, and async work; browser persistent contexts and local cold-email campaign state are keyed by account directory. Profile, contact, credential, job, and account-state migration paths exist, with the local migration CLI dry-run by default and insert-only for existing Mongo data. Local fixture tests now cover migration owner binding, contact deduplication, state/job splitting, supported private-file selection, and worker-lock refusal; applying the migration against a test MongoDB remains unverified. Existing local data remains in place for its bound account. A source-level route audit confirmed that private portal routes are behind `authenticate`, portal job/application/report/resume/run queries include the authenticated owner, and automation reports/evidence are behind the portal session check and use owner-filtered shared-file lookups. Dynamic cross-account penetration tests and shared-host behavior validation remain outstanding.

### Phase 2: profile, contact, and credential persistence

- Move candidate profile and company contacts from the global JSON store to user-owned MongoDB collections.
- Move resume/evidence files to private object storage and retain metadata in MongoDB.
- Encrypt Gmail and platform credentials using a managed key; implement per-user credential read/write operations.
- Keep a temporary, explicit export/backup path for a user's existing `.automation` data before migration.

**Progress:** Mongo schemas exist for one `AutomationProfile` and one encrypted `AutomationCredential` per user, plus contacts with a unique `{ userId, emailNormalized }` index. With `MONGODB_URI`, authenticated automation sign-in hydrates profile, contact, and credential data by user ID; reviewed profile saves and contact changes persist in Mongo. Gmail credentials are encrypted with AES-256-GCM in Mongo and in the local runtime cache when `AUTOMATION_CREDENTIAL_KEY` is configured. The durable queue refuses to start without this key. Older plaintext local Gmail files are migrated to encrypted local form when the key is present, and copied to the account's Mongo credential record on sign-in. Resumes, PNG application screenshots, generated JSON/CSV/HTML reports, and job descriptions have account-owned GridFS copies; resume files are materialized into the scoped worker directory for Playwright, and report/evidence downloads use owner-filtered GridFS reads with local fallback. `AutomationJob` stores one user-owned job per document, while `AutomationAccountState` stores settings, answers, exclusions, run/event history, and a revision number. In queued mode, browser workers hydrate the account snapshot from Mongo before execution, persist settings/jobs after execution, and persist individual job checkpoints before application work; authenticated state mutations load the latest revision and commit with compare-and-set. Snapshot commits use Mongo transactions, so the deployment must be a replica set or MongoDB Atlas. Scoped JSON remains the working cache. `npm run automation:migrate-local` copies a verified profile, contacts, state, jobs, resume, PNG evidence, report exports, and job descriptions to Mongo/GridFS; it is dry-run by default and uses insert-only upserts so existing Mongo records are preserved. Browser sessions are not copied. Platform login cookies remain in the browser profile and are not moved to shared storage. Runtime cutover still needs concurrency/failure validation and is not a claim of horizontal browser readiness: browser sessions and execution remain host-local and tied to persistent worker storage. The Render hosted-worker scaffold still needs staged validation and does not provide horizontal browser execution.

**Ownership fix:** Preferred and blocked company lists now live on each Mongo `User` and are passed explicitly into the matcher for portal runs, scheduled runs, and rescoring. The ignored legacy `config.json` is imported only when its local `portal-owner.json` matches the signed-in account; other users receive their own independent lists.

**Cold-email campaign progress:** Campaign records now have an owner-scoped Mongo model with a unique per-user campaign ID and a partial unique index allowing at most one `sending` campaign per account. A random lease token fences each sender; it renews and verifies ownership before each recipient, and recipient progress and completion updates require that same token plus an unexpired lease. A stale sender stops before attempting another recipient when ownership is lost. Campaign status requests query by both authenticated `userId` and campaign ID. Status lookup and a new campaign request mark expired campaigns `interrupted` and advise reviewing uncertain recipient outcomes before retrying. Sending itself is not resumed after a crash; an SMTP action already in flight when a lease expires can still have an uncertain outcome. Local mode keeps its existing in-memory campaign behavior. This lease-based recovery still needs multi-process failure validation before hosted campaign sending is scaled.

**Contact mutation consistency:** Import, archive/update, and delete operations serialize per account in-process and use a renewable per-user Mongo lease across processes. The final contact upsert/delete now runs in a Mongo transaction that first conditionally increments a per-user fence only while the exact lease token is still current and unexpired; an expired or replaced updater cannot commit stale contact data. Initial local contact seeding remains insert-only. Lease failover and high-contention behavior still need validation against a replica-set MongoDB deployment.

**Authentication throttling:** Signup/login no longer use a process-local map. Atomic Mongo fixed-window counters apply a 10-attempt/15-minute limit per HMAC-protected client IP and, for login, per HMAC-protected email. Successful logins clear the email bucket so ordinary sign-ins do not accumulate toward a lockout; Mongo TTL expiry removes old buckets. Requests fail closed with 503 when the shared limiter cannot reach Mongo. Portal Express trusts one proxy hop on Vercel so the limiter receives Vercel's forwarded client IP; other proxied deployments must set `TRUST_PROXY_HOPS` to their actual trusted hop count and prevent direct origin access.

**Hosted JWT consistency:** Hosted processes now fail startup if `JWT_SECRET` is missing or shorter than 32 characters. This removes the prior process-random Vercel fallback that invalidated tokens unpredictably across function instances. Configure the same strong key on the portal and the paired automation service.

**Concurrent signup:** First-admin selection no longer depends on a racy `countDocuments()` call. Signup atomically claims a singleton Mongo bootstrap record; concurrent users can create accounts, but only the recorded first account is promoted. Duplicate-email races return the same client error as an already-registered address.

### Phase 2.5: live automation state repository cutover

The queue-mode runtime now loads and commits Mongo state at browser-run boundaries and persists mutations from reviewed API routes. The synchronous `src/automation/store.js` remains the worker's per-account working cache, and browser code still uses its synchronous read/write API while a run executes. MongoDB is the durable source between runs, but snapshot writes need continued concurrency, restart-recovery, and large-account validation before scaling.

Required cutover sequence:

1. Continue converting call sites toward an async `AutomationStateRepository` API with explicit `userId` on each operation. Keep user identity from the authenticated request or claimed run, never from a body field. Avoid mutable module-global cached documents shared across accounts.
2. Separate job document operations from account settings/history. Use `AutomationJob` for per-job updates and the revisioned account-state record for settings, answers, exclusions and bounded history. Extend compare-and-set conflict handling and ensure direct writes obey the same per-user serialization rule. Preserve uncertain-submission recovery semantics.
3. Convert remaining automation call sites to await repository reads/writes, including browser flows, scheduled work, reports, inbox processing, and routes. Description reads are owner-filtered from GridFS; keep them lazy and materialize locally only where Playwright requires a path.
4. Add a dry-run/shadow comparison mode that reads local and Mongo state for the same owner and reports mismatches without changing behavior. Import and reconcile local data before enabling Mongo as the authoritative source.
5. Cut over one synthetic account first, verify restart recovery and account isolation, then enable by cohort behind a feature flag. Keep an export/rollback snapshot and a clear single-writer rule during each account's transition; do not dual-write independently to JSON and Mongo and assume they remain consistent.
6. Retire per-host job/state JSON as an authority only after parity, persistence, failure recovery, and cross-account checks pass. Platform cookies/browser profiles require a separate remote-browser and session-isolation design; moving job records does not move those sessions.

**Exit gate:** MongoDB is demonstrably the authoritative live source for profile preferences, jobs, answers, and application outcomes on restart and across worker hosts; all reads and writes are owner-scoped; concurrent updates have defined conflict handling; and a cross-account test proves no record can be read or changed by a different user. This gate remains open until the queue-mode snapshot/checkpoint path passes concurrency, restart, and cross-account validation.

### Phase 3: run queue and worker service

- Add authenticated `POST /api/automation/runs` to validate user state and enqueue a run.
- Add `GET /api/automation/runs/:id` scoped by user ID for progress/results.
- Add durable queue processing, per-user run locks, global concurrency limits, retries, cancellation, and crash recovery.
- Refactor automation modules to receive a user-scoped context (profile, settings, state, credentials, storage) as arguments instead of importing a process-global `store` singleton.
- Keep the browser process/context isolated for each active task.

**Progress:** Portal `POST /api/run` and browser automation `POST /api/run` use the Mongo queue when `AUTOMATION_QUEUE_ENABLED=true`. Mongo-backed leased worker slots now cap active queue runs across consumer processes using `AUTOMATION_GLOBAL_MAX_RUNS` (default 1); every replica must use the same setting. Browser run modes, including one-time verification, execute in the automation server process so they share its account-specific persistent browser profile. Each browser run is pinned to the stable `AUTOMATION_INSTANCE_ID` (defaults to hostname plus a hash of `AUTOMATION_DATA_DIR`), and queue claims require an exact ID match; an unpinned legacy browser run is marked `interrupted` for review rather than claimed by an arbitrary host. A different host therefore cannot run a user's task against the wrong local Playwright profile. Verification codes are held only in process memory and never persisted in the queue; a restart requires the candidate to submit a fresh code. The worker claims tasks atomically, renews run and global-slot leases in one Mongo transaction, and marks lease loss so browser automation checks ownership again immediately before submission. State snapshots and per-job checkpoints carry a run fence that verifies the active run, worker, slot lease, and account lock in the same transaction as the Mongo write; stale workers cannot overwrite crash-recovery state. Recovery repairs orphaned user locks and marks expired runs `interrupted` instead of replaying them. Interactive sign-in/manual-browser actions reserve the same account lock document as queued runs; queue enqueueing and browser reservations mutually exclude each other, and abandoned interactive leases expire after `AUTOMATION_INTERACTIVE_LEASE_MS` (30 minutes by default). `npm run start:all` starts the automation service, which embeds a single queue consumer for both run types. `npm run automation:worker` is a standalone portal job-hunt consumer only. Browser runs can use the single-instance Render service scaffold with an authenticated remote browser viewer and persistent `AUTOMATION_DATA_DIR`; instance affinity prevents wrong-host claims but does not provide horizontal browser execution. `AUTOMATION_RUN_LEASE_MS` is constrained to 15 seconds–15 minutes. Non-queue local runs have a process-wide concurrency cap (`AUTOMATION_MAX_PARALLEL_RUNS`, default 1).

Queued portal job hunts recheck their lease after external scraping and enrichment, before each discovered-job and score write, before report creation, and before sending notifications. This stops a worker that lost ownership from continuing with subsequent state changes or notification actions; already completed writes and external actions remain subject to their own idempotency/recovery behavior.

Queued daily job hunts use a per-user Asia/Kolkata date idempotency key with a unique Mongo index. Duplicate scheduler invocations return the existing run, including when it has already completed, instead of enqueuing another hunt that day. Application reminders and weekly digests claim a unique per-user delivery key before sending; the claim records expire after 90 days. This is at-most-once behavior: a process crash after claiming but before sending can suppress that scheduled message, while an already in-flight Telegram delivery can still have an uncertain outcome.

Browser-capable queue workers heartbeat their stable instance ID every 30 seconds. A browser run pinned to an instance that has not checked in for three run-lease periods is marked `interrupted`, its in-memory verification code is discarded, and the account lock is released for a reviewed retry from an available signed-in instance. The grace period prevents transient polling delays from immediately stranding a task; this still depends on every browser host using a unique, stable `AUTOMATION_INSTANCE_ID`.

### Phase 4: UI and account migration

- Replace the local SSO handoff with the portal's authenticated run/status API for hosted automation.
- Show the active account, queue status, run history, and per-user settings in the portal UI.
- Provide a user-reviewed import flow from `.automation/` for existing local profiles, jobs, contacts, and settings. Do not automatically merge one local user's history into another account.
- Retain `npm run automation` as a local single-user mode if desired, clearly separate from hosted multi-user mode.

### Phase 5: staged load and isolation validation

- Start with read-only/API load, then login and profile reads, then queue operations, and only later controlled browser dry runs.
- Run 1, 10, 25, 50, and 100 virtual users; measure p50/p95/p99 latency, errors, Mongo connection pool saturation, queue wait, worker CPU/memory, and completion time.
- Use synthetic accounts and fake/test applications. Do not use production resumes, real platform accounts, or real email sends in load tests.
- Include cross-account penetration checks: user A must not fetch user B's profile, resume, job, contact, campaign, report, file, run ID, or credentials by changing an ID.

## Acceptance criteria for 100-user readiness

- 100 users can sign in and use dashboard APIs concurrently without sharing data.
- All user-owned collections and files enforce ownership in the backend, including exports and direct-download routes.
- Concurrent profile edits use a MongoDB revision check; stale saves return a conflict so a user can reload instead of silently overwriting a newer profile.
- Each user sees only their own profile, resumes, contacts, jobs, runs, campaigns, reports, and platform connections.
- One user's queued or failed job cannot modify another user's state or block their worker lock.
- A worker restart does not lose queued tasks or duplicate an application submission.
- Worker replicas can scale horizontally without duplicate scheduling or shared browser sessions.
- Per-user and global concurrency limits behave predictably at 100 users; overload returns a clear queued/rate-limited state rather than corrupting state.
- A 100-user synthetic load test meets agreed latency/error/resource targets and passes cross-account isolation checks.

## Current deployment decision

The current Vercel configuration serves the web/API layer and cron endpoint. A Render Blueprint, persistent disk, HTTPS-origin handoff, and authenticated screenshot/input browser viewer are included for a single browser worker instance. This is deployment scaffolding, not evidence of a successful hosted rollout: it still requires environment setup, queue-index preparation, and staged sign-in/run validation. The disk and browser session are host-local, so the worker must remain at one instance. Keep the per-directory owner check and do not treat this as horizontal browser capacity evidence.

## Running the first queue increment

Before changing the database or enabling queue mode, run `node --test test/multiUserIsolation.test.js`. It checks parallel local account scopes, legacy-owner directory compatibility, and rejection of invalid account IDs. For API ownership checks, set `MONGODB_TEST_URI` to a dedicated test database with `test` in its name and run `node --test test/multiUserApiIsolation.test.js`; this creates random synthetic accounts and records, exercises authenticated cross-account reads/writes, then removes those records. The test refuses database names without `test` and is skipped when the variable is unset. These checks still do not verify automation-session sharing or hosted browser access; those remain part of the Phase 5 exit gate.

1. Keep `AUTOMATION_QUEUE_ENABLED=false` for the current behavior. Before enabling multi-user queue mode, run `npm run automation:check-db` against the target database. It lists missing indexes and scans existing collections for duplicate keys on missing unique indexes; this read-only scan can take time on large collections. Review conflicts, then run `npm run automation:prepare-db` during a planned deployment window to create every declared model index. Prepare changes index metadata and fails if unique indexes conflict with existing records. To enable locally afterward, set the queue flag to `true` and run `npm run start:all`; the automation service starts a single queue consumer. In Vercel, set `CRON_SECRET` so the scheduled job-hunt enqueue endpoint is authenticated.
2. Set `AUTOMATION_QUEUE_POLL_MS`, `AUTOMATION_RUN_LEASE_MS`, and `AUTOMATION_GLOBAL_MAX_RUNS` consistently on every consumer. MongoDB records the global slot capacity on first use, and consumers fail fast if their configured value differs, preventing mismatched replicas from silently creating different slot ranges. To change capacity, drain every consumer, update the stored queue capacity and all environment values together, then restart the consumers. The default lease is 90 seconds and the worker renews it while a run is active. Keep the global cap at 1 unless the shared MongoDB and worker hosts have been capacity-tested; browser capacity is also limited by instance affinity and available isolated browser contexts.
3. With the durable queue disabled, portal job-hunt progress is kept per user within one Node process (not shared across replicas), and `JOB_HUNT_MAX_PARALLEL_RUNS` limits direct job hunts in that process (default 4). The direct API returns 429 at capacity. Use queue mode for durable status and coordination across API/worker processes; the process-local direct-run cap is not a distributed concurrency control.
4. `npm run automation:worker` runs a standalone long-lived portal job-hunt consumer. For browser automation runs, keep the automation HTTP server and its embedded consumer together so interactive sessions and queued runs use the same browser context. In local queued mode, the portal and automation service share the same `MONGODB_URI` and `AUTOMATION_DATA_DIR`; the hosted Render service uses the same MongoDB database and its own persistent disk. Keep `AUTOMATION_INSTANCE_ID` stable across restarts of one browser host, and set different IDs for different hosts; browser tasks are pinned to the ID that accepted them.
5. All Mongo connection entry points, including the portal, Vercel cron, automation queue/worker, portal runner, diagnostic endpoint, and migration CLI, use `src/mongoOptions.js`. The default `MONGODB_MAX_POOL_SIZE=10` applies to each Node.js process (minimum idle pool is zero, idle sockets close after 30 seconds, and a socket wait is capped at 10 seconds). Capacity multiplies: for example, 4 portal instances plus 2 worker processes can open up to 60 application sockets at this setting. Set the value based on MongoDB's connection limit and the maximum number of live instances, leaving room for monitoring, migrations, and other services. This bounds connections; it does not demonstrate that 100 users or browser runs meet latency or throughput targets.
6. Load-test the intended deployment topology: exercise dashboard API traffic separately from queued browser runs, observe Mongo pool wait/checkout, database CPU and connections, queue depth, worker memory/CPU, and request latency. Tune the pool and concurrency limits from those measurements, then repeat at 1, 10, 25, 50, and 100 concurrent users.
7. Local portal accounts have isolated profile JSON, platform cookies, Gmail settings, browser profiles, job state, contacts, and reports under separate directories keyed by a one-way hash of the portal user ID. The legacy owner retains the original data directory. With queue mode enabled, the worker hydrates and commits job/account state in Mongo; the scoped JSON remains its working cache. In local mode, JSON remains authoritative. The migration utility copies verified profile/contact/state/job records and supported private files to MongoDB. Local files are not shared across multiple machines or Vercel instances; the hosted browser worker uses its own persistent disk and remains pinned to one instance.
8. Do not automatically retry an `interrupted` run until side effects have been checked. Do not configure automatic run replay: job discovery is mostly idempotent, but reports and notifications may repeat.
9. With the queue disabled, the portal's existing cron calls its runner directly. For multi-instance deployments, disable that scheduler path or replace it with a distributed/durable scheduler before running multiple API replicas; otherwise daily runs can duplicate.

## Running the read-only API load test

Use an isolated staging/local API and a dedicated MongoDB test database. Never use production accounts, resumes, platform sessions, or a production database. The seed and cleanup commands require `MONGODB_TEST_URI` and reject database names that do not contain `test`; they do not use `MONGODB_URI`.

1. Set `MONGODB_TEST_URI` to the isolated database and `JWT_SECRET` to the same 32+ character signing secret configured on the API. Run `npm run automation:load-seed`. It creates 100 synthetic users by default, each with a synthetic resume, 20 jobs, five applications, and two completed run records, then writes their bearer tokens to a local manifest under the gitignored `.automation/load-tests/` directory. Set `LOAD_TEST_USERS=186` to run both the read-only and default queue stages with distinct users; up to 500 users are supported. If seeding errors or receives Ctrl+C, it removes the synthetic account records it created.
2. Start the API against that same test database and secret. For a local Windows PowerShell run, set `$env:MONGODB_URI=$env:MONGODB_TEST_URI`, `$env:JWT_SECRET` to the matching secret, and `$env:VERCEL='1'` before `npm start`; this prevents the local scheduler from starting during the run.
3. In a second shell, set `LOAD_TEST_BASE_URL` to the isolated API origin and `LOAD_TEST_TOKENS_FILE` to the path printed by the seed command. Run `npm run automation:load-api`. It makes only GET requests to resume, jobs, applications, run history, and analytics. The default stages are 1, 10, 25, 50, and 100 concurrent synthetic users, with three request cycles per account at each stage. Each stage prints request rate, p50/p95/p99 latency, and errors; a non-2xx response fails the command. Use `LOAD_TEST_STAGES`, `LOAD_TEST_ITERATIONS`, and `LOAD_TEST_TIMEOUT_MS` to tune a run. Remote targets require `LOAD_TEST_ALLOW_REMOTE=true` and must be an isolated staging deployment.
4. To exercise durable enqueueing, restart the isolated API with `AUTOMATION_QUEUE_ENABLED=true`, using the same test database and secret. Make sure the test database indexes are prepared, and do not start `npm run start:all` or any queue worker. Run `npm run automation:load-queue` with the same base URL and token manifest. It sends one `POST /api/run` per synthetic user in distinct 1/10/25/50/100-user batches and measures enqueue latency/acceptance; the resulting runs stay queued and are removed by cleanup. Never run browser workers during this enqueue-only test because they can execute real job-hunt side effects.
5. Run `npm run automation:load-clean` with the same `MONGODB_TEST_URI` and `LOAD_TEST_TOKENS_FILE`. It verifies generated IDs/emails, removes only those users and their owned records/files, and deletes the local token manifest. Run cleanup even if the load test fails or is interrupted.

These harnesses validate authenticated read-only portal API load and durable queue enqueueing against a test database. They do not exercise worker execution, scheduler behavior, cold-email sends, or hosted automation sessions; those require separate staged tests and operational metrics before claiming 100-user readiness.

This increment provides account isolation and durable queuing for one automation service instance, not 100-user load-test evidence. The consumer processes one task at a time, and sessions/data are process and disk local. The hosted browser scaffold still needs end-to-end deployment validation, queue/concurrency checks, remote-session security review, and staged load testing before any multi-user or horizontal-scaling claim.

## Validation record

Last local validation: `npm test` completed with 62 passing tests, 1 skipped test, and no failures. The skipped test is the authenticated cross-account API integration test; it requires `MONGODB_TEST_URI`. The test database guard, load harness mocks, local account isolation (including linked account, report, and evidence directory rejection), migration fixtures, and symlinked private-directory rejection ran as part of the passing suite. `node --check` passed for the migration utility, account store, and file helpers, and `git diff --check` passed.

Database-backed validation is still open. At the time of this check, `MONGODB_TEST_URI`, `mongod`, Docker, and `mongodb-memory-server` were unavailable. The configured `MONGODB_URI` did not include a database name in its URI path, so it was not used for test data, index preparation, migration, or load testing. Next evidence needed: a dedicated replica-set test database, successful index preparation and migration, cross-account API integration, queue lease/restart/fencing tests, then staged 1/10/25/50/100-user API and enqueue runs. Worker/browser execution and hosted session isolation need separate staging validation before any readiness claim.
