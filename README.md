# deploy-orchestrator

A small deploy platform: projects, services and environments, a GraphQL API to deploy, cancel and roll back, Temporal workflows that drive each deployment through build, push, provision, health check and traffic switch, build and deploy logs in ClickHouse, and a dashboard that shows all of it live.

![Deploying four services with live logs, a build that fails on a registry timeout and is retried, and a rollback](docs/preview.gif)

The services a real platform would call (a builder, a container runner, an edge router) are in-process fakes in `server/src/fakes/`. They take realistic time, print the kind of output a Docker build prints, and can be told to fail: once and recover, permanently, or hang until cancelled. Everything around them is real: Postgres, Temporal, ClickHouse, the GraphQL API and the browser.

## How it works

### One status machine, enforced twice

A deployment moves `QUEUED → BUILDING → DEPLOYING → ACTIVE`, ends as `FAILED` or `CANCELLED` if it never gets there, and becomes `REMOVED` when something newer takes its place. The legal moves are defined once, in `server/src/domain/deploymentStatus.ts`. Rollbacks may go straight from `QUEUED` to `DEPLOYING` because their image already exists.

The database enforces the same rules, so a bug or a hand-written `UPDATE` cannot get around them (`server/src/db/migrations/001_init.sql`):

- A `deployment_status_transitions` table holds the legal pairs, and a trigger rejects any status change not in it. A test compares the table against the TypeScript map, so the two cannot drift apart.
- A partial unique index allows at most one `ACTIVE` deployment per service and environment. Promoting a new deployment retires the old one in the same transaction.
- Composite foreign keys make it impossible for a deployment to point at a service from one project and an environment from another.
- Check constraints tie fields to states: a failure reason exists exactly when the status is `FAILED`, and nothing becomes `ACTIVE` without an image.
- Every status change is written to `deployment_events` and published with `pg_notify` by the same trigger. Notifications are delivered on commit, so subscribers never hear about a change that was rolled back.

Status writes are compare-and-set, and repeating one is a no-op. Activities can safely be retried after a commit whose response was lost.

### Orchestration

**One lane per service and environment** (`server/src/workflows/lane.ts`). The API never starts a deploy workflow directly. It calls `signalWithStart` on a lane workflow whose id is derived from the service and environment, so Temporal guarantees there is only one lane per service and environment. The lane runs one deployment at a time, and the newest request wins. Queued requests that a newer one overtakes are cancelled. A running deployment is told to cancel, cleans up, and the newer one starts. When the lane has been idle for ten minutes it ends, and continue-as-new keeps its history bounded.

**The deploy itself** (`server/src/workflows/pipeline.ts`) is shared by `deployWorkflow` and `rollbackWorkflow`. A rollback skips the build but still provisions, health-checks and switches traffic, so a broken old image cannot replace a healthy current one. Retry policies follow the kind of work each activity does:

| Activities | Policy | Why |
| --- | --- | --- |
| `buildImage`, `pushImage` | 3 attempts, 1 s backoff doubling, 20 s heartbeat timeout | Flaky registries are worth retrying. A compile error is thrown as non-retryable and fails at once. |
| `provisionInstance`, `healthCheck` | 3 attempts, 10 s heartbeat timeout | Health check failures are non-retryable: the image is the problem, not the attempt. |
| `recordStatus`, `switchTraffic`, `findActive`, `releaseInstance` | Unlimited attempts, backoff capped at 10 s | Idempotent bookkeeping that must eventually succeed. |

All long activities heartbeat every 250 ms through one wrapper (`server/src/workflows/activities.ts`), because Temporal can only deliver a cancellation to an activity in a heartbeat response.

**Cancellation and compensation.** A `cancel` signal cancels a `CancellationScope` around everything up to the health check. The catch block runs in a non-cancellable scope: it releases whatever was provisioned and records `CANCELLED`. Two details matter here:

- The fake runner registers an instance before `provisionInstance` returns, just as a real one would. If provisioning is cancelled halfway, the workflow never learns the instance id. Instances are therefore keyed by deployment id, and compensation releases by that key.
- Provisioning uses `WAIT_CANCELLATION_COMPLETED`. Without it, the workflow would run compensation while the cancelled activity was still running, and a late provision could recreate the instance after the release.

Once traffic has moved, the deployment can no longer be cancelled. Cancel signals are ignored from that point, and the remaining steps run in a non-cancellable scope.

### API

