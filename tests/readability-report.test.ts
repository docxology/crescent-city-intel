import { expect, test } from "bun:test";
import { writeReadabilityReport } from "../src/readability_report.ts";
import { withMinimalCorpus } from "./helpers/output-root.ts";
import { paths } from "../src/shared/paths.ts";
import { join } from "node:path";
test("readability snapshot and history use the isolated artifact root and one run time", async () => {
  await withMinimalCorpus(2, async root => {
    const receipt = await writeReadabilityReport({ args: ["--limit=2"] });
    const snapshot = await Bun.file(join(root, "readability.json")).json();
    expect(snapshot.computedAt).toBe(receipt.computedAt);
    expect(snapshot.totalSections).toBeGreaterThan(0);
    expect(snapshot.allScores.length).toBe(receipt.scored);
    const lines = (await Bun.file(paths.readabilityHistory).text()).trim().split("\n");
    const latest = JSON.parse(lines.at(-1)!);
    expect(JSON.stringify(latest)).toContain(receipt.computedAt);
    await expect(writeReadabilityReport({ args: ["--limit=0"] })).rejects.toThrow();
    await expect(writeReadabilityReport({ args: ["--limit=3oops"] })).rejects.toThrow();
  });
});
