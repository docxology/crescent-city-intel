import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { isPushConfigured, sendPushNotification as productionPush } from "../src/notifications/push.ts";
function sendPushNotification(title: string, body: string, url?: string) {
  let destination = process.env.ALERT_WEBHOOK_URL;
  try { destination = JSON.parse(process.env.PUSH_SUBSCRIBER ?? "null")?.endpoint ?? destination; } catch { /* malformed configuration is exercised unchanged */ }
  return productionPush(title, body, url, destination ? { origin: new URL(destination).origin } : undefined);
}
const keys = ["ALERT_WEBHOOK_URL", "PUSH_PUBLIC_KEY", "PUSH_PRIVATE_KEY", "PUSH_SUBSCRIBER", "PUSH_CONTACT_EMAIL"];
let original: Record<string, string | undefined>;
beforeEach(() => { original = Object.fromEntries(keys.map(key => [key, process.env[key]])); for (const key of keys) delete process.env[key]; });
afterEach(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
async function hkdf(input: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(input), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(info) }, key, bits));
}
function concat(...pieces: Uint8Array[]) { const output = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0)); let offset = 0; for (const piece of pieces) { output.set(piece, offset); offset += piece.length; } return output; }

describe("truthful push delivery receipts", () => {
  test("disabled and malformed VAPID configuration cannot claim acceptance", async () => {
    expect(isPushConfigured()).toBe(false);
    expect((await sendPushNotification("Title", "Body")).state).toBe("disabled");
    process.env.PUSH_PUBLIC_KEY = "invalid"; process.env.PUSH_PRIVATE_KEY = "invalid";
    expect(isPushConfigured()).toBe(false);
    expect((await sendPushNotification("Title", "Body")).state).toBe("failed");
  });
  test("local HTTP rejection stays failed; success is endpoint acceptance only", async () => {
    let payload: Record<string, unknown> = {};
    const server = Bun.serve({ port: 0, async fetch(req) { payload = await req.json() as Record<string, unknown>; return new Response("", { status: new URL(req.url).pathname === "/fail" ? 500 : 202 }); } });
    try {
      process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${server.port}/fail`;
      expect((await sendPushNotification("Title", "Body")).state).toBe("failed");
      process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${server.port}/ok`;
      const receipt = await sendPushNotification("Title", "Body", "https://example.test/a");
      expect(receipt).toEqual({ state: "accepted", channel: "webhook", status: 202 });
      expect(payload.title).toBe("Title"); expect(payload.body).toBe("Body");
    } finally { server.stop(true); }
  });
  test("real P-256 subscription decrypts RFC payloads, verifies VAPID, and retries transient rejection", async () => {
    const receiver = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
    const signer = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signerPublic = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey)), signerJwk = await crypto.subtle.exportKey("jwk", signer.privateKey);
    let decrypted = "", authorization = "", encoding = "", attempts = 0;
    const server = Bun.serve({ port: 0, async fetch(req) {
      authorization = req.headers.get("Authorization")!; encoding = req.headers.get("Content-Encoding")!;
      const bytes = new Uint8Array(await req.arrayBuffer()), salt = bytes.slice(0, 16), recordSize = new DataView(bytes.buffer).getUint32(16), senderPublic = bytes.slice(21, 21 + bytes[20]!);
      expect(recordSize).toBe(4096); expect(senderPublic.length).toBe(65);
      const sender = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, receiver.privateKey, 256));
      const input = await hkdf(shared, auth, concat(new TextEncoder().encode("WebPush: info\0"), receiverPublic, senderPublic), 256);
      const cek = await hkdf(input, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 128), nonce = await hkdf(input, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 96);
      const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const clear = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, bytes.slice(21 + bytes[20]!)));
      expect(clear.at(-1)).toBe(2); decrypted = new TextDecoder().decode(clear.slice(0, -1));
      return new Response("", { status: ++attempts === 1 ? 503 : 201 });
    } });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      process.env.PUSH_SUBSCRIBER = JSON.stringify({ endpoint: url, keys: { p256dh: encode(receiverPublic), auth: encode(auth) } });
      process.env.PUSH_PUBLIC_KEY = encode(signerPublic); process.env.PUSH_PRIVATE_KEY = signerJwk.d; process.env.PUSH_CONTACT_EMAIL = "operator@example.test";
      expect(isPushConfigured()).toBe(true);
      expect((await sendPushNotification("Civic alert", "Bounded fixture")).state).toBe("accepted");
      expect(attempts).toBe(2); expect(encoding).toBe("aes128gcm"); expect(JSON.parse(decrypted).body).toBe("Bounded fixture");
      const jwt = /^vapid t=([^,]+)/.exec(authorization)![1]!, parts = jwt.split(".");
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()); expect(claims.aud).toBe(url); expect(claims.sub).toBe("mailto:operator@example.test");
      expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, signer.publicKey, new Uint8Array(Buffer.from(parts[2]!, "base64url")), new TextEncoder().encode(parts.slice(0, 2).join(".")))).toBe(true);
    } finally { server.stop(true); }
  });
});
