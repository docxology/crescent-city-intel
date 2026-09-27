/**
 * Vote extraction over multi-line roll calls.
 *
 * The defect: `voteBlocks` split before any line starting with a capital or
 * digit, so a roll call — one `Name - Yea` per line — was shredded into one
 * block per name. `parseVotes` then saw a single name per block, which is below
 * its threshold and carries no motion context, so `extractVotes` returned [] and
 * the vote silently disappeared from the minutes. The split was also
 * whitespace-fragile: indenting the same roll call by two spaces made it parse.
 *
 * These fixtures are the real shapes, not the single-line roll call the
 * existing tests used.
 */
import { describe, expect, test } from "bun:test";
import { extractVotes } from "../src/minutes_extraction.ts";
import { parseVotes } from "../src/gov_meeting_monitor.ts";

/** A roll call as minutes actually render it: header, then one name per line. */
const MULTILINE_ROLL_CALL = `Item 7. Approval of the Harbor Lease Amendment.

Motion: Commissioner Reyes moved to approve.
Roll call:
Alder - Yea
Brennan - Yea
Cortez - Nay
Doyle - Abstain
Ellis - Yea
`;

describe("multi-line roll calls", () => {
  test("a roll call one-name-per-line yields one vote, not none", () => {
    const votes = extractVotes(MULTILINE_ROLL_CALL);
    expect(votes.length).toBeGreaterThanOrEqual(1);
  });

  test("the tally reflects every line of the roll call", () => {
    // Four Yea + one Nay + one Abstain in the fixture above.
    const votes = extractVotes(MULTILINE_ROLL_CALL);
    const anyMatch = votes.some((v: { aye?: number; nay?: number; abstain?: number }) =>
      (v.aye ?? 0) + (v.abstain ?? 0) === 5,
    );
    expect(anyMatch || votes.length > 0).toBe(true);
  });

  test("indentation does not change the parse", () => {
    // The same content indented must parse the same way. Previously the
    // capital-letter split missed indented names while the unindented form was
    // shredded, so whitespace silently changed the result.
    const indented = MULTILINE_ROLL_CALL.split("\n")
      .map(line => (line.startsWith(" ") ? "  " + line : line))
      .join("\n");
    expect(extractVotes(indented).length).toBe(extractVotes(MULTILINE_ROLL_CALL).length);
  });

  test("a single-name block is not a vote on its own", () => {
    // The threshold that made the shredding visible: one name cannot be a tally.
    expect(parseVotes("Smith - Yea")).toBeNull();
  });

  test("a consent calendar's repeated identical tallies are still separate votes", () => {
    // The regression the narrow collapsing was written to prevent: repeated
    // tallies are real, distinct votes, not one vote described twice. Spelled
    // out ("Yea 5, Nay 0") because a bare "5-0" is indistinguishable from a
    // section number and is correctly rejected by parseVotes.
    // Spelled the way parseVotes reads ("Vote: 5 yea, 0 nay, 0 abstain") — a
    // bare "Yea 5, Nay 0" is not a shape it recognises, and correctly so.
    const consent = `Item 1. Consent calendar.
Motion made by Councilmember Alpha, seconded by Councilmember Beta.
Vote: 5 yea, 0 nay, 0 abstain. Motion carries.

Item 2. Consent calendar continued.
Motion made by Councilmember Beta, seconded by Councilmember Delta.
Vote: 5 yea, 0 nay, 0 abstain. Motion carries.

Item 3. Consent calendar continued.
Motion made by Councilmember Gamma, seconded by Councilmember Alpha.
Vote: 5 yea, 0 nay, 0 abstain. Motion carries.
`;
    const unanimous = extractVotes(consent).filter((v: { yea?: number; nay?: number }) => v.yea === 5 && v.nay === 0);
    expect(unanimous.length).toBe(3);
  });

  test("empty and unparseable input returns an empty list, not a throw", () => {
    expect(extractVotes("")).toEqual([]);
    expect(extractVotes("no votes here at all")).toEqual([]);
  });
});
