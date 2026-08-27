/**
 * Cross-source validation layer — classifies how well independent source
 * snippets support a factual claim.
 *
 * Grounding invariant: the verifier NEVER trusts a model's own claims about
 * what it quoted. Every quoted span proposed by the provider must pass a
 * literal substring check against the originating snippet text
 * (`verifiedBySubstring`) before it can influence a verdict. Unverifiable
 * spans are reported and dropped, never guessed around.
 *
 * Two layers:
 *  - Pure builders (`normalizeForSubstringMatch`, `verifiedBySubstring`,
 *    `classifySupportFromCounts`, `extractQuoteSpans`, `buildClaimValidation`)
 *    — deterministic, unit-testable without any provider.
 *  - Provider-backed wrapper (`validateClaims` / `validateEventClaims`) that
 *    uses `queryStructured` to propose candidate quoted spans, then hands
 *    every proposal to the pure code-side verifier above.
 */

export type ClaimSupportVerdict =
  | "corroborated"
  | "partial"
  | "unsupported"
  | "contradicted";

export const SUPPORT_VERDICTS: readonly ClaimSupportVerdict[] = [
  "corroborated",
  "partial",
  "unsupported",
  "contradicted",
] as const;

export interface CorroborationSnippet {
  /** Distinct independent source URL this snippet came from. */
  sourceUrl: string;
  /** Raw snippet text as fetched from the source. */
  text: string;
}

export interface VerifiedSpan {
  /** The quoted span exactly as proposed. */
  span: string;
  /** Source URL of the snippet the span was verified against. */
  sourceUrl: string;
  /**
   * True only when the span survived the code-side substring check.
   * A model hallucinating a quote can never set this from its own say-so.
   */
  verified: boolean;
}

export interface ClaimValidation {
  claim: string;
  verdict: ClaimSupportVerdict;
  /** Spans that passed the substring check (supporting + contradicting). */
  verifiedSpans: VerifiedSpan[];
  /** Distinct source URLs contributing at least one verified supporting span. */
  distinctSourcesCount: number;
  /** Spans proposed but dropped because they failed the substring check. */
  rejectedSpans: Array<{ span: string; reason: "not_found" }>;
  provenance: Array<{ url: string; snippetExcerpt: string }>;
}

/** Lowercase, collapse whitespace/quote-glyph variance for literal matching. */
export function normalizeForSubstringMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Code-side verbatim (modulo casing/whitespace) substring check. */
export function verifiedBySubstring(span: string, snippetText: string): boolean {
  const needle = normalizeForSubstringMatch(span);
  return needle.length >= 3 && normalizeForSubstringMatch(snippetText).includes(needle);
}

/**
 * Deterministic classifier over VERIFIED counts only.
 * - Any verified contradicting span wins outright ("contradicted").
 * - >=2 distinct sources with verified supporting spans -> "corroborated".
 * - Exactly 1 -> "partial" (single-source, needs corroboration).
 * - 0 verified supporting sources -> "unsupported".
 */
export function classifySupportFromCounts(
  verifiedSupportingSources: number,
  verifiedContradictingSpans: number,
): ClaimSupportVerdict {
  if (!Number.isInteger(verifiedSupportingSources) || verifiedSupportingSources < 0) {
    throw new Error("verifiedSupportingSources must be a non-negative integer");
  }
  if (!Number.isInteger(verifiedContradictingSpans) || verifiedContradictingSpans < 0) {
    throw new Error("verifiedContradictingSpans must be a non-negative integer");
  }
  if (verifiedContradictingSpans > 0) return "contradicted";
  if (verifiedSupportingSources >= 2) return "corroborated";
  if (verifiedSupportingSources === 1) return "partial";
  return "unsupported";
}

/** Pull "\u201c...\u201d"-style quoted spans out of arbitrary model/snippet text. */
export function extractQuoteSpans(text: string): string[] {
  const spans: string[] = [];
  const re = /\u201c([^\u201d]+)\u201d|"([^"]{2,})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const span = (m[1] ?? m[2] ?? "").trim();
    if (span.length >= 3) spans.push(span);
  }
  return [...new Set(spans)];
}

function buildProvenance(snippets: CorroborationSnippet[]): ClaimValidation["provenance"] {
  return snippets.map(s => ({ url: s.sourceUrl, snippetExcerpt: s.text.slice(0, 200) }));
}

/**
 * Pure assembly given pre-verified span sets (no provider involved).
 * Counts only VERIFIED spans; distinct source counting is over supporting
 * sources so a single source quoting twice still reads as one witness.
 */
