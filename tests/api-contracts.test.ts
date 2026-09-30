import { test, expect, beforeEach } from "bun:test";
import { apiContract, apiInventory, validateApiRequest, validateApiValue } from "../src/api/contracts.js";
import { apiKeyMiddleware, rateLimitMiddleware, resolveIp, _testHooks } from "../src/api/middleware.js";
import { withApiAdmission, activeApiOperations } from "../src/api/admission.js";
import { handleApiRoute } from "../src/gui/routes.js";
beforeEach(() => { _testHooks.resetAll(); _testHooks.clearNow(); });
const request = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
test("the document controls exact public method policy and rejects undeclared methods", async () => {
  expect(apiContract("/api/search")?.public).toBe(true);
  expect(apiContract("/api/search/semantic")?.public).toBe(false);
  expect(apiContract("/api/annotations", "POST")?.public).toBe(false);
  expect(apiInventory().find(item => item.path === "/api/chat")?.methods).toEqual(["GET", "POST"]);
  const response = await handleApiRoute(new URL("http://localhost/api/summarize"), new Request("http://localhost/api/summarize"));
  expect(response.status).toBe(405);
  expect(response.headers.get("Allow")).toBe("POST");
  expect((await apiKeyMiddleware()(new Request("http://localhost/api/search/private")))?.status).toBe(404);
  expect((await apiKeyMiddleware()(new Request("http://localhost/api/search/semantic?q=x")))?.status).toBe(401);
});
test("untyped and oversized chat/history inputs fail before provider work", async () => {
  for (const body of [{ q: 4 }, { q: {} }, { q: " " }, { q: "x", model: 2 }, { q: "x", history: [{ role: "system", content: "x" }] }, { q: "x", history: [{ role: "user", content: 8 }] }, { q: "x", history: Array.from({ length: 21 }, () => ({ role: "user", content: "x" })) }, { q: "x", unknown: true }]) {
    const req = request("/api/chat", body);
    expect((await validateApiRequest(new URL(req.url), req))?.status).toBe(400);
  }
  const req = request("/api/chat", { q: "x".repeat(70000) });
  expect((await validateApiRequest(new URL(req.url), req))?.status).toBe(413);
  const valid = request("/api/chat", { q: "What changed?", history: [{ role: "user", content: "Earlier question" }] });
  expect(await validateApiRequest(new URL(valid.url), valid)).toBeNull();
  expect((await valid.json()).q).toBe("What changed?");
});
test("numeric and enum queries reject invalid input without clamping or NaN", async () => {
  for (const query of ["q=x&limit=-1", "q=x&limit=1.2", "q=x&limit=NaN", "q=x&offset=-1", "q=x&field=bad", "q=x&limit=10&limit=20", "q=x&api_key=secret", "q=x&highlight=1"]) {
    const url = new URL(`http://localhost/api/search?${query}`);
    expect((await validateApiRequest(url))?.status).toBe(400);
  }
  expect(await validateApiRequest(new URL("http://localhost/api/search?q=x&limit=10&offset=2&field=text&highlight=true"))).toBeNull();
  expect(validateApiValue({ x: 1 }, { type: "object", required: ["text"], properties: { text: { type: "string" } } })).not.toEqual([]);
});
test("untrusted changing forwarded headers and loopback sockets have finite quotas", async () => {
  const middleware = rateLimitMiddleware();
  for (let i = 0; i < 100; i++) expect(await middleware(new Request("http://localhost/api/search?q=x", { headers: { "X-Forwarded-For": `198.51.100.${i}` } }), "127.0.0.1")).toBeNull();
  expect((await middleware(new Request("http://localhost/api/search?q=x", { headers: { "X-Forwarded-For": "198.51.100.222" } }), "127.0.0.1"))?.status).toBe(429);
  const previous = process.env.CRESCENT_TRUSTED_PROXY_IPS;
  try { process.env.CRESCENT_TRUSTED_PROXY_IPS = "192.0.2.1"; expect(resolveIp(new Request("http://localhost", { headers: { "X-Forwarded-For": "198.51.100.4" } }), "192.0.2.1")).toBe("198.51.100.4"); }
  finally { if (previous === undefined) delete process.env.CRESCENT_TRUSTED_PROXY_IPS; else process.env.CRESCENT_TRUSTED_PROXY_IPS = previous; }
});
test("admission keeps capacity through SSE lifetime and releases on cancellation", async () => {
  const responses: Response[] = [];
  const url = new URL("http://localhost/api/chat/stream");
  try {
    for (let i = 0; i < 4; i++) responses.push(await withApiAdmission(url, request(url.pathname, { q: "x" }), async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } })));
    expect(activeApiOperations()).toBe(4);
    expect((await withApiAdmission(url, undefined, async () => Response.json({}))).status).toBe(503);
  } finally { await Promise.all(responses.map(response => response.body!.cancel())); }
  expect(activeApiOperations()).toBe(0);
});
test("already cancelled operations cannot retain an SSE admission slot", async () => {
  const controller = new AbortController(); controller.abort();
  const req = new Request("http://localhost/api/chat/stream", { method: "POST", signal: controller.signal });
  const response = await withApiAdmission(new URL(req.url), req, async () => new Response(new ReadableStream({ start() {} }), { headers: { "Content-Type": "text/event-stream" } }));
  expect(response.status).toBe(499);
  expect(activeApiOperations()).toBe(0);
});
test("synchronous task or request construction failure releases admission ownership", async () => {
  const url = new URL("http://localhost/api/chat");
  await expect(withApiAdmission(url, undefined, (): Promise<Response> => { throw new Error("setup failed"); })).rejects.toThrow("setup failed");
  expect(activeApiOperations()).toBe(0);
  const consumed = request(url.pathname, { q: "x" }); await consumed.json();
  await expect(withApiAdmission(url, consumed, async () => Response.json({}))).rejects.toThrow();
  expect(activeApiOperations()).toBe(0);
});
test("a rejecting SSE cancellation still releases its slot", async () => {
  const controller = new AbortController();
  const req = new Request("http://localhost/api/chat/stream", { signal: controller.signal });
  await withApiAdmission(new URL(req.url), req, async () => new Response(new ReadableStream({ cancel() { throw new Error("cancel rejected"); } }), { headers: { "Content-Type": "text/event-stream" } }));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(activeApiOperations()).toBe(0);
});
test("date-time fields reject normalized invalid civil dates and require an offset", () => {
  const schema = { type: "string", format: "date-time" };
  for (const value of ["2026-02-30T01:00:00Z", "2026-09-30", "2026-09-30T01:00:00", "2026-09-30T24:00:00Z", "2026-09-30T01:00:00+24:00"]) expect(validateApiValue(value, schema)).not.toEqual([]);
  for (const value of ["2024-02-29T01:00:00Z", "2026-09-30T01:00:00.123-07:00"]) expect(validateApiValue(value, schema)).toEqual([]);
});
test("malformed encoded paths fail at middleware with a client error", async () => {
  const { applyMiddleware } = await import("../src/api/middleware.js");
  expect((await applyMiddleware(new Request("http://localhost/api/article/%ZZ")))?.status).toBe(400);
  const response = await handleApiRoute(new URL("http://localhost/api/article/%ZZ"));
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});
test("response contracts reject wrong real fields instead of claiming success", async () => {
  const { validateApiResponse } = await import("../src/api/contracts.js");
  const url = new URL("http://localhost/api/section/1");
  expect(await validateApiResponse(url, "GET", Response.json({ guid: "1", number: "1.2", title: "Section", text: "Text" }))).toEqual([]);
  expect(await validateApiResponse(url, "GET", Response.json({ guid: "1", number: "1.2", title: "Section", text: 8 }))).not.toEqual([]);
  const domains = await handleApiRoute(new URL("http://localhost/api/domains"));
  expect(domains.status).toBe(200);
  expect(Array.isArray(await domains.json())).toBe(true);
  const geo = await handleApiRoute(new URL("http://localhost/api/geo-intel"));
  expect(geo.status).toBe(200);
  expect((await geo.json()).view.features.some((feature: { geometry: { type: string } }) => feature.geometry.type === "Polygon")).toBe(true);
});

test("inherited JSON property names cannot bypass additionalProperties or required fields", () => {
  const value = JSON.parse('{"__proto__":{"q":"x"},"constructor":"x"}');
  expect(validateApiValue(value, { type: "object", required: ["q"], properties: { q: { type: "string" } }, additionalProperties: false })).toHaveLength(3);
  expect(validateApiValue({}, { type: "object", allOf: [{ type: "object" }], required: ["q"] })).not.toEqual([]);
});