GraphQL Yoga with a code-first schema in Pothos (`server/src/api/schema/`), so resolvers and the schema are type-checked against the domain types. The printed schema is committed as `server/schema.graphql`. A server test fails if it is stale, and a dashboard test validates every query, mutation and subscription the dashboard sends against it.

- **Queries** use per-request DataLoaders. The canvas query for a project costs five SQL queries, whether the project has one service or thirteen (there is a test for that).
- **Mutations** `deployService`, `cancelDeployment` and `rollback(to:)` write the row first, then hand the work to Temporal. If Temporal cannot be reached, the new deployment is marked `FAILED` with a reason instead of sitting in `QUEUED` forever. Expected failures come back with their message and a code such as `NOT_CANCELLABLE`. Anything else is masked.
- **The client asks rather than re-derives.** `canCancel` and `canRollback` are fields, so the dashboard never re-implements the state machine.
- **Subscriptions** are served over SSE. `deploymentUpdated` listens to the Postgres notifications and reads the row fresh for each event. A subscription keeps one context for its whole life, so its DataLoaders are cleared before every event. Without that, the second event would serve the first event's status history.

The worker and the API can run in one process (the default, which the demo needs for fault injection) or separately with `ROLE=api` and `ROLE=worker`. Their only shared channels are Postgres and Temporal.

### Logs

Lines go into a ClickHouse `MergeTree` ordered by `(deployment_id, seq)`. Every read is a range scan on that key, however much other deployments have written. `seq` is a per-process monotonic 64-bit sequence: microseconds shifted left by 10 bits, plus a counter. It never goes backwards when the wall clock does. Within one deployment it is ordered because that deployment's activities run one after another.

- **Batching** (`server/src/logs/bufferedLogSink.ts`). Activities write to a buffer that flushes every 50 ms or 500 lines, with one insert in flight at a time. Lines written during an insert go out together in the next one. Each activity flushes before it returns, so a deployment's logs are complete before its status moves on.
- **Announced only once readable.** After an insert succeeds, the sink sends a small `pg_notify` with the deployment id and the highest `seq` written. The notification is a pointer, not the data.
- **Gap-free tail** (`server/src/logs/tailLogs.ts`). A log subscription subscribes to those notifications first, then reads history in keyset pages of 1,000, then reads again after each notification. Every line is announced only after it is stored, so a line written between the subscribe and the first read cannot be missed. Each read starts from the last seen `seq`, so nothing is sent twice.

The same keyset pagination is exposed as `deployment.logs(first, after)`.

### Dashboard

React 19 with urql and Graphcache (`web/src/graphql/cache.ts`).

- **One live stream feeds every view.** A single `deploymentUpdated` subscription per project environment writes into the normalized cache, and every view updates from it: canvas cards, the deployment list and the status timeline.
- **One placement rule.** `upsertDeployment` decides where a deployment belongs: it becomes its service's latest deployment if it is newer, and it is added to the top of the service's deployment list. Mutation results, optimistic results and subscription events all go through it, so they cannot disagree.
- **Optimistic UI.** Deploy adds a `Queued` row immediately, rollback adds a rollback row, and cancel shows `Cancelling` and hides the button. If the server refuses, Graphcache drops the optimistic layer, and the hook shows the server's message.
- **Logs bypass the cache.** They are append-only and can run to tens of thousands of lines, so they use their own client and are appended to a ref. The component re-renders at most once per animation frame. The log view is virtualized with fixed-height rows. It follows the tail until you scroll up and then shows "Jump to latest". If the stream drops, reconnecting resumes from the last cursor.

## Measured

All numbers come from a 2-vCPU, 8 GB VM running Postgres 16, Temporal CLI 1.9 (dev server), ClickHouse 26.10 and Node 22. The scripts are in `server/bench/`.

**End to end** (`npm run bench:deploys`). These runs use real Temporal, Postgres and ClickHouse and a GraphQL subscriber over SSE. The fake services are set to zero latency, so what remains is the cost of orchestration.

| | p50 | p95 |
| --- | --- | --- |
| `deployService` to `ACTIVE` seen by the subscriber (50 sequential deploys) | 611 ms | 711 ms |
| Status change committed to subscriber receives it | 3 ms | 11 ms |
| Log line written to log subscriber receives it (2,000 lines) | 123 ms | 161 ms |

