# Generated HTTP inventory

Generated from [openapi.yaml](../../openapi.yaml). GET also permits HEAD at runtime; the rows below are explicit spec operations. Auth and success bodies use the same structural authority as runtime contracts.

| Operation | Auth | Parameters | Request body | Success responses |
| :--- | :--- | :--- | :--- | :--- |
| `GET /api/alerts/airquality` | API key | none | none | 200 application/json |
| `GET /api/alerts/composite` | API key | none | none | 200 application/json |
| `GET /api/alerts/correlation` | API key | none | none | 200 application/json |
| `GET /api/alerts/marine` | API key | none | none | 200 application/json |
| `GET /api/alerts/recent` | API key | query:limit | none | 200 application/json |
| `GET /api/alerts/timeline` | API key | none | none | 200 application/json |
| `GET /api/alerts/wildfire` | API key | none | none | 200 application/json |
| `GET /api/alerts/{type}/history` | API key | path:type (required), query:limit, query:offset | none | 200 application/json |
| `GET /api/analytics/embeddings` | API key | none | none | 200 application/json |
| `GET /api/analytics/overview` | API key | none | none | 200 application/json |
| `GET /api/analytics/stats` | API key | none | none | 200 application/json |
| `GET /api/annotations` | API key | none | none | 200 application/json |
| `POST /api/annotations` | API key | none | application/json | 201 no body |
| `DELETE /api/annotations` | API key | query:id (required) | none | 200 no body |
| `GET /api/article/{guid}` | public | path:guid (required) | none | 200 application/json |
| `GET /api/chat` | API key | query:q (required), query:model | none | 200 application/json |
| `POST /api/chat` | API key | none | application/json | 200 application/json |
| `POST /api/chat/stream` | API key | none | application/json | 200 no body |
| `GET /api/citations/index` | API key | query:limit | none | 200 application/json |
| `GET /api/citations/{guid}` | API key | path:guid (required) | none | 200 application/json |
| `GET /api/compare` | API key | query:guid1 (required), query:guid2 (required) | none | 200 application/json |
| `GET /api/cross-refs/validate` | API key | none | none | 200 application/json |
| `GET /api/curated` | public | query:limit | none | 200 application/json |
| `GET /api/curation/status` | API key | none | none | 200 application/json |
| `GET /api/definitions/conflicts` | API key | none | none | 200 application/json |
| `GET /api/docs` | public | none | none | 200 text/html |
| `GET /api/docs/modules` | public | none | none | 200 application/json |
| `GET /api/domain/{id}` | API key | path:id (required) | none | 200 application/json |
| `GET /api/domain/{id}/search` | API key | path:id (required), query:q (required) | none | 200 application/json |
| `GET /api/domain/{id}/sections` | API key | path:id (required) | none | 200 application/json |
| `GET /api/domains` | public | none | none | 200 application/json |
| `GET /api/domains/coverage` | API key | none | none | 200 application/json |
| `GET /api/domains/search` | API key | query:q (required) | none | 200 application/json |
| `GET /api/domains/{id}/coverage` | API key | path:id (required) | none | 200 application/json |
| `GET /api/effective-dates` | API key | query:limit, query:guid | none | 200 application/json |
| `GET /api/events/discover` | API key | query:refresh, query:live, query:limit, query:offset | none | 200 application/json |
| `GET /api/fuzzy` | API key | query:q (required) | none | 200 application/json |
| `GET /api/geo-intel` | API key | none | none | 200 application/json |
| `GET /api/geo-observations` | API key | none | none | 200 application/json |
| `GET /api/glossary` | API key | none | none | 200 application/json |
| `GET /api/health` | public | none | none | 200 application/json |
| `GET /api/history/{guid}` | API key | path:guid (required) | none | 200 application/json |
| `GET /api/insights` | API key | query:rebuild, query:window | none | 200 application/json |
| `GET /api/lexicon/frequency` | API key | query:limit, query:title, query:minLength, query:minDf | none | 200 application/json |
| `GET /api/llm/models` | API key | none | none | 200 application/json |
| `GET /api/llm/usage` | API key | none | none | 200 application/json |
| `GET /api/metadata` | public | none | none | 200 application/json |
| `GET /api/monitor/alerts` | API key | none | none | 200 application/json |
| `GET /api/monitor/history` | API key | query:limit | none | 200 application/json |
| `GET /api/monitor/status` | API key | none | none | 200 application/json |
| `GET /api/openapi.yaml` | public | none | none | 200 text/yaml |
| `GET /api/ordinal-check` | API key | none | none | 200 application/json |
| `GET /api/ordinals` | API key | query:limit, query:guid | none | 200 application/json |
| `GET /api/ordinance/chronology` | API key | query:limit, query:guid | none | 200 application/json |
| `GET /api/readability` | API key | none | none | 200 application/json |
| `GET /api/readability/history` | API key | query:limit, query:offset | none | 200 application/json |
| `GET /api/report/latest` | API key | none | none | 200 text/markdown |
| `GET /api/report/latest.json` | API key | none | none | 200 application/json |
| `GET /api/search` | public | query:q (required), query:limit, query:offset, query:title, query:highlight, query:type, query:field | none | 200 application/json |
| `GET /api/search/analytics` | API key | none | none | 200 application/json |
| `GET /api/search/semantic` | API key | query:q (required), query:limit, query:offset | none | 200 application/json |
| `GET /api/section/{guid}` | public | path:guid (required) | none | 200 application/json |
| `GET /api/sections` | public | query:title, query:chapter, query:limit, query:offset | none | 200 application/json |
| `GET /api/sections/graph` | API key | query:limit, query:title, query:guid, query:depth | none | 200 application/json |
| `GET /api/sections/longevity` | API key | query:limit, query:title, query:asOfYear | none | 200 application/json |
| `GET /api/similar/{guid}` | API key | path:guid (required), query:limit | none | 200 application/json |
| `GET /api/source-discovery` | API key | none | none | 200 application/json |
| `GET /api/sources` | API key | query:format | none | 200 application/json, text/csv |
| `GET /api/stats` | public | none | none | 200 application/json |
| `GET /api/stats/count` | public | none | none | 200 application/json |
| `POST /api/summarize` | API key | none | application/json | 200 application/json |
| `GET /api/toc` | public | none | none | 200 application/json |
| `GET /api/toc/breadcrumb` | API key | query:guid (required) | none | 200 application/json |