export function buildClaimValidation(
  claim: string,
  snippets: CorroborationSnippet[],
  verifiedSupporting: VerifiedSpan[],
  verifiedContradicting: VerifiedSpan[],
  rejectedSpans: ClaimValidation["rejectedSpans"] = [],
): ClaimValidation {
  return {
    claim,
    verdict: classifySupportFromCounts(
      new Set(verifiedSupporting.filter(v => v.verified).map(v => v.sourceUrl)).size,
      verifiedContradicting.filter(v => v.verified).length,
    ),
    verifiedSpans: [...verifiedSupporting, ...verifiedContradicting],
    distinctSourcesCount: new Set(verifiedSupporting.filter(v => v.verified).map(v => v.sourceUrl)).size,
    rejectedSpans,
    provenance: buildProvenance(snippets),
  };
}

// ─── Provider-backed layer ─────────────────────────────────────────────

interface ProposedQuotes {
  supportingQuotes?: unknown;
  contradictingQuotes?: unknown;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

async function proposeQuoteSpans(claim: string, snippets: CorroborationSnippet[]): Promise<[string[], string[]]> {
  const { queryStructured } = await import("./structured.js");
  const schemaHint =
    '{"supportingQuotes": ["<exact verbatim span copied from a snippet>"], '
    + '"contradictingQuotes": ["<exact verbatim span copied from a snippet>"]}';
  const prompt =
    `Claim: "${claim}"\n\nIndependent source snippets:\n\n`
    + snippets
      .map((s, i) => `[${i}] (${s.sourceUrl})\n${s.text.slice(0, 1200)}`)
      .join("\n\n")
    + "\n\nCopy ONLY spans that appear EXACTLY, character-for-character, inside "
    + "the snippets above. Do not paraphrase or invent text.";
  const structured = await queryStructured<ProposedQuotes>(prompt, {
    schemaHint,
    systemPrompt:
      "You are a strict evidence extractor. Quote only verbatim text present in the provided snippets.",
  }, (v): v is ProposedQuotes => {
    if (typeof v !== "object" || v === null) return false;
    const record = v as Record<string, unknown>;
    return (record.supportingQuotes === undefined || isStringArray(record.supportingQuotes))
      && (record.contradictingQuotes === undefined || isStringArray(record.contradictingQuotes));
  });
  const raw: unknown = structured.value;
  const value = typeof raw === "object" && raw !== null
    ? (raw as { supportingQuotes?: unknown; contradictingQuotes?: unknown })
    : null;
  const supporting: string[] = isStringArray(value?.supportingQuotes)
    ? (value.supportingQuotes as string[])
    : [];
  const contradicting: string[] = isStringArray(value?.contradictingQuotes)
    ? (value.contradictingQuotes as string[])
    : [];
  const result: [string[], string[]] = [supporting, contradicting];
  return result;
}

/**
 * Ask the configured chat provider to propose quoted spans from each snippet
 * that support or contradict the claim, then VERIFY every proposal in code.
 * Only substring-verified spans may influence the verdict; everything else is
 * reported under rejectedSpans with reason "not_found".
 *
 * When the provider is unreachable or produces no structured output, the
 * result degrades deterministically to "unsupported" with zero verified
 * spans — an absent verifier never fabricates corroboration.
 */
export async function validateClaims(
  claim: string,
  snippets: CorroborationSnippet[],
): Promise<ClaimValidation> {
  if (!claim.trim() || snippets.length === 0) {
    return buildClaimValidation(claim, snippets, [], []);
  }

  let proposed: [string[], string[]];
  try {
    proposed = await proposeQuoteSpans(claim, snippets);
  } catch {
    proposed = [[], []] as [string[], string[]];
  }

  const [supporting, contradicting] = proposed;
  const verifiedSupporting: VerifiedSpan[] = [];
  const verifiedContradicting: VerifiedSpan[] = [];
  const rejectedSpans: ClaimValidation["rejectedSpans"] = [];

  const check = (span: string, target: VerifiedSpan[]) => {
    const owner = snippets.find(s => verifiedBySubstring(span, s.text));
    if (owner) target.push({ span, sourceUrl: owner.sourceUrl, verified: true });
    else rejectedSpans.push({ span, reason: "not_found" });
  };
  for (const span of supporting) check(span, verifiedSupporting);
  for (const span of contradicting) check(span, verifiedContradicting);

  return buildClaimValidation(claim, snippets, verifiedSupporting, verifiedContradicting, rejectedSpans);
}

/**
 * Events-path entry point for src/events.ts (owned by the events lane this
 * round): gate extracted event facts against independent source snippets
 * before publication. Same contract as `validateClaims`; the alias keeps the
 * wiring site self-describing. See docs/modules/llm.md for intended wiring.
 */
export const validateEventClaims = validateClaims;
