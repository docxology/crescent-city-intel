/** Interactive launcher delegates every operation to the declared Bun scripts. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
interface Package { version: string; scripts: Record<string, string> }
const packageFile = join(import.meta.dir, "..", "package.json");
const pkg = JSON.parse(readFileSync(packageFile, "utf8")) as Package;
const choices = ["setup", "gui", "scrape", "verify", "export", "all", "weekly-check", "source-discovery", "alerts", "news", "gov-meetings", "youtube", "events", "curate", "index", "chat", "coverage", "readability", "report", "analytics", "insights", "pages:seed", "pages:export", "pages:validate", "manuscript:check", "manuscript:hydrate", "geo:intel", "geo:observations", "validate", "test:typecheck", "test:browser", "test"];
export async function runProjectCommand(name: string, args: string[] = []): Promise<number> {
  if (name === "setup") {
    for (const argv of [[process.execPath, "install", "--frozen-lockfile"], [process.execPath, "run", "source-discovery"]]) {
      const child = Bun.spawn(argv, { cwd: join(import.meta.dir, ".."), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      const code = await child.exited; if (code) return code;
    }
    return 0;
  }
  if (!Object.hasOwn(pkg.scripts, name)) { console.error(`Unknown project command: ${name}. Choose a package.json script.`); return 2; }
  const child = Bun.spawn([process.execPath, "run", name, ...args], { cwd: join(import.meta.dir, ".."), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return child.exited;
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args[0]) process.exit(await runProjectCommand(args[0], args.slice(1)));
  console.log(`The Quadruplicate v${pkg.version}\nCrescent City civic intelligence`);
  choices.forEach((name, index) => console.log(`${index + 1}. ${name}`));
  const answer = prompt("Choose a number or command (Enter to quit):")?.trim();
  if (!answer) process.exit(0);
  const name = /^\d+$/.test(answer) ? choices[Number(answer) - 1] : answer;
  if (!name) process.exit(2);
  process.exit(await runProjectCommand(name));
}
