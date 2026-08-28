import { describe, expect, test } from "bun:test";
import { extractVotes, computeDocumentHashes, diffDocumentHashes } from "../src/minutes_extraction";
import { SYNTHETIC_MINUTES_FIXTURE, EXPECTED_FIXTURE_VOTES } from "./fixtures/minutes_fixture";
import { computeSha256 } from "../src/utils";

describe("extractVotes (Phase 4.2 minutes depth)", () => {
  test("extracts every vote from the synthetic minutes fixture in document order", () => {
    const votes = extractVotes(SYNTHETIC_MINUTES_FIXTURE);
    expect(votes.length).toBe(EXPECTED_FIXTURE_VOTES.length);
    votes.forEach((v, i) => {
      expect(v.yea).toBe(EXPECTED_FIXTURE_VOTES[i]!.yea);
      expect(v.nay).toBe(EXPECTED_FIXTURE_VOTES[i]!.nay);
      expect(v.abstain).toBe(EXPECTED_FIXTURE_VOTES[i]!.abstain);
      expect(v.passed).toBe(EXPECTED_FIXTURE_VOTES[i]!.passed);
    });
  });

  test("returns empty for empty or unparseable text (never throws)", () => {
    expect(extractVotes("")).toEqual([]);
    expect(extractVotes("no votes here, just weather talk")).toEqual([]);
  });

  test("collapses exact duplicate tallies", () => {
    const dup = "Vote: 3 yea, 1 nay, 0 abstain.\n\nVote: 3 yea, 1 nay, 0 abstain.";
    expect(extractVotes(dup).length).toBe(1);
  });

  test("collapses a roll-call line followed by its matching summary tally", () => {
    const doc = "Roll call: Alpha: Yea, Beta: Nay, Gamma: Yea, Delta: Abstain.\n\nVote: 2 yea, 1 nay, 1 abstain. Motion carries.";
    const votes = extractVotes(doc);
    expect(votes.length).toBe(1);
    expect(votes[0]!.yea).toBe(2);
    expect(votes[0]!.abstain).toBe(1);
    expect(votes[0]!.passed).toBe(true);
  });
});

describe("document hash change detection (Phase 4.2)", () => {
  test("SHA-256 is deterministic per document text", async () => {
    const docs = [{ url: "https://example.test/a.pdf", text: "agenda body" }];
    const h1 = await computeDocumentHashes(docs);
    const h2 = await computeDocumentHashes(docs);
    expect(h1["https://example.test/a.pdf"]).toBe(h2["https://example.test/a.pdf"]);
    expect(h1["https://example.test/a.pdf"]).toMatch(/^[0-9a-f]{64}$/);
    // matches the canonical computeSha256 over the same trimmed text
    expect(h1["https://example.test/a.pdf"]).toBe(await computeSha256("agenda body"));
  });

  test("diff reports changed only when a previous hash differs; first sighting is new", async () => {
    const current = await computeDocumentHashes([
      { url: "https://example.test/a.pdf", text: "v1" },
      { url: "https://example.test/b.pdf", text: "x" },
    ]);
    const first = diffDocumentHashes(undefined, current);
    expect(first.find(d => d.url === "https://example.test/a.pdf")!.changed).toBe(false);
    expect(first.find(d => d.url === "https://example.test/a.pdf")!.isNew).toBe(true);

    const next = await computeDocumentHashes([
      { url: "https://example.test/a.pdf", text: "v2 edited" },
    ]);
    const drift = diffDocumentHashes(current, next);
    expect(drift.length).toBe(1);
    expect(drift[0]!.changed).toBe(true);
    expect(drift[0]!.isNew).toBe(false);
    expect(drift[0]!.previousHash).toBe(current["https://example.test/a.pdf"]);
  });

  test("absence in the current fetch is not drift", async () => {
    const prev = await computeDocumentHashes([{ url: "https://example.test/old.pdf", text: "y" }]);
    const current = await computeDocumentHashes([{ url: "https://example.test/new.pdf", text: "z" }]);
    const drift = diffDocumentHashes(prev, current);
    expect(drift.length).toBe(1);
    expect(drift[0]!.url).toBe("https://example.test/new.pdf");
    expect(drift[0]!.changed).toBe(false);
  });
});
