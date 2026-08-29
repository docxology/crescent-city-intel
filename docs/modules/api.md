# API Middleware Module

## `src/api/middleware.ts` — HTTP Request Middleware

Composable middleware chain applied to every GUI server request before route handlers execute. Returns `null` to pass through, or a `Response` to short-circuit.

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `applyMiddleware` | `(req: Request, socketIp?: string) → Promise<Response \| null>` | Run full middleware chain; `null` means pass through |

### Middleware Chain

Applied in order:

| Middleware | Behavior |
| :--- | :--- |
| **Request logger** | Logs method, URL path, client IP, response time (ms) |
| **Rate limiter** | Sliding-window cap: 100 requests per IP per hour (`RATE_LIMIT_MAX_REQUESTS`), with stricter per-path limits for `/api/chat` (20), `/api/summarize` (20), and `/api/analytics/embeddings` (10). Returns `429 Too Many Requests` on violation. |
| **API key auth** | Validates the `X-API-Key` header against `CRESCENT_CITY_API_KEY`. Returns `401 Unauthorized` on failure. (A prior `?api_key=` query-param form was removed for credential-leak reasons.) |

### Bypass and Public Paths

**Rate-limit bypass**: `GET /api/health`, `GET /api/monitor/status`, `GET /api/openapi.yaml`.

**Public paths** (no API key required): `/api/health`, `/api/stats`, `/api/stats/count`, `/api/toc`, `/api/domains`, `/api/search`, `/api/sections`, `/api/openapi.yaml`, `/api/docs`, `/api/curated`.

### Configuration

| Env variable | Default | Description |
| :--- | :--- | :--- |
| `CRESCENT_CITY_API_KEY` | _(random per-boot)_ | Valid API key(s) — comma-separated for multiple |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Sliding-window request cap per IP per hour |

### Integration

```typescript
// src/gui/server.ts
import { applyMiddleware } from "../api/middleware.js";

const server = Bun.serve({
  fetch: async (req) => {
    const middlewareResponse = await applyMiddleware(req);
    if (middlewareResponse !== null) return middlewareResponse;
    // ... route handling
  }
});
```

### Notes

- Rate limit store is **in-memory** — resets on server restart. For production with multiple instances, replace with a Redis-backed store.
- API keys are checked by exact string match. Multiple keys can be provided comma-separated in `CRESCENT_CITY_API_KEY`.
