/**
 * SYNTHETIC FIXTURE — clearly labeled, written by hand for offline testing.
 *
 * This minutes document is NOT a transcript of any real government meeting.
 * Names, motions, and vote tallies are invented for parser verification.
 * Modeled structurally on public-domain US city-council minutes conventions
 * (numbered agenda items, "Motion/Second", "Vote: X yea, Y nay, Z abstain",
 * roll-call lines), which are not copyrightable facts.
 */
export const SYNTHETIC_MINUTES_FIXTURE = `MINUTES OF THE SYNTHETIC CITY COUNCIL (FIXTURE)
Regular Meeting - January 15, 2026 - 6:00 PM
Synthetic City Hall, 100 Example Street

1. CALL TO ORDER
The meeting was called to order at 6:02 PM by Mayor Testperson.

2. APPROVAL OF PREVIOUS MINUTES
Motion to approve the minutes of December 18, 2025 was made by Councilmember
Alpha, seconded by Councilmember Beta.
Vote: 5 yea, 0 nay, 0 abstain. Motion carries.

3. CONSENT AGENDA
Motion to approve the consent agenda (items 3a-3e) made by Councilmember
Gamma, seconded by Councilmember Alpha.
Vote: 4 yea, 1 nay, 0 abstain. Motion passes.

4. OLD BUSINESS
a. Ordinance 2026-01 - Funding for the Example Street repaving project.
Councilmember Delta moved adoption; Councilmember Beta seconded.
Roll call: Alpha: Yea, Beta: Nay, Gamma: Yea, Delta: Abstain, Mayor Testperson: Yea.
Vote: 3 yea, 1 nay, 1 abstain. Motion carries.

b. Resolution 2026-07 - Opposing the proposed regional waste transfer fee.
Motion failed 2 yea, 3 nay, 0 abstain.

5. PUBLIC COMMENT
Three speakers addressed the Council. No vote was taken.

6. ADJOURNMENT
The meeting adjourned at 7:41 PM.
`;

/**
 * Expected extractions from the synthetic fixture, in document order.
 * Derived by hand from the labeled fixture text above (not from any live source).
 */
export const EXPECTED_FIXTURE_VOTES = [
  { yea: 5, nay: 0, abstain: 0, passed: true },
  { yea: 4, nay: 1, abstain: 0, passed: true },
  { yea: 3, nay: 1, abstain: 1, passed: true },
  { yea: 2, nay: 3, abstain: 0, passed: false },
];
