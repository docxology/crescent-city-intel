# Corpus intelligence — graph, lexicon, longevity

Three pure modules that read the scraped municipal code and answer structural
questions about it. None of them touches the network, an LLM, or the clock
beyond a `generatedAt` stamp; each takes sections in and returns a bounded,
deterministic report, so the API route, the GUI panel, and a test fixture all
see the same numbers.

| Module | Question | Route | GUI |
| :--- | :--- | :--- | :--- |
| `src/section_graph.ts` | What cites what? | `GET /api/sections/graph` | Code Analytics → 🕸️ Section Graph |
| `src/word_frequency.ts` | What does the code talk about? | `GET /api/lexicon/frequency` | Code Analytics → 🔤 Word Frequency |
| `src/section_longevity.ts` | How old and how settled is the law? | `GET /api/sections/longevity` | Code Analytics → ⏳ Longevity |

The ordinance timeline (`src/ordinance_chronology.ts`, `GET /api/ordinance/chronology`)
is documented in `v2-intelligence.md`; its GUI panel lives in the same overlay
under 🏛️ Ordinance Timeline.

---

## Section dependency graph (`src/section_graph.ts`)

Schema `crescent-city-section-graph/v1`.

`buildSectionGraph(sections, options)` turns the `§ X.XX.XXX` citations in
section prose into a directed graph. The citation grammar and the
dot-boundary-anchored resolution rule are imported from
`structured_queries.resolveSectionNumber` rather than re-derived, so the graph
can never disagree with the per-section cross-reference view the API already
serves — `§ 17.5` does not match `17.56.040`, in both places, for the same
reason.

> **Section numbers carry a marker.** `FlatSection.number` is `"§ 8.04.010"`,
> not `"8.04.010"`. Every comparison against a citation, a `?title=` filter, or
> a user-typed lookup must go through `normalizeSectionNumber` (`src/utils.ts`)
> on **both** sides. Comparing the raw forms is silently always-false: it made
> corpus-wide cross-reference resolution read 0% until 2026-09-05.

Modelling decisions that shape every number in the report:

- **An edge is a distinct resolved from→to pair.** Citing the same section
  three times raises that edge's `weight` to 3 and leaves both degrees at 1.
  Degree therefore means "how many other sections", not "how many times the
  text says §".
- **Self-references are counted, never edged.** A section citing itself is a
  drafting artifact, not a dependency; it appears in `summary.selfReferences`
  and nowhere else.
- **Dangling citations are reported, not dropped.** A citation naming a
  section the corpus does not contain lands in `unresolved` with its source and
  occurrence count, and moves `summary.resolutionRate`.
- **The summary describes the report's own scope.** Under `titleFilter` or an
  ego network, the citation counts, resolution rate, and component counts all
  describe what is in the report — not the corpus behind it.

Resolution goes through `buildSectionNumberIndex` rather than the linear
`resolveSectionNumber`, because a corpus-wide sweep resolves every citation in
every section and the linear form is two array scans per citation. The index
reproduces the linear rule exactly — first-match semantics for both exact and
dot-boundary-prefix lookups — and a test asserts the two agree, including on
duplicate section numbers.

`options.focusGuid` switches the report to an ego network: an *undirected*
expansion out to `depth` hops, because a reader following the code cares both
about what a section cites and about what cites it. An unknown guid throws
`Unknown section guid: …`, which the route maps to 400 rather than 500.

Derived structure in `summary`: `density` (edges over the directed
simple-graph maximum), `components` and `largestComponentSize` (weakly
connected, via union-find with path compression), `reciprocalPairs` (mutual
citations), and `isolatedNodes`.

## Word frequency (`src/word_frequency.ts`)

Schema `crescent-city-word-frequency/v1`.

`buildWordFrequency(sections, options)` reuses the BM25 index's own contract —
`LEGAL_STOP_WORDS`, `STEMMER_EXCEPTIONS`, and the Porter `stem` — so a term in
this profile is a term search would have matched. Each stem reports the most
frequent surface form observed for it, because `requir` is not a word anyone
wants to read in a UI.

Two rankings come out of one scan:

- `topByFrequency` — raw counts, with the `documentFrequency` that says
  whether a large count comes from one verbose section or from the whole code.
- `topBySalience` — `count · ln(N / df)`. A term present in *every* section
  scores exactly 0 however often it occurs, which is what makes this list worth
  having next to the first one.

`summary.distinctTerms` and `summary.hapaxCount` describe the whole scan;
`minDocumentFrequency` and `minLength` filter the rankings only.

## Section longevity (`src/section_longevity.ts`)

Schema `crescent-city-section-longevity/v1`.

`buildSectionLongevity(sections, options)` reads the same legislative-history
lines `ordinance_chronology` reads, and asks the complementary question: not
"what happened, in order", but "how old is this, and how settled". Per section
it derives `enactedYear`, `lastAmendedYear`, `ageYears`,
`yearsSinceLastAmendment`, and `churnPerDecade`; across sections it derives
medians, a `dormantOver20Years` count, and a decade histogram.

Honesty rules the module enforces:

- A section whose history carries no parseable year is `status: "unknown"`. It
  is never dated to today, it is excluded from every median and from the
  histogram, and it is counted in `summary.withoutHistory` so the gap is
  visible rather than absorbed.
- `asOfYear` is an input. The report is reproducible instead of drifting with
  the wall clock; the route accepts it and ignores values outside 1800–2200.
- `byDecade` is **contiguous** between the earliest and latest observed decade.
  A decade with no activity is present with zero counts rather than absent, so
  a chart drawn from the array cannot silently compress an empty stretch of the
  city's legislative history.

---

## Bounds

All three take `limit` and record the bound in `truncated` rather than hiding
it; the `summary` always reports the true totals behind the bound. Route caps:
graph 1000, longevity 500, lexicon 500.

## Tests

`tests/section-graph.test.ts`, `tests/word-frequency.test.ts`, and
`tests/section-longevity.test.ts` cover the pure modules against fixtures —
including the empty corpus, the dot-boundary prefix rule, undatable sections,
and a determinism check. `tests/corpus-intelligence-routes.test.ts` covers the
route contracts against the real corpus on the host and the GUI string
contracts for the panels.

String contracts prove the markup is present; they cannot prove a loader runs.
`bun run test:browser` drives all four panels plus the civic insight brief in
real headless Chromium: it opens each tab, waits for the loading placeholder to
be replaced, asserts the panel's own metric labels rendered, asserts the request
to the backing endpoint actually went out, and fails on any page error. The chat
model picker is checked there too — populated from `/api/llm/models`, or left at
exactly one honest "Default model" entry when the provider is unreachable.
