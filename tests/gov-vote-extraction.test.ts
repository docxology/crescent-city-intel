/**
 * Tests for parseVotes in src/gov_meeting_monitor.ts
 *
 * Tests various vote tally patterns found in meeting minutes and agendas:
 * - "Vote: X yea, Y nay, Z abstain" patterns
 * - "Motion passes X-Y" / "Motion fails X-Y"
 * - Roll call patterns
 * - Simple "X yea, Y nay" without the word Vote
 * - Edge cases: empty text, null, unparseable text
 */
import { describe, expect, test } from "bun:test";
import { parseVotes } from "../src/gov_meeting_monitor";

describe("parseVotes", () => {
  // ─── "Vote: X yea, Y nay, Z abstain" pattern ────────────────────

  test("parses standard 'Vote: X yea, Y nay, Z abstain' pattern", () => {
    const result = parseVotes("The motion was called. Vote: 5 yea, 2 nay, 0 abstain.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(5);
    expect(result!.nay).toBe(2);
    expect(result!.abstain).toBe(0);
    expect(result!.passed).toBe(true);
    expect(result!.details.length).toBeGreaterThanOrEqual(1);
  });

  test("parses 'X ayes, Y noes, Z abstentions' variant", () => {
    const result = parseVotes("Vote: 5 ayes, 3 noes, 1 abstention.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(5);
    expect(result!.nay).toBe(3);
    expect(result!.abstain).toBe(1);
    expect(result!.passed).toBe(true);
  });

  test("parses vote where yea=nay (tie, passes=false)", () => {
    const result = parseVotes("Vote: 3 yea, 3 nay, 0 abstain.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(3);
    expect(result!.nay).toBe(3);
    expect(result!.passed).toBe(false);
  });

  test("parses losing vote", () => {
    const result = parseVotes("Vote: 2 yea, 5 nay, 0 abstain.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(2);
    expect(result!.nay).toBe(5);
    expect(result!.passed).toBe(false);
  });

  // ─── "Motion passes X-Y" / "Motion fails X-Y" pattern ───────────

  test("parses 'Motion passes X-Y' pattern", () => {
    const result = parseVotes("Motion passes 5-2. The proposal is approved.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(5);
    expect(result!.nay).toBe(2);
    expect(result!.passed).toBe(true);
    expect(result!.abstain).toBe(0);
  });

  test("parses 'Motion failed X-Y' pattern", () => {
    const result = parseVotes("Motion failed 2-5.");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.yea).toBe(2);
    expect(result!.nay).toBe(5);
  });

  test("parses 'Motion carried X-Y' pattern", () => {
    const result = parseVotes("Motion carried 7-0.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(7);
    expect(result!.nay).toBe(0);
    expect(result!.passed).toBe(true);
  });

  // A verb next to two numbers is not evidence of a vote. "Minutes ... were
  // approved 2026-08-12" and "Resolution 2026-015 approved 2026-3" both used to
  // parse as tallies, so an X-Y reading now requires explicit motion context.
  test("a bare 'Approved X-Y' with no motion context is not a vote", () => {
    expect(parseVotes("Approved 5-0.")).toBeNull();
    expect(parseVotes("Denied 3-2.")).toBeNull();
  });

  test("the same tallies inside motion context do parse", () => {
    const approved = parseVotes("Motion approved 5-0.");
    expect(approved).not.toBeNull();
    expect(approved!.yea).toBe(5);
    expect(approved!.nay).toBe(0);
    expect(approved!.passed).toBe(true);

    const denied = parseVotes("The motion was denied 3-2.");
    expect(denied).not.toBeNull();
    expect(denied!.yea).toBe(3);
    expect(denied!.nay).toBe(2);
    expect(denied!.passed).toBe(false);
  });

  test("year- and ordinance-shaped number pairs are never read as tallies", () => {
    // A motion here really was approved, so an outcome may be recorded — but
    // the pair after the verb is a date, and no tally may be invented from it.
    const dateShaped = parseVotes("Motion approved 2026-08.");
    expect(dateShaped?.yea ?? 0).toBe(0);
    expect(dateShaped?.nay ?? 0).toBe(0);
    // With no motion under discussion at all, there is nothing to record.
    expect(parseVotes("Resolution 2026-015 approved 2026-3.")).toBeNull();
    expect(parseVotes("Minutes of the August 12 meeting were approved 2026-08-12.")).toBeNull();
  });

  // ─── Simple tally without "Vote:" label ─────────────────────────

  test("parses simple 'X yea, Y nay' without 'Vote:' keyword", () => {
    const result = parseVotes("The council voted: 4 yea, 1 nay.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(4);
    expect(result!.nay).toBe(1);
    expect(result!.passed).toBe(true);
  });

  test("parses 'X aye, Y no' without prefix", () => {
    const result = parseVotes("The meeting minutes record 3 aye, 2 no.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(3);
    expect(result!.nay).toBe(2);
    expect(result!.passed).toBe(true);
  });

  // ─── Roll call pattern ─────────────────────────────────────────

  test("parses roll call vote results", () => {
    const result = parseVotes("Councilmember Smith: Yea, Councilmember Jones: Yea, Councilmember Brown: Nay, Councilmember Davis: Abstain.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(2);
    expect(result!.nay).toBe(1);
    expect(result!.abstain).toBe(1);
  });

  test("parses roll call with dash separator", () => {
    const result = parseVotes("Smith - Yea / Jones - Yea / Brown - Nay");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(2);
    expect(result!.nay).toBe(1);
    expect(result!.abstain).toBe(0);
  });

  // ─── Unanimous / vote without numbers ──────────────────────────

  test("detects unanimous approval without numbers", () => {
    const result = parseVotes("The motion was unanimously approved.");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  test("detects motion denied/rejected without numbers", () => {
    const result = parseVotes("The motion was denied.");
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
  });

  // ─── Edge cases / graceful degradation ──────────────────────────

  test("returns null on empty string", () => {
    expect(parseVotes("")).toBeNull();
  });

  test("returns null on whitespace-only string", () => {
    expect(parseVotes("   ")).toBeNull();
  });

  test("returns null on null", () => {
    expect(parseVotes(null as unknown as string)).toBeNull();
  });

  test("returns null on undefined", () => {
    expect(parseVotes(undefined as unknown as string)).toBeNull();
  });

  test("returns null on unparseable text", () => {
    expect(parseVotes("The meeting was called to order at 7:00 PM.")).toBeNull();
  });

  test("returns null on agenda item without vote", () => {
    expect(parseVotes("Discussion of the proposed budget amendment. Staff presentation.")).toBeNull();
  });

  // ─── Mixed / complex real-world text ────────────────────────────

  test("parses vote embedded in longer minutes text", () => {
    const text = `City Council Meeting - March 18, 2026\nItem 7: Consideration of Resolution 2026-015\nCouncilmember Smith made a motion, seconded by Councilmember Jones.\nVote: 5 yea, 2 nay, 0 abstain. The motion carried.`;
    const result = parseVotes(text);
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(5);
    expect(result!.nay).toBe(2);
    expect(result!.abstain).toBe(0);
    expect(result!.passed).toBe(true);
  });

  test("handles both vote tally and motion outcome consistently", () => {
    const result = parseVotes("Vote: 5 yea, 2 nay, 0 abstain. Motion passes 5-2.");
    expect(result).not.toBeNull();
    expect(result!.yea).toBe(5);
    expect(result!.nay).toBe(2);
    expect(result!.abstain).toBe(0);
    expect(result!.passed).toBe(true);
  });

  test("'Passed X-Y' with no motion context yields nothing rather than a guess", () => {
    expect(parseVotes("Passed 5-0.")).toBeNull();
    const inContext = parseVotes("The motion passed 5-0.");
    expect(inContext).not.toBeNull();
    expect(inContext!.yea).toBe(5);
    expect(inContext!.nay).toBe(0);
  });

  test("handles multiple details without duplicates", () => {
    const text = "Vote: 5 yea, 2 nay, 0 abstain. Motion passes 5-2.";
    const result = parseVotes(text);
    expect(result).not.toBeNull();
    // details should have both entries
    expect(result!.details.length).toBeGreaterThanOrEqual(1);
    // no duplicate strings
    expect(new Set(result!.details).size).toBe(result!.details.length);
  });
});
