/** Actual CLI and private filesystem evidence; no generation, fake review or service calls. */
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBoundedChild } from "../src/shared/subprocess.ts";
import type { SemanticReviewInput } from "../src/llm/semantic_review.ts";

test("actual review CLI creates private pending evidence and refuses overwrite or irrelevant flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-review-cli-"));
  const input = join(root, "input.json"), bundle = join(root, "package.json"), assessment = join(root, "assessment.json");
  const fixture = await Bun.file("tests/fixtures/semantic-review-v1.json").json() as { cases: Array<{ input: SemanticReviewInput }> };
  const run = (...args: string[]) => runBoundedChild([process.execPath, "run", "src/llm/index.ts", ...args], { timeoutMs: 10_000, maxBytes: 32_000 });
  try {
    await writeFile(input, JSON.stringify(fixture.cases[0]!.input), { flag: "wx", mode: 0o600 });
    const created = await run("review-package", input, bundle);
    expect(created).toMatchObject({ status: "ok", reaped: true, exitCode: 0 });
    expect((await stat(bundle)).mode & 0o777).toBe(0o600);
    const retained = await readFile(bundle);
    expect((await run("review-assess", bundle, assessment)).status).toBe("ok");
    const result = JSON.parse(await readFile(assessment, "utf8"));
    expect(result.workflowStatus).toBe("pending-review"); expect(result.reviewerLabel).toBeNull(); expect(result.verifiedFactuality).toBe(false);
    expect((await run("review-package", input, bundle)).status).toBe("failed"); expect(await readFile(bundle)).toEqual(retained);
    const unused = join(root, "unused.json");
    expect((await run("review-package", input, unused, "--deadline-ms=10")).status).toBe("failed"); expect(await Bun.file(unused).exists()).toBe(false);
    expect((await run("review-assess", bundle, unused, "--unexpected")).status).toBe("failed"); expect(await Bun.file(unused).exists()).toBe(false);
    expect(created.stdout.includes(fixture.cases[0]!.input.answer)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
