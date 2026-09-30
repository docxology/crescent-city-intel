/** Citation checks establish record identity, never semantic entailment. */
import type { RagSource } from "../types.js";
export interface EvidenceAssessment {
  disposition: "generated-unverified" | "abstained";
  support: "not-evaluated";
  verifiedSupport: false;
  citationStatus: "valid" | "missing" | "invalid";
  citedSections: string[];
  unknownSections: string[];
  limitation: string;
}
export function assessAnswerEvidence(answer: string, sources: readonly RagSource[]): EvidenceAssessment {
  const citedSections = [...new Set([...answer.matchAll(/§\s*(\d+(?:\.\d+){1,3}[A-Za-z]?)/g)].map(match => match[1]!))];
  const known = new Set(sources.filter(source => source.sourceType === "municipal_code").map(source => source.sectionNumber.replace(/^§\s*/, "")));
  const unknownSections = citedSections.filter(section => !known.has(section));
  const citationStatus = unknownSections.length ? "invalid" : citedSections.length ? "valid" : "missing";
  return { disposition: !answer.trim() || citationStatus !== "valid" ? "abstained" : "generated-unverified", support: "not-evaluated", verifiedSupport: false, citationStatus, citedSections, unknownSections,
    limitation: "Citation identity is checked against retrieved records. Claim entailment, source independence, legal currency and factual correctness have not been verified." };
}

/** Literal overlap is useful diagnostic evidence, never a support verdict. */
export function evaluateLiteralSpan(claim: string, sourceText: string) {
  return { literalSpanPresent: sourceText.includes(claim), semanticSupport: "not-evaluated" as const, verifiedSupport: false as const };
}
