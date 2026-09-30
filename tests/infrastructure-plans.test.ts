import { describe, expect, test } from "bun:test";
import { renderSchedulerPlan, shellArgument } from "../src/scheduler.ts";
import { checkStackReadiness } from "../src/stack_readiness.ts";
import { readFileSync } from "node:fs";
describe("scheduler and service readiness", () => {
  test("launchd uses XML-escaped argv and cron escapes shell arguments and percent", () => {
    const project = `/tmp/a & <b> ' $() \`literal\` 50%`; const bun = `/tmp/bun ' executable`;
    const launchd = renderSchedulerPlan({ project, bun, platform: "darwin" });
    expect(launchd.content).toContain("&amp;"); expect(launchd.content).toContain("&apos;"); expect(launchd.content).toContain("&lt;b&gt;"); expect(launchd.content).not.toContain("<string>-c</string>");
    const cron = renderSchedulerPlan({ project, bun, platform: "linux" }); expect(cron.content).toContain("CRON_TZ=America/Los_Angeles"); expect(cron.content).toContain("50\\%");
    const child = Bun.spawnSync(["/bin/sh", "-c", `printf '%s' ${shellArgument(project)}`], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0); expect(child.stdout.toString()).toBe(project);
    expect(() => renderSchedulerPlan({ project: "bad\npath", bun, platform: "linux" })).toThrow();
  });
  test("real local HTTP readiness distinguishes missing models, complete stack and failed heartbeat", async () => {
    let heartbeat = true; let models = ["nomic-embed-text:latest"];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { return new URL(request.url).pathname === "/api/tags" ? Response.json({ models: models.map(name => ({ name })) }) : heartbeat ? Response.json({ "nanosecond heartbeat": Date.now() }) : new Response("unavailable", { status: 503 }); } });
    try {
      const options = { ollama: `http://127.0.0.1:${server.port}`, chroma: `http://127.0.0.1:${server.port}`, models: ["nomic-embed-text", "gemma3:4b"], timeoutMs: 500 };
      expect((await checkStackReadiness(options)).missingModels).toEqual(["gemma3:4b"]);
      models.push("gemma3:4b"); expect((await checkStackReadiness(options)).ready).toBe(true);
      heartbeat = false; const receipt = await checkStackReadiness(options); expect(receipt.ready).toBe(false); expect(receipt.chroma).toBe(false);
    } finally { server.stop(true); }
  });
  test("oversized service bodies and successful wrong-shaped responses are unavailable", async () => {
    let oversized = true;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => oversized ? new Response("x".repeat(512)) : Response.json({ ready: true }) });
    try {
      const options = { ollama: `http://127.0.0.1:${server.port}`, chroma: `http://127.0.0.1:${server.port}`, models: [], timeoutMs: 500, maxBytes: 128 };
      expect((await checkStackReadiness(options)).ready).toBe(false);
      oversized = false; const result = await checkStackReadiness(options); expect(result.ollama).toBe(false); expect(result.chroma).toBe(false);
    } finally { server.stop(true); }
  });
  test("Compose uses the runtime CHAT_MODEL contract for GUI, bootstrap and readiness", () => {
    const value = Bun.YAML.parse(readFileSync("docker-compose.yml", "utf8")) as any;
    for (const name of ["gui", "ollama-models", "readiness"]) expect(value.services[name].environment.CHAT_MODEL).toBe("${CHAT_MODEL:-gemma3:4b}");
    expect(value.services["ollama-models"].command[0]).toContain('"$$CHAT_MODEL"');
    expect(readFileSync("scripts/stack-readiness.ts", "utf8")).toContain("process.env.CHAT_MODEL");
  });
});
