/**
 * Legal citation parser and definition glossary extractor.
 *
 * Extracts and structures:
 * - California Code citations (Cal. Gov. Code §, Cal. Health & Safety Code §)
 * - Federal law citations (42 U.S.C. §, 33 U.S.C. §)
 * - Case law citations (v. patterns)
 * - Defined terms from Title 1 (General Provisions) for glossary building
 * - Ordinance amendment dates from legislative history
 *
 * All functions are pure — they take text and return structured data.
 */

export interface LegalCitation {
  /** Full citation as it appears in text */
  citation: string;
  /** Code system: CA-code, federal, case-law */
  type: "ca-code" | "federal" | "case-law" | "ordinance";
  /** Code name, e.g. "Government Code", "Health and Safety Code" */
  codeName: string | null;
  /** Section number(s) */
  section: string | null;
  /** Ordinance number if type=ordinance */
  ordinanceNumber: string | null;
  /** Parsed year if present */
  year: number | null;
  /** Position in source text (character offset) */
  start: number;
  /** End position */
  end: number;
}

export interface DefinitionEntry {
  /** The term being defined */
  term: string;
  /** The definition text */
  definition: string;
  /** Section where the definition appears */
  sectionNumber: string;
  /** Full sentence context */
  context: string;
}

export interface OrdinanceAmendment {
  /** Ordinance number */
  ordinance: string;
  /** Action taken */
  action: string;
  /** Year of action */
  year: number | null;
  /** Raw text */
  raw: string;
}

// ─── Legal Citation Patterns ─────────────────────────────────────────

// California code citations
const CA_CODE_PATTERN = /(?:Cal\.?\s*)?(?:Government\s*Code|Gov\.?\s*Code|Health\s*(?:and|&)\s*Safety\s*Code|H&SC|Penal\s*Code|Pen\.?\s*Code|Vehicle\s*Code|Veh\.?\s*Code|Water\s*Code|Fish\s*(?:and|&)\s*Game\s*Code|Public\s*Resources\s*Code|PRC|Business\s*(?:and|&)\s*Professions\s*Code|B&P\s*Code|Civil\s*Code|Civ\.?\s*Code|Elections\s*Code|Elec\.?\s*Code|Education\s*Code|Ed\.?\s*Code|Labor\s*Code|Lab\.?\s*Code|Welfare\s*(?:and|&)\s*Institutions\s*Code|W&IC)\s*§\s*([\d.]+)/gi;

// Federal law citations (U.S.C.)
const FEDERAL_PATTERN = /(\d+)\s*U\.?S\.?C\.?\s*§?\s*([\d.]+)/gi;

// Case law (X v. Y)
const CASE_LAW_PATTERN = /([A-Z][a-zA-Z]+\s+v\.\s+[A-Z][a-zA-Z]+)/g;

// Ordinance references
const ORDINANCE_PATTERN = /Ord(?:inance)?\.?\s*(?:No\.?)?\s*(\d+)\s*(?:§\s*[\d.]+)?,?\s*(\d{4})?/gi;

/**
 * Extract all legal citations from a text passage.
 */
