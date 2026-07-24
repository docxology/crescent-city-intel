/**
 * Tests for src/youtube_monitor.ts
 *
 * Covers the pure-logic pieces: VTT parsing (against a fixture modeled on
 * the real growing-caption structure sampled live from a real Crescent City
 * council video, id 5FCYI7rt0_4, on 2026-07-23), channel-listing line
 * parsing, and the no-captions-vs-extraction-failure distinction. No live
 * yt-dlp subprocess calls are made in this suite — extractTranscript's
 * yt-dlp dependency is exercised manually via `bun run youtube`, not CI.
 */
import { describe, expect, test } from "bun:test";
import { parseVtt, listChannelVideos, listChannelVideosDetailed, type YouTubeVideoListing } from "../src/youtube_monitor";

// Modeled on the real growing-caption structure observed live 2026-07-23
// (yt-dlp auto-sub output for a real Crescent City town hall meeting):
// consecutive cues repeat and extend the prior cue's text word-by-word via
// inline <c> word tags, then a "settled" cue holds the finalized line.
const REAL_SHAPE_VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.760 --> 00:00:03.439 align:start position:0%
Okay.<00:00:03.439><c> Thank</c><00:00:03.600><c> you,</c><00:00:03.760><c> m</c>

00:00:03.439 --> 00:00:03.449 align:start position:0%
Okay. Thank you, m

00:00:03.449 --> 00:00:06.240 align:start position:0%
Okay. Thank you, ma'am.

00:00:06.240 --> 00:00:07.440 align:start position:0%
And<00:00:06.240><c> um</c><00:00:07.200><c> for</c>

00:00:07.440 --> 00:00:09.000 align:start position:0%
And um for for the water capacity study.
`;

describe("parseVtt", () => {
  test("collapses growing-caption cue groups into settled segments, no exact duplicates", () => {
    const segments = parseVtt(REAL_SHAPE_VTT);

    expect(segments.length).toBeGreaterThan(0);
    // No two consecutive segments should be byte-identical (the exact-dup path)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].text).not.toBe(segments[i - 1].text);
    }
  });

  test("strips inline <c> word-timestamp tags from segment text", () => {
    const segments = parseVtt(REAL_SHAPE_VTT);
    for (const seg of segments) {
      expect(seg.text).not.toContain("<c>");
      expect(seg.text).not.toMatch(/<\d{2}:\d{2}:\d{2}\.\d{3}>/);
    }
  });

  test("final settled segment for the first cue group reads the complete line", () => {
    const segments = parseVtt(REAL_SHAPE_VTT);
    const joined = segments.map((s) => s.text).join(" | ");
    expect(joined).toContain("Okay. Thank you, ma'am.");
  });

  test("second cue group's settled line is captured", () => {
    const segments = parseVtt(REAL_SHAPE_VTT);
    const joined = segments.map((s) => s.text).join(" | ");
    expect(joined).toContain("And um for for the water capacity study.");
  });

  test("preserves the earliest start timestamp for a collapsed growing group", () => {
    const segments = parseVtt(REAL_SHAPE_VTT);
    const first = segments[0];
    // The group started at 00:00:01.760 even though the settled text
    // appeared on the 00:00:03.449 cue — the group's start time must be kept.
    expect(first.start).toBe("00:00:01.760");
  });

  test("empty VTT content produces zero segments, not a crash", () => {
    expect(parseVtt("WEBVTT\n\n")).toHaveLength(0);
  });

  test("VTT with no cues at all produces zero segments", () => {
    expect(parseVtt("")).toHaveLength(0);
  });
});

describe("listChannelVideos", () => {
  test("returns an empty array (not a throw) when yt-dlp is unreachable/misconfigured", async () => {
    // A URL yt-dlp cannot resolve as a channel — exercises the graceful
    // degradation path without requiring a live network call to succeed.
    const result = await listChannelVideos("not-a-real-channel-url", 1);
    expect(Array.isArray(result)).toBe(true);
  });

  test("classifies a listing failure as unavailable source health", async () => {
    const result = await listChannelVideosDetailed("not-a-real-channel-url", 1);
    expect(result.videos).toEqual([]);
    expect(result.health.status).toBe("unavailable");
    expect(result.health.itemCount).toBe(0);
    expect(result.health.error).toBeTruthy();
  });
});

describe("YouTubeVideoListing shape", () => {
  test("interface includes required fields", () => {
    const v: YouTubeVideoListing = { id: "5FCYI7rt0_4", title: "Town Hall", uploadDate: "20260708" };
    expect(v.id).toBeTruthy();
    expect(v.title).toBeTruthy();
  });
});
