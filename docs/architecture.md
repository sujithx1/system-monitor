# Architecture and design decisions

## Data flow

1. **Agent** (production VM) collects a snapshot every `AGENT_INTERVAL_SECONDS` (30 s) and sends a
   heartbeat on an independent timer, so a slow PostgreSQL check never delays liveness.
2. **API** authenticates the agent token, validates the snapshot (Zod, closed metric catalog, size
   limit), rejects stale/future payloads, and stores one `metric_snapshots` row plus one
   `metric_samples` row per metric in a single transaction. Re-sent snapshots are no-ops
   (`UNIQUE(agent_id, snapshot_key)`).
3. **Worker** evaluates every enabled rule every 15 s from persisted samples, applies the incident
   state machine in a transaction, and writes notifications to a durable outbox.
4. **Dispatcher** (same worker process, separate loop) claims due outbox rows with
   `FOR UPDATE SKIP LOCKED`, sends WhatsApp template messages, records each attempt, and retries
   transient failures with exponential backoff and jitter.
5. **Delivery webhooks** from Meta update notification status (`sent → delivered → read`, or `failed`).

## Key decisions

| Decision                                                      | Why                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push-only agent, no listening socket                          | Nothing on production VMs can be reached through the agent; no inbound firewall rules needed.                                                                                                                             |
| Closed metric catalog (`backend/src/shared/metrics.ts`)      | Rules and dashboards rely on known units; arbitrary metric names from an untrusted agent are rejected.                                                                                                                    |
| Unmeasured values are `status: "unavailable", value: null`    | A failed collector is never reported as 0 %; the DB enforces `ok ⇔ value IS NOT NULL`. A failed _check_ (`pg.up`, `http.up`) is a real observation and is reported as 0 with the error.                                   |
| CPU from consecutive `/proc/stat` samples kept between cycles | Utilisation is averaged over the whole 30 s interval and collection never sleeps.                                                                                                                                         |
| Stateless sustained-window evaluation                         | A level fires only when the uninterrupted run of breaching samples ending at the newest sample spans its duration. Recomputed from data each cycle, so worker restarts lose nothing. Gaps > 2.5 × interval break the run. |
| "No data" never resolves                                      | Stale data leaves incidents unchanged; host outages are covered by the heartbeat rule, which uses server receive time (immune to agent clock skew).                                                                       |
| One open incident per rule/host/resource enforced by the DB   | Partial unique index `incidents_one_active_uq`. Evaluation locks the open incident (`SELECT … FOR UPDATE`) and inserts with `ON CONFLICT DO NOTHING`, so concurrent workers cannot duplicate incidents.                   |
| Notifications as an outbox with unique `dedupe_key`           | Keys like `incident:<id>:reminder:3:<phone>` are written in the same transaction as the state change, so restarts and races cannot enqueue the same message twice.                                                        |
| Leased claiming                                               | `status = 'sending'` + `locked_until`; a crashed worker's rows become claimable after the lease (2 min). Completion updates are guarded by `locked_by`.                                                                   |
| "Accepted" ≠ "delivered"                                      | A 200 from the Cloud API stores `accepted` + message id; delivery state only comes from the signed webhook.                                                                                                               |
| Rules in the database, defaults seeded                        | Thresholds, durations, cooldowns, reminders and escalation are editable at runtime and audited.                                                                                                                           |
| Separate worker process                                       | API restarts or overload don't stop alerting; the worker has its own health check and DB heartbeat.                                                                                                                       |

## Incident state machine

```
(no incident) ──breach──▶ pending ──held for duration──▶ firing ──acknowledge──▶ acknowledged
      ▲                      │                              │  ▲                      │
      └── cleared: row deleted (never paged) ◀─────────────┘  └──── severity increase ┘
                                   firing / acknowledged ──cleared──▶ resolved (recovery message)
```

- Severity increase (warning → critical) always notifies and re-opens an acknowledged incident.
- Reminders: critical + firing (not acknowledged) every `reminderIntervalSeconds`.
- Escalation: once, to `escalationRecipients`, if still unacknowledged after `escalationAfterSeconds`.
- Cooldown: a new incident for the same rule/host/resource within `cooldownSeconds` of the last
  page is created but not paged (`metadata.cooldownSuppressed`), preventing flapping storms.
- Recovery messages are only sent for incidents that actually paged someone.
- Disabling a rule or host closes its open incidents without paging.

## Failure modes

| Failure                                   | Behaviour                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production VM offline                     | Heartbeat stops → warning at 90 s, critical at 180 s, reminders every 15 min.                                                                                                                                                         |
| Production PostgreSQL down / auth broken  | `pg.up = 0` with the error → critical after 2 consecutive checks.                                                                                                                                                                     |
| Application API not responding            | `http.up = 0` (timeout/status) → critical after 3 consecutive checks.                                                                                                                                                                 |
| Disk fills up                             | Per-mount usage and inode rules; PostgreSQL data/WAL mounts monitored separately from DB size and WAL size.                                                                                                                           |
| Agent collector fails                     | That metric is `unavailable` with the error; other metrics continue.                                                                                                                                                                  |
| Agent cannot reach monitoring server      | Snapshots buffered (bounded, `AGENT_MAX_BUFFER`) and replayed oldest-first; the server rejects ones older than 15 min.                                                                                                                |
| Malformed / stale / duplicated agent data | 422 / 422 / idempotent 200; never stored.                                                                                                                                                                                             |
| Monitoring API down                       | Worker keeps evaluating; agents buffer; when it returns, buffered data is ingested. Heartbeat incidents may fire for the outage window (expected – data was not received).                                                            |
| Worker crash                              | Docker restarts it; evaluation is recomputed from data; in-flight notifications are reclaimed after their lease.                                                                                                                      |
| Monitoring DB down                        | API `/ready` returns 503, ingestion fails (agents buffer), worker loops log errors and retry; the dead-man ping stops, so the external service alerts you.                                                                            |
| WhatsApp timeout / 5xx / throttling       | Retried with backoff (5 s → 15 min cap, `WHATSAPP_MAX_ATTEMPTS`); Retry-After honoured. Permanent errors (bad template, undeliverable) fail immediately and are visible in the dashboard.                                             |
| Multiple workers                          | Safe: SKIP LOCKED claiming, row locks, unique indexes and dedupe keys.                                                                                                                                                                |
| Monitoring VM completely down             | Cannot alert about itself. The worker pings `DEADMAN_PING_URL` once a minute; an external service (healthchecks.io, Better Stack, UptimeRobot heartbeat, …) alerts when pings stop. Add an external HTTPS check of `/health` as well. |

## Delivery semantics

Notifications are **at-least-once** with a very narrow duplicate window: if the worker dies after
WhatsApp accepted a message but before the row is marked `accepted`, the message is re-sent after the
lease expires. The Cloud API has no idempotency key, so this cannot be fully eliminated; it is
preferable to losing an alert.

## Scaling notes

- ~40 samples per host per 30 s ≈ 115 k rows/host/day. With the default 30-day retention a few dozen
  hosts fit comfortably on a small VM. For hundreds of hosts, partition `metric_samples` by day
  (drop partitions instead of batched deletes) or move samples to TimescaleDB.
- Rate limits are in-process; run one API instance or move limits to the proxy/Redis.