export function extractCitations(text: string): LegalCitation[] {
  const citations: LegalCitation[] = [];

  // California code citations
  for (const match of text.matchAll(CA_CODE_PATTERN)) {
    const codeName = match[0].split(/\s*§/i)[0].trim();
    citations.push({
      citation: match[0],
      type: "ca-code",
      codeName: codeName.replace(/^Cal\.?\s*/i, ""),
      section: match[1],
      ordinanceNumber: null,
      year: null,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  // Federal citations
  for (const match of text.matchAll(FEDERAL_PATTERN)) {
    citations.push({
      citation: match[0],
      type: "federal",
      codeName: "U.S. Code",
      section: `${match[1]} U.S.C. § ${match[2]}`,
      ordinanceNumber: null,
      year: null,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  // Case law
  for (const match of text.matchAll(CASE_LAW_PATTERN)) {
    citations.push({
      citation: match[0],
      type: "case-law",
      codeName: null,
      section: null,
      ordinanceNumber: null,
      year: null,
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    });
  }

  return citations;
}

/**
 * Extract ordinance amendment records from a legislative history string.
 */
export function extractOrdinanceAmendments(historyText: string): OrdinanceAmendment[] {
  if (!historyText?.trim()) return [];

  const entries: OrdinanceAmendment[] = [];
  const parts = historyText.split(";").map(p => p.trim()).filter(Boolean);

  for (const part of parts) {
    const match = part.match(/Ord(?:inance)?\.?\s*(?:No\.?)?\s*(\d+)/i);
    const yearMatch = part.match(/(\d{4})/);
    const actionMatch = part.match(/\b(enacted|amended|repealed|adopted|added|deleted|renumbered)\b/i);

    if (match) {
      entries.push({
        ordinance: `Ord. No. ${match[1]}`,
        action: actionMatch ? actionMatch[1].toLowerCase() : "amended",
        year: yearMatch ? parseInt(yearMatch[1], 10) : null,
        raw: part,
      });
    }
  }

  return entries;
}

// ─── Definition Extraction ──────────────────────────────────────────

// Patterns for definitions in legal text
const DEFINITION_PATTERNS = [
  // "shall mean" pattern: "Building shall mean any structure..."
  /(?:^|\.\s+)([A-Z][a-z]+(?:\s+[a-z]+)?)\s+(?:shall\s+mean|means)\s+(.+?)(?=\.\s|$)/g,
  // "means" pattern: "Building means any structure..."
  /(?:^|\.\s+)([A-Z][a-z]+(?:\s+[a-z]+)?)\s+means\s+(.+?)(?=\.\s|$)/g,
  // "is defined as" pattern
  /(?:^|\.\s+)([A-Z][a-z]+(?:\s+[a-z]+)?)\s+(?:is|are)\s+defined\s+as\s+(.+?)(?=\.\s|$)/g,
  // "shall include" pattern
  /(?:^|\.\s+)([A-Z][a-z]+(?:\s+[a-z]+)?)\s+(?:shall\s+include|includes)\s+(.+?)(?=\.\s|$)/g,
];

/**
 * Extract defined terms from a section's text.
 * Looks for common legal definition patterns ("shall mean", "means", "is defined as").
 */
export function extractDefinitions(text: string, sectionNumber: string): DefinitionEntry[] {
  const definitions: DefinitionEntry[] = [];
  const seen = new Set<string>();

  for (const pattern of DEFINITION_PATTERNS) {
    const localPattern = new RegExp(pattern.source, pattern.flags);
    for (const match of text.matchAll(localPattern)) {
      const term = match[1].trim();
      const definition = match[2].trim();

      // Filter out common false positives
      if (term.length < 3 || term.length > 60) continue;
      if (definition.length < 5 || definition.length > 500) continue;
      if (/\d/.test(term)) continue; // Skip terms with numbers

      // Skip if it's a common word followed by "means" (e.g., "This means")
      const skipWords = new Set(["This", "That", "These", "Those", "It", "Here", "There", "Which", "What", "Every", "No", "Any", "All", "The"]);
      if (skipWords.has(term.split(" ")[0])) continue;

      if (seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());

      definitions.push({
        term,
        definition,
        sectionNumber,
        context: match[0].trim(),
      });
    }
  }

  return definitions;
}

/**
 * Build a glossary from all sections in the corpus.
 * Returns definitions sorted by term alphabetically.
 */
export function buildGlossary(sections: Array<{ number: string; text: string }>): DefinitionEntry[] {
  const glossary: DefinitionEntry[] = [];

  for (const section of sections) {
    const defs = extractDefinitions(section.text, section.number);
    glossary.push(...defs);
  }

  // Sort by term, then prefer definitions from Title 1 (General Provisions)
  glossary.sort((a, b) => {
    const termCompare = a.term.toLowerCase().localeCompare(b.term.toLowerCase());
    if (termCompare !== 0) return termCompare;
    // Prefer Title 1 definitions
    const aTitle1 = a.sectionNumber.startsWith("1.");
    const bTitle1 = b.sectionNumber.startsWith("1.");
    if (aTitle1 && !bTitle1) return -1;
    if (!aTitle1 && bTitle1) return 1;
    return 0;
  });

  return glossary;
}

/**
 * Extract the effective date from a section's legislative history.
 * Returns the most recent amendment year, or the enactment year if no amendments.
 */
export function extractEffectiveDate(historyText: string): number | null {
  const amendments = extractOrdinanceAmendments(historyText);
  if (amendments.length === 0) return null;

  // Return the most recent year
  const years = amendments
    .map(a => a.year)
    .filter((y): y is number => y !== null)
    .sort((a, b) => b - a);

  return years.length > 0 ? years[0] : null;
}
