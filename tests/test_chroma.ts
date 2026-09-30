import { ChromaClient } from "chromadb";

async function test() {
  try {
    const endpoint = new URL(process.env.CHROMA_URL ?? "http://localhost:8001");
    const client = new ChromaClient({ host: endpoint.hostname, port: Number(endpoint.port) || 8001, ssl: endpoint.protocol === "https:", fetchOptions: { signal: AbortSignal.timeout(15_000) } });
    console.log("Client created");
    const collections = await client.listCollections();
    console.log("Collections:", collections);
    const collection = await client.getOrCreateCollection({
      name: "test",
      metadata: { "hnsw:space": "cosine" }
    });
    console.log("Collection created or retrieved:", collection);
    await collection.add({
      ids: ["1"],
      embeddings: [[0.1, 0.2, 0.3]],
      documents: ["test document"],
      metadatas: [{ source: "test" }]
    });
    console.log("Added document");
    const results = await collection.query({
      queryEmbeddings: [[0.1, 0.2, 0.3]],
      nResults: 1
    });
    console.log("Query results:", results);
  } catch (e) {
    console.error("Error:", e);
  }
}

test();
