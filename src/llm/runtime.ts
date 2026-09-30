/** Bounded admission, cancellation and transport primitives for optional AI. */
export class LlmOverloadedError extends Error {
  constructor() { super("Optional AI service is busy; retry later"); this.name = "LlmOverloadedError"; }
}

export function boundedSignal(signal?: AbortSignal, timeoutMs = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(3_600_000, timeoutMs)));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class AdmissionGate {
  private active = 0;
  private waiting: Array<{ grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void }> = [];
  constructor(private readonly capacity: number, private readonly queueLimit: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.capacity) {
      if (this.waiting.length >= this.queueLimit) throw new LlmOverloadedError();
      await new Promise<void>((grant, reject) => {
        const waiter = { grant, reject, signal, abort: () => {
          this.waiting = this.waiting.filter(entry => entry !== waiter);
          reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
        } };
        this.waiting.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) { next.signal?.removeEventListener("abort", next.abort); next.grant(); }
      else this.active--;
    };
  }
  get state() { return { active: this.active, queued: this.waiting.length }; }
}

export const generationGate = new AdmissionGate(2, 8);
export const vectorGate = new AdmissionGate(4, 16);

/** Consume the entire body under its fetch signal, with a hard byte ceiling. */
export async function readBoundedText(response: Response, maximumBytes = 2_000_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new Error("Provider response exceeded its size limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Split streamed text including a final record without a newline. */
export async function* streamLines(response: Response, maximumBytes = 2_000_000): AsyncGenerator<string> {
  if (!response.body) throw new Error("Provider returned no stream");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("Provider stream exceeded its size limit");
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, ""); buffer = buffer.slice(index + 1);
      }
    }
    if (buffer.trim()) yield buffer.replace(/\r$/, "");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
