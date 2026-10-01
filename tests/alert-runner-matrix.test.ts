/** Every singleton uses real modules and one explicit HTTP fixture; no fetch/module mocks. */
import { test, expect } from "bun:test";
import { runAllAlertMonitors } from "../src/alerts/batch.ts";
import { MONITOR_KEYS, ALERT_MONITOR_SOURCE_NAMES } from "../src/alerts/composite.ts";
import { resetConnectorState } from "../src/alerts/connector.ts";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeBrowser } from "../src/browser.ts";
import { withOutputRoot } from "../src/shared/paths.ts";
import { NWS_ALERTS_URL } from "../src/constants.ts";
const origins = ["https://api.weather.gov", "https://earthquake.usgs.gov", "https://files.airnowtech.org", "https://incidents.fire.ca.gov", "https://www.ndbc.noaa.gov", "https://api.tidesandcurrents.noaa.gov", "https://wildlife.ca.gov", "https://usdmdataservices.unl.edu", "https://pgealerts.alerts.pge.com", "https://satepsanone.nesdis.noaa.gov", "https://roads.dot.ca.gov", "https://www.dnusd.org", "https://www.navcen.uscg.gov", "https://public.mygov.us", "https://www.ccharbor.com", "https://www.eia.gov", "https://reports.psmfc.org", "https://meri.digitraffic.fi"];
test("all twenty singleton failures persist actual selected attempts without freshening omitted evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-alert-matrix-"));
  const server = Bun.serve({ port: 0, fetch() { return new Response("Recorded acquisition failure", { status: 503 }); } });
  const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: origins };
  const headless = process.env.HEADLESS_BROWSER, air = process.env.AIRNOW_API_KEY, ais = process.env.AIS_FEED_URL;
  process.env.HEADLESS_BROWSER = "1"; delete process.env.AIRNOW_API_KEY; delete process.env.AIS_FEED_URL;
  try {
    let previous: Array<{ source: string; checkedAt: string }> = [];
    for (const key of MONITOR_KEYS) {
      resetConnectorState();
      const health = await runAllAlertMonitors({ only: [key], notifications: false, outputDir: root, deadlineMs: 20_000, fixture });
      const receipt = JSON.parse(await readFile(join(root, "state", "latest-alert-run.json"), "utf8"));
      expect(receipt.status).toBe("complete"); expect(receipt.requested).toEqual([key]); expect(receipt.outcomes).toHaveLength(1); expect(receipt.outcomes[0].key).toBe(key);
      const name = ALERT_MONITOR_SOURCE_NAMES[MONITOR_KEYS.indexOf(key)]!;
      expect(health.find(row => row.source === name)!.status).toBe("unavailable");
      for (const old of previous.filter(row => row.source !== name)) expect(health.find(row => row.source === old.source)!.checkedAt).toBe(old.checkedAt);
      previous = health;
    }
    await expect(runAllAlertMonitors({ only: [], notifications: false, outputDir: root, fixture })).rejects.toThrow("nonempty");
    await expect(runAllAlertMonitors({ only: ["unknown" as typeof MONITOR_KEYS[number]], outputDir: root, fixture })).rejects.toThrow("known");
  } finally {
    await withOutputRoot(root, closeBrowser); server.stop(true);
    for (const [key, value] of [["HEADLESS_BROWSER", headless], ["AIRNOW_API_KEY", air], ["AIS_FEED_URL", ais]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
test("mixed real successful producers serialize same-root runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-alert-mixed-"));
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ type: "FeatureCollection", features: [] }); } });
  const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: origins };
  try {
    const a = await runAllAlertMonitors({ only: ["tsunami", "earthquake", "weather"], notifications: false, outputDir: root, fixture });
    expect(a.filter(row => row.status === "empty")).toHaveLength(3);
    expect(a.find(row => row.source === "NWS Weather")!.url).toBe(NWS_ALERTS_URL);
    await Promise.all([runAllAlertMonitors({ only: ["tsunami"], notifications: false, outputDir: root, fixture }), runAllAlertMonitors({ only: ["earthquake"], notifications: false, outputDir: root, fixture })]);
    expect(JSON.parse(await readFile(join(root, "state", "latest-alert-run.json"), "utf8")).status).toBe("complete");
    const other = await mkdtemp(join(tmpdir(), "cci-alert-other-"));
    try { await Promise.all([runAllAlertMonitors({ only: ["tsunami"], notifications: false, outputDir: root, fixture }), runAllAlertMonitors({ only: ["weather"], notifications: false, outputDir: other, fixture })]); expect(JSON.parse(await readFile(join(other, "state", "latest-alert-run.json"), "utf8")).requested).toEqual(["weather"]); }
    finally { await rm(other, { recursive: true, force: true }); }
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
test('failed refresh cannot reuse a retained warning, and cancellation records interruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cci-alert-old-warning-'));
  let mode: 'failed' | 'stalled' = 'failed'; let requestObserved!: () => void;
  const observed = new Promise<void>(resolve => { requestObserved = resolve; });
  const server = Bun.serve({ port: 0, fetch() { if (mode === 'failed') return new Response('Recorded acquisition failure', { status: 503 }); requestObserved(); return new Promise<Response>(() => {}); } });
  const fixture = { origin: `http://127.0.0.1:${server.port}`, allowedOrigins: origins };
  const currentPath = join(root, 'alerts', 'weather', 'current.json');
  try {
    await mkdir(join(root, 'alerts', 'weather'), { recursive: true });
    const priorBytes = JSON.stringify({ fetchedAt: new Date().toISOString(), alerts: [{ severityLevel: 'warning', event: 'High Wind Warning' }] });
    await writeFile(currentPath, priorBytes);
    await runAllAlertMonitors({ only: ['weather'], notifications: false, outputDir: root, fixture });
    const composite = JSON.parse(await readFile(join(root, 'alerts', 'composite', 'current.json'), 'utf8'));
    expect(composite.level).not.toBe('WARNING'); expect(composite.hasUnavailableMonitors).toBe(true);
    expect(await readFile(currentPath, 'utf8')).toBe(priorBytes);
    mode = 'stalled'; const controller = new AbortController();
    const pending = runAllAlertMonitors({ only: ['weather'], notifications: false, outputDir: root, fixture, signal: controller.signal });
    await observed; controller.abort(new Error('Recorded cancellation'));
    await expect(pending).rejects.toThrow();
    expect(JSON.parse(await readFile(join(root, 'state', 'latest-alert-run.json'), 'utf8')).status).toBe('interrupted');
    expect(await readFile(currentPath, 'utf8')).toBe(priorBytes);
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);
