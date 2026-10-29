# Testing

## Automated tests

Each project has its own tests; run them from its folder.

```bash
cd agent && bun test             # collectors, PostgreSQL/HTTP checks, buffering, agent config
cd backend && bun test           # unit tests (no external services)
cd backend && TEST_DATABASE_URL=postgres://monitor_owner:testpass@127.0.0.1:55439/system_monitor_test bun test
```

The frontend has no tests; `cd frontend && bun run check` typechecks and lints it.

Integration tests run only when `TEST_DATABASE_URL` is set, migrate that database automatically
and truncate all tables between tests. The URL's database name must contain `test` (a guard against
pointing them at a real database). WhatsApp is always mocked; no network calls leave the machine.

| Area                                                                                                                                                                                 | Tests                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| CPU/RAM/disk/inode/load maths, `/proc` parsing, unavailable-vs-zero                                                                                                                  | `tests/unit/collectors.test.ts`        |
| PostgreSQL & HTTP checks (auth failure, timeout, missing `pg_monitor`)                                                                                                               | `tests/unit/checks.test.ts`            |
| Agent buffering while the server is down, replay order, permanent rejections                                                                                                         | `tests/unit/agent-sender.test.ts`      |
| Payload, rule and config validation, log redaction                                                                                                                                   | `tests/unit/validation.test.ts`        |
| Thresholds, sustained windows, gaps, stale data, check failures, heartbeat timeouts                                                                                                  | `tests/unit/evaluate.test.ts`          |
| Incident lifecycle, deduplication, cooldown, reminders, escalation, recovery                                                                                                         | `tests/unit/decide.test.ts`            |
| WhatsApp request shape, failures, classification, backoff, webhook status ordering                                                                                                   | `tests/unit/notifications.test.ts`     |
| Rate limiting, cursors, phone masking, host health                                                                                                                                   | `tests/unit/api-lib.test.ts`           |
| AuthN/AuthZ, CSRF origin check, ingestion (idempotency, replay, limits), history pagination, acknowledgement                                                                         | `tests/integration/api.test.ts`        |
| Engine against PostgreSQL: spikes, sustained CPU, reminders, recovery, **concurrent incident creation**, DB uniqueness, heartbeat, PostgreSQL down, stale data, cooldown, escalation | `tests/integration/engine.test.ts`     |
| Outbox: accept, retries/backoff, permanent failure, **concurrent claiming**, lease expiry, cancelled reminders, signed webhooks                                                      | `tests/integration/dispatcher.test.ts` |
| Retention and keyset pagination                                                                                                                                                      | `tests/integration/retention.test.ts`  |

## Simulating failures safely

Never induce failures on production to test alerting. Use a dedicated **test host** registered in
the monitoring system and synthetic data:

```bash
cd backend
docker compose run --rm api bun scripts/register-host.ts --name sim-test-1 --environment test
export MONITOR_URL=https://monitor.example.com AGENT_TOKEN=ima_...   # sim-test-1's token

bun run simulate --scenario high-cpu --minutes 6       # CPU critical after >95% for 3 min
bun run simulate --scenario low-disk --minutes 1       # disk critical immediately (96.4% on /)
bun run simulate --scenario pg-down --minutes 2        # PostgreSQL critical after 2 consecutive failures
bun run simulate --scenario api-down --minutes 2       # API critical after 3 consecutive failures
bun run simulate --scenario pg-connections --minutes 2 # connection utilization critical after 1 min
bun run simulate --scenario missed-heartbeat           # stop sending: warning 90 s, critical 180 s
bun run simulate --scenario normal --minutes 2         # recovery for all of the above
```

Each scenario exercises the full path: ingestion → evaluation → incident → WhatsApp (if configured)
→ recovery. Disable or delete the test host afterwards (`PATCH /api/v1/hosts/:id {"enabled": false}`
closes its incidents without paging).

To exercise the real agent without production impact, run it on a staging VM and generate load
there (`stress-ng --cpu 0 --timeout 300s`, `fallocate -l 5G /tmp/fill`), or stop a staging
PostgreSQL.
