# API Middleware — `src/api/`

HTTP request middleware for the Bun GUI server.

## middleware.ts

Composable middleware chain applied to every request before route handlers.

| Middleware | Behavior |
| :--- | :--- |
| **Request logger** | Logs method, URL, duration (ms) |
| **Rate limiter** | Sliding-window cap of 100 requests per IP per hour (stricter per-path limits for `/api/chat`, `/api/summarize`, `/api/analytics/embeddings`; in-memory) |
| **API key auth** | Validates the `X-API-Key` header (header-only; a prior `?api_key=` query-param form was removed for credential-leak reasons) |

**Rate-limit bypass paths**: `GET /api/health`, `GET /api/monitor/status`, `GET /api/openapi.yaml`.

**Public paths** (no API key required): `/api/health`, `/api/stats`, `/api/stats/count`, `/api/toc`, `/api/domains`, `/api/search`, `/api/sections`, `/api/openapi.yaml`, `/api/docs`, `/api/curated`.

## Usage

```typescript
// src/gui/server.ts
import { applyMiddleware } from "../api/middleware.js";
const res = await applyMiddleware(req);
if (res !== null) return res;  // short-circuit
```

## Environment

```bash
CRESCENT_CITY_API_KEY=my-secret-key   # random per-boot key when unset
```
