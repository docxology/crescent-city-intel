# HTTP contracts and notification boundaries

`src/api/contracts.ts` parses `openapi.yaml` structurally as the HTTP
method/authentication/input/response authority. Generated
[HTTP documentation](../generated/http.md) derives from that same document;
serialization layout is not a contract. The release gate checks route/method
parity and rejects deliberately malformed workflow/spec sources.

## Middleware and admission

`applyMiddleware(req, socketIp?)` applies API method/authentication, request
logging and sliding-window quotas before a handler. Pass Bun's actual socket
peer from `server.requestIP(req)`; forwarded identities are honored only for
explicit `CRESCENT_TRUSTED_PROXY_IPS` peers. Local peers remain subject to quota.
Public routes and declared methods come from OpenAPI rather than a second
hand-maintained allowlist. API credentials use `X-API-Key`, with configured
comma-separated keys or a generated per-boot key.

Logs retain bounded allowlisted operational metadata, not query/body/history,
credentials or raw client identity. Static key bootstrap additionally requires
a trusted loopback peer and allowed Host with the declared proxy policy; escaped
JSON and a response nonce CSP keep credentials out of untrusted static responses.

`src/api/admission.ts` bounds expensive concurrent operations and rejects an
already aborted request before starting work. Cancellation bounds the HTTP
response while underlying work holds its admission until settlement; model,
vector and analytical callers inherit `Request.signal` and finite byte/work caps.
Malformed/excessive inputs and unsupported methods fail before expensive work.
Checked responses reuse shared `x-artifact-family` validators where a route
returns a persisted family; other responses retain their OpenAPI schema.

Quota/admission state is local to one server process and resets on restart.
Multi-instance production operation needs a separately reviewed deployment
policy; local tests do not establish a distributed quota contract.

## Notification delivery

`src/alerts/notify.ts` sends bounded severity webhooks without failing the alert
run. `src/notifications/push.ts` validates configured destinations and implements
VAPID encrypted Web Push or webhook delivery with finite retry/deadline receipts.
Missing configuration yields `disabled`; rejection/unavailability yields `failed`;
a protocol acknowledgement yields `accepted`. Keys, subscription records and
personal destinations remain private and outside Pages artifacts.

Real local HTTP/encryption fixtures exercise the delivery protocol. They do not
establish an actual user's browser display, remote destination delivery or
permanent subscriptions. Opted-in destination acceptance is the narrow remaining
notification scope in [TODO.md](../../TODO.md).