- Deploying 25 services at once took 2.9 s until all were `ACTIVE`.
- Most of the 611 ms is ClickHouse. An insert takes about 55 ms on this machine, and each of the eight activities that write logs flushes before reporting back. That is the cost of logs never lagging behind status, and it shows up only because the fakes take no time. With the demo's fake latencies, a deploy takes about 6 s.
- The benchmark also found two bugs. A deploy arriving in the same activation as the previous one's completion made the lane signal a closed workflow and wedged it; this is fixed in `lane.ts`. The first version of the log sink chained one insert per 50 ms tick, which built a queue and put line latency at about 700 ms. Grouping the lines that pile up during an insert brought it down to the 123 ms above.

**Log storage** (`npm run bench:logs`, 1,000,000 lines for one deployment plus 500,000 lines from 20 others):

- Ingest: 72,000 lines/s in batches of 10,000.
- Reading a 1,000-line page at the end of the log: 9.8 ms p50 with the keyset cursor, against 20.5 ms with `OFFSET`. The bigger difference is correctness: an `OFFSET` page shifts while a deployment is still writing, and a cursor page does not.
- Reading all 1,000,000 lines in pages of 10,000: 44 ms per page p50.

**Dashboard.** A 50,000-line log keeps about 30 rows in the DOM (component test).

## Tech stack

- **Server:** Node 22, TypeScript (`strict`, `noUncheckedIndexedAccess`), Temporal TypeScript SDK 1.24, GraphQL Yoga 5 with Pothos, `pg`, DataLoader, ClickHouse JS client.
- **Dashboard:** React 19, Vite, urql with Graphcache.
- **Tests:** Vitest, `@temporalio/testing` time-skipping environment, Testing Library, Playwright for the preview capture.

## Running it

You need Node 22, Postgres, ClickHouse and the Temporal CLI.

```bash
npm ci
temporal server start-dev --headless &                 # localhost:7233
clickhouse server &                                    # HTTP on :8123
createdb deployorch_dev && createdb deployorch_test    # migrations and seed data run on start
npm run dev                                            # API on :4000, dashboard on http://localhost:5173
```

Configuration is read from environment variables (`server/src/config.ts`):

| Variable | Default | |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/deployorch_dev` | Tests use `TEST_DATABASE_URL` (database `deployorch_test`) |
| `CLICKHOUSE_URL` | `http://localhost:8123` | |
| `TEMPORAL_ADDRESS` | `localhost:7233` | |
| `PORT` | `4000` | API port; the dashboard proxies `/graphql` to `API_URL` |
| `ROLE` | `all` | `api`, `worker` or both in one process |
| `FAKE_LATENCY` | `1` | Multiplier for the fake services' delays; `0` makes them instant |

The "Simulate" menu in the dashboard arms a fault for the next deploy: a flaky registry, a compile error, a registry that stays down, an app that never passes its health check, or a build that hangs until you cancel it.

To re-record the preview against a running stack with a fresh database:

```bash
APP_URL=http://localhost:5173 API_URL=http://localhost:4000 node scripts/capture-preview.mjs
python3 scripts/compose-preview.py
```

## Tests

```bash
npm run typecheck
npm test            # 63 server tests, 20 dashboard tests
```

- **Workflows** (`server/test/workflows.test.ts`) run on Temporal's time-skipping test server, which the SDK downloads on first use. They cover the happy path, a transient build failure that is retried, a retry budget that runs out, a fatal error that is not retried, a failed health check that leaves the old deployment live, cancellation mid-build and mid-provision (including through workflow cancellation), rollback, superseding running and queued deploys, cancelling through the lane, and a rollback queued behind a deploy. The 14 tests run in about 4 s.
- **API and schema tests** run against real Postgres. Each test file creates and drops its own schema in `deployorch_test`, so the files run in parallel. **Log store tests** run against ClickHouse.
- **Dashboard tests** run the real Graphcache configuration against a fake exchange. They check optimistic deploy, cancel and rollback, rollback of each on error, log virtualization and tail-following, and every operation against `server/schema.graphql`.

## Layout

```
server/src/domain/      status machine, entity types, ports
server/src/db/          migrations, repositories, seed data
server/src/workflows/   lane, deploy and rollback workflows, activities, worker
server/src/fakes/       builder, instance runner, router, fault injection
server/src/logs/        ClickHouse store, buffered sink, tail
server/src/events/      LISTEN/NOTIFY event bus
server/src/app/         deployment commands, Temporal scheduler
server/src/api/         Pothos schema, loaders, Yoga server
server/bench/           benchmarks
web/src/graphql/        operations, cache configuration, clients
web/src/components/     canvas, service panel, deployment detail, log view
scripts/                preview capture and GIF composition
```

## License

MIT
