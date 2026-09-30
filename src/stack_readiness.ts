/** Bounded real-service readiness; availability and model presence are separate. */
export async function checkStackReadiness(options: { ollama: string; chroma: string; models: string[]; timeoutMs?: number; maxBytes?: number }): Promise<{ ready: boolean; checkedAt: string; ollama: boolean; chroma: boolean; missingModels: string[] }> {
  const request = async (base: string, path: string) => {
    const url = new URL(path, `${base.replace(/\/$/, "")}/`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid service URL");
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid readiness byte cap");
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 5000), redirect: "error" });
    if (!response.ok) throw new Error("Service unavailable");
    if (!response.body) throw new Error("Missing service response");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new Error("Readiness response exceeds byte cap");
        chunks.push(chunk.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid readiness response");
      return value as Record<string, unknown>;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  };
  const [ollamaResult, chromaResult] = await Promise.allSettled([request(options.ollama, "api/tags"), request(options.chroma, "api/v2/heartbeat")]);
  const ollama = ollamaResult.status === "fulfilled" && Array.isArray(ollamaResult.value.models) && ollamaResult.value.models.every(model => model && typeof model === "object" && typeof model.name === "string");
  const chroma = chromaResult.status === "fulfilled" && typeof chromaResult.value["nanosecond heartbeat"] === "number" && Number.isFinite(chromaResult.value["nanosecond heartbeat"]);
  const present: string[] = ollama && ollamaResult.status === "fulfilled" ? (ollamaResult.value.models as Array<{ name: string }>).map(model => model.name) : [];
  const missingModels = options.models.filter(model => !present.some(name => name === model || name === `${model}:latest`));
  return { ready: ollama && chroma && missingModels.length === 0, checkedAt: new Date().toISOString(), ollama, chroma, missingModels };
}

export async function waitForStackReadiness(options: Parameters<typeof checkStackReadiness>[0], attempts = 20): Promise<Awaited<ReturnType<typeof checkStackReadiness>>> {
  let receipt = await checkStackReadiness(options);
  for (let attempt = 1; attempt < Math.min(30, Math.max(1, attempts)) && !receipt.ready; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    receipt = await checkStackReadiness(options);
  }
  return receipt;
}
