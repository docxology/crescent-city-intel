# Agents Guide — `src/api/`

The GUI server uses the shipped OpenAPI document for exact method, authentication,
request and successful JSON response contracts. Keep the spec and handlers in sync.

| Module | Purpose |
| :--- | :--- |
| `contracts.ts` | Native YAML parsing, exact route lookup, bounded input validation, response validation and route inventory |
| `middleware.ts` | Socket identity, exact proxy trust, API keys, finite sliding-window quotas and content-free request receipts |
| `admission.ts` | Four concurrent expensive operations, total deadline and SSE lifetime ownership |

The server calls `applyMiddleware(req, socketIp)` before routing. A non-null
response ends processing. `handleApiRoute` validates requests and successful
JSON responses; unsupported methods return 405 with Allow. HEAD follows GET
without a response body. Read the document's operation security for public access.
Unknown paths do not inherit a parent's public status.

Authentication accepts only `X-API-Key`. `CRESCENT_CITY_API_KEY` supplies
comma-separated keys; otherwise the process generates a random credential. The
server injects that credential only for an actual loopback socket, a loopback
hostname, no forwarded headers, and a peer outside the configured proxy set.
Configure remote clients explicitly; served HTML never establishes trust.

`CRESCENT_TRUSTED_PROXY_IPS` is an exact comma-separated IP allowlist, empty by
default. Forwarded identity is accepted only from those socket peers. All peers,
including loopback, have bounded hourly quotas: 100 ordinary requests, 20 chat
or summaries, 10 vector operations, and 1000 operational probes. Capacity is
bounded at 10,000 buckets. Expensive operations additionally have four active
slots and a 180-second total deadline; streaming retains a slot until completion
or cancellation. A cancelled dependency keeps ownership until it settles.

Request receipts live below `CC_OUTPUT_DIR/state`, retain at most 1000 records
and seven days, and contain templated routes, status, duration and salted client
IDs. Never persist raw IPs, queries, bodies or credentials. Tests use isolated
roots and real streams: `tests/api-contracts.test.ts`, middleware suites and
`tests/gui-server.test.ts`.
