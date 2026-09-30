# Verification Module

## `src/verify.ts` — Data Integrity Verification

Checks local source custody, current TOC agreement, and a deterministic live
sample as separate evidence planes. A passing receipt supports the recorded
edition's publication eligibility; it does not establish extraction accuracy for
every possible page or that every live page remains unchanged.

### Verification Checks

| Check | Description |
|-------|-------------|
| **File Existence** | Every expected article JSON file exists on disk |
| **Local custody/replay** | Saved HTML hash, manifest membership/counts, exact TOC section membership, and extraction receipt/replay agree |
| **Current TOC** | A newly fetched TOC matches the saved TOC defining the edition |
| **Live sample** | Deterministically selected article pages are re-fetched and compared to saved HTML hashes; selection depends on the saved TOC |
| **Publication binding** | Exact manifest and TOC byte hashes plus the canonical exported article-set hash bind the receipt to its inputs |

The local, current-TOC, and sample planes each record `pass`, `fail`,
`unavailable`, or `not_attempted`. `overallStatus` passes only when every
required plane passes. `publicationEligible` additionally requires live
ecode360 evidence and a nonempty completed sample. An unavailable upstream,
failed sample, omitted check, or changed input cannot become a publication pass.

### Internal Functions

| Function | Description |
|----------|-------------|
| `collectDescendantSections` | Recursively collects section nodes nested under subarticles and parts within an article |
| `verifyCorpus(options?)` | Execute bounded verification with explicit input root and evidence origin; real local fixtures can supply TOC/refetch inputs |
| `verificationMatchesInputs(report, root?)` | Recompute the manifest, TOC, and exported article-set bindings before reusing a receipt |

### Output

Writes `output/verification-report.json` containing:

```typescript
interface BoundVerificationReport {
  schemaVersion: "corpus-verification/v2";
  verifiedAt: string;
  municipality: string;
  overallStatus: "pass" | "fail";
  publicationEligible: boolean;
  binding: { manifestSha256: string; tocSha256: string; articleSetSha256: string };
  planes: {
    local: "pass" | "fail" | "unavailable" | "not_attempted";
    currentToc: "pass" | "fail" | "unavailable" | "not_attempted";
    sample: "pass" | "fail" | "unavailable" | "not_attempted";
  };
  totalArticles: number;
  passedArticles: number;
  failedArticles: number;
  totalExpectedSections: number;
  totalFoundSections: number;
  missingSections: string[];
  results: VerificationResult[];
  // Also records selected sample IDs/outcomes, local errors, and limitations.
}
```

### Usage

```bash
bun run verify
bun run verify -- --offline # local custody check only; never publication-eligible
```

Live verification exits 1 when a required plane fails or cannot be completed.
Offline mode can exit 0 for passing local custody while still recording a
non-publication-eligible receipt. Both require the saved TOC, manifest, and
article files under the selected `CC_OUTPUT_DIR` (default `output/`). Fixtures
and reviewed seeds retain their evidence origin; they cannot claim live
verification merely by supplying matching hashes.
