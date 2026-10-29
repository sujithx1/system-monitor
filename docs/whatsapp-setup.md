# WhatsApp Business Platform (Cloud API) setup

Alerts are sent as **template messages** through the official Cloud API
(`POST https://graph.facebook.com/<version>/<phone-number-id>/messages`). Business-initiated
messages outside a 24-hour customer service window must use an approved template, so free-form text
is never used.

## 1. Prerequisites

1. A Meta Business portfolio, a WhatsApp Business Account (WABA) and a registered sender phone
   number (Meta for Developers → your app → WhatsApp → API Setup). Copy the **Phone number ID**.
2. A **System User** (Business Settings → Users → System users) with the
   `whatsapp_business_messaging` and `whatsapp_business_management` permissions, assigned to the app
   and WABA. Generate a non-expiring token → `WHATSAPP_ACCESS_TOKEN`. Never use the 24-hour test
   token in production.
3. Recipients must have **opted in** to receive these alerts (an internal on-call list is typical;
   record the consent). While the app is in development mode, recipients must also be added to the
   test number allow-list.
4. Set `WHATSAPP_API_VERSION` to a currently supported Graph API version (check Meta's changelog;
   versions are deprecated roughly two years after release).

## 2. Template specification

Create in WhatsApp Manager → Message templates → Create template.

| Field             | Value                                                                              |
| ----------------- | ---------------------------------------------------------------------------------- |
| Name              | `system_alert` (→ `WHATSAPP_TEMPLATE_NAME`)                                        |
| Category          | **Utility** (operational alerts about a service the recipient uses; not marketing) |
| Language          | English (`en`) (→ `WHATSAPP_TEMPLATE_LANGUAGE`)                                    |
| Header            | none                                                                               |
| Footer (optional) | `System Monitor`                                                                   |
| Buttons           | none (optionally a URL button to the dashboard)                                    |

Body (positional parameters; the body must not start or end with a parameter):

```
System Monitor alert: {{1}}
Host: {{2}}
Service: {{3}}
Incident ID: {{4}}
Detected: {{5}}
Details: {{6}}
Suggested action: {{7}}

Open the monitoring dashboard to acknowledge.
```

| Parameter | Meaning                                                                                                                                       | Sample for review                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `{{1}}`   | Severity / state: `CRITICAL`, `WARNING`, `CRITICAL (reminder, still unresolved)`, `CRITICAL (escalation, unacknowledged)`, `RESOLVED`, `TEST` | `CRITICAL`                                                      |
| `{{2}}`   | Host display name                                                                                                                             | `db-prod-1`                                                     |
| `{{3}}`   | Rule and resource                                                                                                                             | `Disk usage (/var/lib/postgresql)`                              |
| `{{4}}`   | Incident UUID (search it in the dashboard)                                                                                                    | `0b1c2d3e-5f60-4a7b-8c9d-0e1f2a3b4c5d`                          |
| `{{5}}`   | Detection time in `ALERT_TIMEZONE`                                                                                                            | `28 Oct 2026, 17:30:00 GMT+5:30`                                |
| `{{6}}`   | Summary (value, threshold, duration, last error)                                                                                              | `Disk usage on /var/lib/postgresql is 96.4% (critical > 95.0%)` |
| `{{7}}`   | Suggested action from the rule                                                                                                                | `Free space. Do not delete WAL files.`                          |

The same template is used for all message kinds (firing, reminder, escalation, recovery, test) so
only one template needs approval. Parameter values are sanitised before sending: newlines/tabs are
replaced, repeated spaces collapsed, each value capped at 200 characters and never empty – all
WhatsApp template parameter rules.

If you change the parameter order or count, update `templateParameters()` in
`backend/src/worker/notifications/whatsapp.ts`.

## 3. Configure the monitoring server

```dotenv
WHATSAPP_ACCESS_TOKEN=EAAG...          # system user token
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_RECIPIENT=+919876543210,+919812345678
WHATSAPP_API_VERSION=v23.0
WHATSAPP_TEMPLATE_NAME=system_alert
WHATSAPP_TEMPLATE_LANGUAGE=en
```

Restart the worker (`docker compose up -d worker`). Without credentials the worker logs a warning
and notifications remain **queued** (nothing is lost) until credentials are configured.

## 4. Delivery-status webhook

An HTTP 200 from the Cloud API means _accepted_, not delivered. Delivery state arrives via webhook:

1. App dashboard → WhatsApp → Configuration → Webhook:
   - Callback URL: `https://monitor.example.com/api/v1/webhooks/whatsapp`
   - Verify token: value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
2. Subscribe the WABA to the **messages** field.
3. Set `WHATSAPP_APP_SECRET` (App settings → Basic → App secret). Every POST is verified against
   `X-Hub-Signature-256`; unsigned or wrongly signed requests are rejected with 401.

Statuses move forward only (`accepted → sent → delivered → read`); `failed` records Meta's error
code (e.g. `131026` undeliverable, `131047` re-engagement required).

## 5. Test

Dashboard → Admin → **Send test WhatsApp**, or:

```bash
curl -X POST https://monitor.example.com/api/v1/alerts/test -H 'content-type: application/json' \
  -H 'origin: https://monitor.example.com' -b '__Host-im_session=...' -d '{}'
```

Only numbers listed in `WHATSAPP_RECIPIENT` can receive test messages (5 per hour per admin). Watch
the result under Notifications (attempts, HTTP status, provider error code).

## Retry policy and errors

| Situation                                                                                                          | Handling                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Timeout, network error, HTTP 408/429/5xx, codes 1, 2, 4, 17, 80007, 130429, 131000, 131016, 131048, 131056, 133004 | Retry with exponential backoff + jitter (5 s doubling, capped at 15 min; `Retry-After` honoured) up to `WHATSAPP_MAX_ATTEMPTS`. |
| 190 (token expired/invalid)                                                                                        | Retried (so alerts go out once the token is rotated) and logged as an error.                                                    |
| Other 4xx (e.g. 100 invalid parameter, 132000/132001 template problems, 131026 undeliverable)                      | Permanent: marked `failed` immediately with the provider error.                                                                 |

Tokens are only ever sent in the `Authorization` header; they are never logged or stored in
notification records.
