import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractVotes,
  computeDocumentHashes,
  diffDocumentHashes,
  isTextualContentType,
} from "../src/minutes_extraction";
import { loadMeetingDocHashes, saveMeetingDocHashes, parseVotes } from "../src/gov_meeting_monitor";
import {
  SYNTHETIC_MINUTES_FIXTURE,
  EXPECTED_FIXTURE_VOTES,
  NON_VOTE_LINES,
} from "./fixtures/minutes_fixture";
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

  test("keeps a consent calendar's repeated identical tallies as separate votes", () => {
    // Three items pass 5-0 in the fixture. Collapsing repeats anywhere in a
    // document would delete two real votes.
    const unanimous = extractVotes(SYNTHETIC_MINUTES_FIXTURE).filter(v => v.yea === 5 && v.nay === 0);
    expect(unanimous.length).toBe(3);
  });

  test("returns empty for empty or unparseable text (never throws)", () => {
    expect(extractVotes("")).toEqual([]);
    expect(extractVotes("no votes here, just weather talk")).toEqual([]);
  });

  test("collapses an identical tally restated in the immediately following block", () => {
    const dup = "Vote: 3 yea, 1 nay, 0 abstain.\n\nVote: 3 yea, 1 nay, 0 abstain.";
    expect(extractVotes(dup).length).toBe(1);
  });

  test("does not collapse identical tallies separated by other business", () => {
    const doc = [
      "Vote: 3 yea, 1 nay, 0 abstain.",
      "Discussion of the proposed budget amendment. Staff presentation.",
      "Vote: 3 yea, 1 nay, 0 abstain.",
    ].join("\n\n");
    expect(extractVotes(doc).length).toBe(2);
  });

  test("collapses a roll-call line followed by its matching summary tally", () => {
    const doc = "Roll call: Alpha: Yea, Beta: Nay, Gamma: Yea, Delta: Abstain.\n\nVote: 2 yea, 1 nay, 1 abstain. Motion carries.";
    const votes = extractVotes(doc);
    expect(votes.length).toBe(1);
    expect(votes[0]!.yea).toBe(2);
    expect(votes[0]!.abstain).toBe(1);
    expect(votes[0]!.passed).toBe(true);
  });

  test("the R3 non-vote lines produce no votes at all", () => {
    for (const line of NON_VOTE_LINES) {
      expect(parseVotes(line)).toBeNull();
      expect(extractVotes(line)).toEqual([]);
    }
    expect(extractVotes(NON_VOTE_LINES.join("\n\n"))).toEqual([]);
  });

  test("a real motion tally still parses, with confidence and separated absences", () => {
    const vote = parseVotes("The motion to approve the lease carries 4-1.")!;
    expect(vote).not.toBeNull();
    expect(vote.yea).toBe(4);
    expect(vote.nay).toBe(1);
    expect(vote.confidence).toBeGreaterThan(0);
    expect(vote.passed).toBe(true);
    expect(vote.inferred).toBe(false);
    expect(vote.details.some(detail => detail.startsWith("Source: "))).toBe(true);
  });

  test("absent is counted apart from abstain", () => {
    const abstained = parseVotes("Vote: 3 yea, 1 nay, 1 abstain.")!;
    expect(abstained.abstain).toBe(1);
    expect(abstained.absent).toBe(0);
    const away = parseVotes("Vote: 3 yea, 1 nay, 1 absent.")!;
    expect(away.absent).toBe(1);
    expect(away.abstain).toBe(0);
  });
});

describe("fetchDocumentText content-type gate", () => {
  test("only verifiably textual bodies are read", () => {
    expect(isTextualContentType("text/html; charset=utf-8")).toBe(true);
    expect(isTextualContentType("text/plain")).toBe(true);
    expect(isTextualContentType("application/json")).toBe(true);
    expect(isTextualContentType("application/pdf")).toBe(false);
    expect(isTextualContentType("application/octet-stream")).toBe(false);
    expect(isTextualContentType("image/png")).toBe(false);
    // Unverifiable is treated as binary: decoding a PDF and regexing it for
    // tallies invents votes out of font tables.
    expect(isTextualContentType(null)).toBe(false);
    expect(isTextualContentType("")).toBe(false);
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

describe("meeting doc-hash baseline persistence", () => {
  test("save then load round-trips the per-URL map, not the envelope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doc-hashes-"));
    try {
      const path = join(dir, "meeting-doc-hashes.json");
      const hashes = await computeDocumentHashes([
        { url: "https://example.test/agenda.html", text: "agenda v1" },
        { url: "https://example.test/minutes.html", text: "minutes v1" },
      ]);
      await saveMeetingDocHashes(hashes, path);
      const loaded = await loadMeetingDocHashes(path);
      expect(loaded).toEqual(hashes);
      // The savedAt envelope key must never leak into the hash map.
      expect(Object.keys(loaded)).not.toContain("savedAt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a partial refetch preserves the entries it did not re-fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doc-hashes-"));
    try {
      const path = join(dir, "meeting-doc-hashes.json");
      const previous = await computeDocumentHashes([
        { url: "https://example.test/agenda.html", text: "agenda v1" },
        { url: "https://example.test/minutes.html", text: "minutes v1" },
      ]);
      await saveMeetingDocHashes(previous, path);

      // Second cycle: only the agenda came back (the minutes PDF was skipped).
      const current = await computeDocumentHashes([
        { url: "https://example.test/agenda.html", text: "agenda v2" },
      ]);
      await saveMeetingDocHashes({ ...(await loadMeetingDocHashes(path)), ...current }, path);

      const merged = await loadMeetingDocHashes(path);
      expect(merged["https://example.test/agenda.html"]).toBe(current["https://example.test/agenda.html"]);
      expect(merged["https://example.test/minutes.html"]).toBe(previous["https://example.test/minutes.html"]);
      // With the baseline preserved, the minutes document is not resurrected as new.
      const drift = diffDocumentHashes(merged, await computeDocumentHashes([
        { url: "https://example.test/minutes.html", text: "minutes v1" },
      ]));
      expect(drift[0]!.isNew).toBe(false);
      expect(drift[0]!.changed).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing baseline file loads as an empty map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doc-hashes-"));
    try {
      expect(await loadMeetingDocHashes(join(dir, "absent.json"))).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
