/**
 * Regression test for a real key-disclosure vulnerability found by a
 * cross-vendor audit on 2026-07-24: `serveIndexHtml()` used to decide
 * whether to inject the live API key by calling `resolveIp(req, socketIp)`,
 * which prefers the client-supplied `X-Forwarded-For`/`X-Real-IP` headers
 * over the real socket address. A remote attacker sending
 * `X-Forwarded-For: 127.0.0.1` was classified as trusted-local and handed
 * the real key in page source — reproduced live with
 * `curl -H "X-Forwarded-For: 127.0.0.1"` against a real running server.
 *
 * The fix changed `serveIndexHtml`'s signature to take a raw `socketIp`
 * string directly instead of a `Request` — there is no `Request` object for
 * a header to hide in, so this is structurally, not just behaviorally, safe:
 * there is no code path by which a header could reach this decision at all.
 */
import { describe, test, expect } from "bun:test";
import { serveIndexHtml } from "../src/gui/server.ts";

async function keyInPage(socketIp: string | undefined): Promise<string> {
  const res = await serveIndexHtml(socketIp);
  const html = await res.text();
  const match = html.match(/__CC_API_KEY__ = "([^"]*)"/);
  return match?.[1] ?? "";
}

describe("serveIndexHtml — API key injection trust boundary", () => {
  test("a real loopback socket IP gets the real key", async () => {
    const key = await keyInPage("127.0.0.1");
    expect(key).not.toBe("");
    expect(key).not.toBe("__CC_API_KEY_INJECT__");
  });

  test("a real private-LAN socket IP gets the real key", async () => {
    expect(await keyInPage("192.168.1.50")).not.toBe("");
    expect(await keyInPage("10.0.0.5")).not.toBe("");
    expect(await keyInPage("172.20.0.5")).not.toBe(""); // 172.16.0.0/12
  });

  test("a genuinely remote socket IP does NOT get the key, regardless of what it 'looks like'", async () => {
    // These are exactly the values an attacker would try to spoof via
    // X-Forwarded-For under the old vulnerable code path — but this
    // function has no Request/headers parameter, so there is nothing to spoof.
    expect(await keyInPage("203.0.113.42")).toBe("");
  });

  test("an unknown/absent socket IP does NOT get the key", async () => {
    expect(await keyInPage(undefined)).toBe("");
  });
});
