# Domains Module

## `src/domains.ts` — Intelligence Domain Data

Structured, curated knowledge about Crescent City's key civic domains with cross-references to municipal code sections. Enhances the RAG pipeline with context beyond the raw code text.

### The 12 Domains

| ID | Icon | Name | Focus |
| :--- | :--- | :--- | :--- |
| `emergency-management` | 🌊 | Emergency Management | Tsunami, earthquake, evacuation, mutual aid |
| `business-development` | 🦀 | Business Development | Fishing, tourism, harbor, permits |
| `environmental-protection` | 🌿 | Environmental Protection | Coastal zone, redwoods, wildlife, waste |
| `public-safety` | 🛡️ | Public Safety | Police, corrections, Pelican Bay |
| `event-planning` | 🎪 | Event Planning | Special events, film permits |
| `housing-homelessness` | 🏠 | Housing & Homelessness | Affordable housing, shelter, CARE Court |
| `tourism-recreation` | 🏕️ | Tourism & Recreation | Attractions, parks, visitors |
| `harbor-marine-operations` | ⚓ | Harbor & Marine Operations | Harbor commerce, dredging, fishing fleet |
| `education-youth` | 📚 | Education & Youth | School district, youth programs |
| `climate-environment` | 🌡️ | Climate & Environment | Sea-level rise, drought, air quality |
| `demographics-social` | 👥 | Demographics & Social Indicators | Population, poverty, homelessness trends |
| `public-health-safety` | 🏥 | Public Health & Safety | EMS, food safety, mental health |

### Exports

| Export | Signature | Description |
| :--- | :--- | :--- |
| `domains` | `IntelligenceDomain[]` | Array of all 12 domain objects (constant) |
| `getDomainById` | `(id: string) → IntelligenceDomain \| undefined` | Look up by ID slug |
| `getDomainSummaries` | `() → DomainSummary[]` | Lightweight list without full topic data |
| `searchDomains` | `(query: string) → IntelligenceDomain[]` | Full-text search across names, descriptions, tags |

### Interfaces

```typescript
interface IntelligenceDomain {
  id: string;          // kebab-case slug
  name: string;
  description: string;
  icon: string;        // emoji
  topics: DomainTopic[];
  updatedAt: string;   // ISO date
}

interface DomainTopic {
  name: string;
  description: string;
  sources: DomainSource[];   // municipal code cross-refs
  externalRefs?: string[];   // external URLs
  tags: string[];
}

interface DomainSource {
  sectionNumber: string;  // e.g. "§ 8.04.010"
  relevance: string;
}
```

### GUI Integration

Domains are served via the `/api/domains` endpoint and visible in the Domains panel of the GUI. `/api/domains/search?q=...` searches across domains, and `/api/domains/coverage` reports what percentage of the current manifest's sections each domain cross-references.

### Data Flow

```text
src/domains.ts (static data)
    → GET /api/domains              (routes.ts)
    → GET /api/domains/search       (routes.ts)
    → GET /api/domains/coverage     (src/domains/coverage.ts)
    → RAG system prompt             (rag.ts context injection)
```

### Tests

```bash
bun test tests/domains.test.ts
```
