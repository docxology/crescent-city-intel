/** Native HTML credential injection follows the socket, Host and normalized proxy policy. */
import { describe, test, expect } from "bun:test";
import { serveIndexHtml } from "../src/gui/server.ts";

async function keyInPage(socketIp: string | undefined): Promise<string> {
  const res = await serveIndexHtml(socketIp, new Request("http://localhost:3000"));
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

  test("a private-LAN socket never receives the local credential", async () => {
    expect(await keyInPage("192.168.1.50")).toBe("");
    expect(await keyInPage("10.0.0.5")).toBe("");
    expect(await keyInPage("172.20.0.5")).toBe(""); // 172.16.0.0/12
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

 test("loopback proxy and attacker Host cannot receive the credential", async () => {
  const attacker = await serveIndexHtml("127.0.0.1", new Request("http://attacker.example"));
  expect(await attacker.text()).not.toContain((await import("../src/api/middleware.js")).getPrimaryApiKey());
  const proxy = await serveIndexHtml("127.0.0.1", new Request("http://localhost:3000", { headers: { "X-Forwarded-For": "198.51.100.1" } }));
  expect(await proxy.text()).not.toContain((await import("../src/api/middleware.js")).getPrimaryApiKey());
  expect(proxy.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
 });

test("mapped IPv4 proxy aliases share the credential and forwarding boundary", async () => {
  const previous = process.env.CRESCENT_TRUSTED_PROXY_IPS;
  try {
    const { isTrustedProxyPeer, resolveIp } = await import("../src/api/middleware.js");
    for (const [configured, socket] of [["127.0.0.1", "::ffff:127.0.0.1"], ["::ffff:127.0.0.1", "127.0.0.1"], ["::FFFF:127.0.0.1", "::ffff:127.0.0.1"], ["0:0:0:0:0:0:0:1", "::1"], ["::ffff:7f00:1", "127.0.0.1"], ["127.0.0.1", "0:0:0:0:0:ffff:7f00:1"], ["::1", "0:0:0:0:0:0:0:1"]]) {
      process.env.CRESCENT_TRUSTED_PROXY_IPS = configured;
      expect(isTrustedProxyPeer(socket)).toBe(true);
      expect(await keyInPage(socket!)).toBe("");
      expect(resolveIp(new Request("http://localhost", { headers: { "X-Forwarded-For": "198.51.100.2" } }), socket)).toBe("198.51.100.2");
    }
  } finally {
    if (previous === undefined) delete process.env.CRESCENT_TRUSTED_PROXY_IPS;
    else process.env.CRESCENT_TRUSTED_PROXY_IPS = previous;
  }
});

test("scoped IPv6 proxy inputs fail closed without throwing", async () => {
  const previous = process.env.CRESCENT_TRUSTED_PROXY_IPS;
  try {
    const { isTrustedProxyPeer, isTrustedLocalIp } = await import("../src/api/middleware.js");
    process.env.CRESCENT_TRUSTED_PROXY_IPS = "fe80::1%en0,::1%en0";
    expect(isTrustedProxyPeer("::1")).toBe(false);
    expect(isTrustedProxyPeer("fe80::1%en0")).toBe(false);
    expect(isTrustedLocalIp("::1%en0")).toBe(false);
    expect(await keyInPage("::1%en0")).toBe("");
  } finally {
    if (previous === undefined) delete process.env.CRESCENT_TRUSTED_PROXY_IPS;
    else process.env.CRESCENT_TRUSTED_PROXY_IPS = previous;
  }
});
