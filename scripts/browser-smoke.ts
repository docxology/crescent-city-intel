#!/usr/bin/env bun
/**
 * Real browser smoke test (Playwright + headless Chromium) — thin entry point.
 * The smoke flow itself lives in src/browser_smoke.ts.
 *
 * Run with: bun run test:browser
 */
import { runBrowserSmoke } from "../src/browser_smoke.ts";

await runBrowserSmoke();
