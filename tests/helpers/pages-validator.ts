/** Execute the actual Pages CLI with owned, bounded pipes and child-only fixture admission. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBoundedChild, type ChildResult } from "../../src/shared/subprocess.ts";

const repository = resolve(import.meta.dir, "../..");
const validator = resolve(repository, "scripts/validate-pages.ts");
const bootstrap = `process.env.CC_TEST_FIXTURE = "1"; console.log("CCI-PAGES-VALIDATOR-READY"); await import(${JSON.stringify(pathToFileURL(validator).href)});`;

export async function runPagesValidator(destination: string, timeoutMs = 5000): Promise<ChildResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5000) throw new Error("Invalid Pages fixture child deadline");
  // Bun's eval argv retains these positional arguments as [bun, script, destination].
  // The fixed import runs the real CLI after setting its fixture environment;
  // the test process environment and concurrent tests remain untouched.
  return await runBoundedChild([process.execPath, "--eval", bootstrap, "--", validator, destination], {
    cwd: repository, timeoutMs, maxBytes: 1024 * 1024,
  });
}
