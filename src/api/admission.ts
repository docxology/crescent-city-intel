/** Finite admission for expensive model/vector operations, including SSE lifetime. */
const MAX_ACTIVE = 4;
const DEADLINE_MS = 180_000;
let active = 0;
export function activeApiOperations(): number { return active; }
export async function withApiAdmission(url: URL, request: Request | undefined, task: (request: Request | undefined) => Promise<Response>): Promise<Response> {
  if (!/^\/api\/(chat(?:\/stream)?|summarize|search\/semantic|analytics\/embeddings)$/.test(url.pathname)) return task(request);
  if (active >= MAX_ACTIVE) return Response.json({ error: "Model capacity is busy; retry later" }, { status: 503, headers: { "Retry-After": "5" } });
  active++;
  let released = false;
  const controller = new AbortController();
  const release = () => { if (!released) { released = true; active--; clearTimeout(timer); request?.signal.removeEventListener("abort", cancel); } };
  const cancel = () => controller.abort(new Error("Request cancelled"));
  const timer = setTimeout(() => controller.abort(new Error("Operation deadline exceeded")), DEADLINE_MS);
  request?.signal.addEventListener("abort", cancel, { once: true });
  if (request?.signal.aborted) cancel();
  if (controller.signal.aborted) { release(); return Response.json({ error: "Request cancelled" }, { status: 499 }); }
  let pending: Promise<Response> | undefined;
  let removeAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => controller.signal.removeEventListener("abort", onAbort);
    if (controller.signal.aborted) onAbort();
  });
  try {
    const bounded = request ? new Request(request, { signal: controller.signal }) : undefined;
    pending = task(bounded);
    const response = await Promise.race([pending, aborted]);
    removeAbort();
    if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) { release(); return response; }
    const reader = response.body.getReader();
    const finish = () => { controller.signal.removeEventListener("abort", abortStream); release(); };
    const abortStream = () => { void reader.cancel(controller.signal.reason).then(finish, finish); };
    controller.signal.addEventListener("abort", abortStream, { once: true });
    if (controller.signal.aborted) abortStream();
    const body = new ReadableStream<Uint8Array>({
      async pull(output) { try { const next = await reader.read(); if (next.done) { output.close(); finish(); } else output.enqueue(next.value); } catch (error) { output.error(error); finish(); } },
      async cancel(reason) { controller.abort(reason); try { await reader.cancel(reason); } finally { finish(); } },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    removeAbort();
    if (controller.signal.aborted) {
      // A cancelled dependency still owns its slot until it settles. This
      // prevents repeated timeouts from creating unlimited orphan work.
      if (pending) void pending.then(release, release);
      else release();
      return Response.json({ error: request?.signal.aborted ? "Request cancelled" : "Operation deadline exceeded" }, { status: request?.signal.aborted ? 499 : 504 });
    }
    release(); throw error;
  }
}
