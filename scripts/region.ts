import { fileURLToPath } from "node:url";
import { runRegionalCli } from "region-intel/cli";
await runRegionalCli({ root: fileURLToPath(new URL("../", import.meta.url)), args: Bun.argv.slice(2).filter(arg => arg !== "--") });
