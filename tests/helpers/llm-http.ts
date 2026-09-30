/** Real local HTTP protocol fixtures; the production clients make every request. */
export interface StoredVector { id: string; document: string; embedding: number[]; metadata: Record<string, string> }
export function llmHttpFixture() {
  const collections = new Map<string, Map<string, StoredVector>>();
  let embedRequests = 0, failEmbedAfter = Infinity, omitLastUpsert = false, stalledEmbedMatch = "";
  let ollamaStream = '{"message":{"content":"See § 8.04.010."},"done":false}\n{"done":true}';
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() as Record<string, unknown> : {};
    requests.push({ path, body });
    if (path === "/api/tags") return Response.json({ models: [] });
    if (path === "/api/embed") {
      embedRequests++;
      if (embedRequests > failEmbedAfter) return new Response("unavailable", { status: 503 });
      const input = Array.isArray(body.input) ? body.input : [body.input];
      if (stalledEmbedMatch && input.some(value => String(value).includes(stalledEmbedMatch))) await new Promise(() => {});
      return Response.json({ embeddings: input.map(value => [String(value).length / 100, 1, body.model === "changed-model" ? 2 : 1]) });
    }
    if (path === "/api/chat") return body.stream ? new Response(ollamaStream) : Response.json({ message: { content: "See § 8.04.010." } });
    if (path === "/api/v2/auth/identity") return Response.json({ tenant: "default_tenant", databases: ["default_database"] });
    if (path === "/api/v2/heartbeat") return Response.json({ "nanosecond heartbeat": 1 });
    if (path === "/api/v2/pre-flight-checks") return Response.json({ max_batch_size: 1000, supports_base64_encoding: false });
    const parts = path.split("/"), index = parts.indexOf("collections");
    if (index >= 0) {
      if (parts.length === index + 1 && request.method === "POST") {
        const name = String(body.name);
        if (!collections.has(name)) collections.set(name, new Map());
        return Response.json({ id: name, name, tenant: "default_tenant", database: "default_database", metadata: body.metadata ?? {}, configuration_json: {} });
      }
      const name = decodeURIComponent(parts[index + 1]!), records = collections.get(name);
      if (request.method === "DELETE") { collections.delete(name); return Response.json(null); }
      if (!records) return new Response("Not found", { status: 404 });
      const action = parts[index + 2];
      if (action === "count") return Response.json(records.size);
      if (action === "upsert") {
        const ids = body.ids as string[], documents = body.documents as string[], embeddings = body.embeddings as number[][], metadatas = body.metadatas as Record<string, string>[];
        ids.slice(0, omitLastUpsert ? -1 : undefined).forEach((id, i) => records.set(id, { id, document: documents[i]!, embedding: embeddings[i]!, metadata: metadatas[i]! }));
        return Response.json(null);
      }
      if (action === "get") {
        let rows = [...records.values()];
        if (Array.isArray(body.ids)) rows = rows.filter(row => (body.ids as string[]).includes(row.id));
        else rows = rows.slice(Number(body.offset ?? 0), Number(body.offset ?? 0) + Number(body.limit ?? rows.length));
        return Response.json({ ids: rows.map(row => row.id), documents: rows.map(row => row.document), embeddings: rows.map(row => row.embedding), metadatas: rows.map(row => row.metadata), include: body.include ?? [] });
      }
      if (action === "query") {
        const rows = [...records.values()].slice(0, Number(body.n_results));
        return Response.json({ ids: [rows.map(row => row.id)], documents: [rows.map(row => row.document)], metadatas: [rows.map(row => row.metadata)], distances: [rows.map((_, i) => i / 100)], include: body.include ?? [] });
      }
    }
    return new Response("Not found", { status: 404 });
  } });
  return { server, url: `http://127.0.0.1:${server.port}`, collections, requests, get embedRequests() { return embedRequests; }, set failEmbedAfter(value: number) { failEmbedAfter = value; }, set omitLastUpsert(value: boolean) { omitLastUpsert = value; }, set ollamaStream(value: string) { ollamaStream = value; }, set stalledEmbedMatch(value: string) { stalledEmbedMatch = value; } };
}
