/** Bounded Web Push (RFC 8291/8292) and truthful acceptance receipts. */
import { sendWebhook } from "../alerts/notify.js";
import { boundedHttpFetch, currentTransportSignal, waitWithSignal, withTransportScope } from "../shared/transport.js";
export interface PushDeliveryReceipt { state: "disabled" | "accepted" | "failed"; channel: "none" | "webhook" | "webpush"; status?: number; error?: "invalid_configuration" | "rejected" | "unavailable"; }
const env = (name: string) => (process.env[name] ?? "").trim();
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const decode = (text: string) => { if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error("Invalid encoded key"); return new Uint8Array(Buffer.from(text, "base64url")); };
const utf8 = (text: string) => new TextEncoder().encode(text);
function concat(...pieces: Uint8Array[]): Uint8Array<ArrayBuffer> { const result = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0)); let offset = 0; for (const piece of pieces) { result.set(piece, offset); offset += piece.length; } return result; }
function endpoint(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid delivery endpoint");
  return url;
}
interface Subscription { endpoint: string; keys: { p256dh: string; auth: string } }
function subscription(): Subscription {
  const value = JSON.parse(env("PUSH_SUBSCRIBER")) as Subscription;
  endpoint(value.endpoint);
  if (decode(value.keys?.p256dh ?? "").length !== 65 || decode(value.keys.p256dh)[0] !== 4 || decode(value.keys?.auth ?? "").length !== 16 || decode(env("PUSH_PUBLIC_KEY")).length !== 65 || decode(env("PUSH_PUBLIC_KEY"))[0] !== 4 || decode(env("PUSH_PRIVATE_KEY")).length !== 32 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env("PUSH_CONTACT_EMAIL"))) throw new Error("Invalid push keys/contact");
  return value;
}
export function isPushConfigured(): boolean {
  try { if (env("PUSH_PUBLIC_KEY") || env("PUSH_PRIVATE_KEY") || env("PUSH_SUBSCRIBER")) { subscription(); return true; } if (env("ALERT_WEBHOOK_URL")) { endpoint(env("ALERT_WEBHOOK_URL")); return true; } return false; } catch { return false; }
}
async function hkdf(input: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", concat(input), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, key, length * 8));
}
/** Encrypt one RFC 8188 aes128gcm record; each send uses fresh ECDH/salt. */
export async function encryptPushPayload(payload: string, subscriber: Subscription): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = utf8(payload);
  if (plaintext.length > 3500) throw new Error("Push payload exceeds its limit");
  const receiver = decode(subscriber.keys.p256dh), auth = decode(subscriber.keys.auth);
  const receiverKey = await crypto.subtle.importKey("raw", concat(receiver), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sender = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, sender.privateKey, 256));
  const input = await hkdf(secret, auth, concat(utf8("WebPush: info\0"), receiver, publicKey), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(input, salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(input, salt, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = publicKey.length;
  return concat(header, publicKey, encrypted);
}
async function vapidAuthorization(url: URL): Promise<string> {
  const publicKey = decode(env("PUSH_PUBLIC_KEY"));
  const contact = env("PUSH_CONTACT_EMAIL");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) throw new Error("VAPID requires an explicit contact email");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: encode(publicKey.slice(1, 33)), y: encode(publicKey.slice(33, 65)), d: env("PUSH_PRIVATE_KEY") };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${encode(utf8(JSON.stringify({ alg: "ES256", typ: "JWT" })))}.${encode(utf8(JSON.stringify({ aud: url.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${contact}` })))}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned)));
  const verifier = await crypto.subtle.importKey("raw", concat(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, utf8(unsigned))) throw new Error("VAPID key pair mismatch");
  return `vapid t=${unsigned}.${encode(signature)}, k=${env("PUSH_PUBLIC_KEY")}`;
}
/** Accepted means the endpoint accepted HTTP, not delivery to a user's browser. */
export async function sendPushNotification(title: string, body: string, url?: string, fixture?: { origin: string }): Promise<PushDeliveryReceipt> {
  if (fixture) return withTransportScope({ fixture: { origin: fixture.origin, allowedOrigins: [fixture.origin] } }, () => sendPushNotification(title, body, url));
  const hasPush = !!(env("PUSH_PUBLIC_KEY") || env("PUSH_PRIVATE_KEY") || env("PUSH_SUBSCRIBER"));
  if (hasPush) {
    let target: URL, authorization: string, encrypted: Uint8Array<ArrayBuffer>;
    try {
      const receiver = subscription(); target = endpoint(receiver.endpoint);
      authorization = await vapidAuthorization(target);
      encrypted = await encryptPushPayload(JSON.stringify({ title, body, ...(url ? { url: endpoint(url).href } : {}) }), receiver);
    } catch { return { state: "failed", channel: "webpush", error: "invalid_configuration" }; }
    const parent = currentTransportSignal();
    const signal = parent ? AbortSignal.any([parent, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        signal.throwIfAborted();
        const response = await boundedHttpFetch(target.toString(), { method: "POST", maxRedirects: 0, maxBytes: 64_000, headers: { Authorization: authorization, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "normal" }, body: encrypted, signal });
        await response.body?.cancel();
        if (response.ok) return { state: "accepted", channel: "webpush", status: response.status };
        if (attempt === 2 || response.status < 500 && response.status !== 429) return { state: "failed", channel: "webpush", status: response.status, error: "rejected" };
      } catch {
        if (signal.aborted || attempt === 2) return { state: "failed", channel: "webpush", error: "unavailable" };
      }
      try { await waitWithSignal(100 * (attempt + 1), signal); } catch { return { state: "failed", channel: "webpush", error: "unavailable" }; }
    }
    return { state: "failed", channel: "webpush", error: "unavailable" };
  }
  if (!env("ALERT_WEBHOOK_URL")) return { state: "disabled", channel: "none" };
  try {
    endpoint(env("ALERT_WEBHOOK_URL"));
    const result = await sendWebhook(env("ALERT_WEBHOOK_URL"), { type: "push", title, body, url: url ? endpoint(url).href : "", source: "crescent-city-intel/push", sentAt: new Date().toISOString() });
    return { state: result.ok ? "accepted" : "failed", channel: "webhook", status: result.status, ...(!result.ok ? { error: "rejected" as const } : {}) };
  } catch { return { state: "failed", channel: "webhook", error: "unavailable" }; }
}
