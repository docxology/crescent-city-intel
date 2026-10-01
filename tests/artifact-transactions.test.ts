import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { replaceArtifacts, recoverArtifactTransactions } from "../src/shared/artifact_transaction.ts";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withRunSignal } from "../src/shared/run_scope.ts";
test("ambient parent cancellation rolls back binary publication before the next file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-binary-abort-")); const first = Buffer.from([1, 2, 3]), second = Buffer.from([4, 5]); await writeFile(join(root, "first"), first); await writeFile(join(root, "second"), second); const controller = new AbortController();
  try {
    await expect(withRunSignal(controller.signal, () => replaceArtifacts(root, [{ path: "first", bytes: new Uint8Array([6, 7]) }, { path: "second", bytes: new Uint8Array([8, 9]) }], { onProgress: async receipt => { if (receipt.applied.length === 1) controller.abort(); } }))).rejects.toThrow();
    expect(await readFile(join(root, "first"))).toEqual(first); expect(await readFile(join(root, "second"))).toEqual(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("partial cancellation restores exact original bytes, including malformed UTF8", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-")); const original = Buffer.from([0xff, 0xfe, 0, 1]); await writeFile(join(root, "first.json"), original); await writeFile(join(root, "second.json"), "old second");
  const controller = new AbortController();
  try {
    await expect(replaceArtifacts(root, [{ path: "first.json", text: "new first" }, { path: "second.json", text: "new second" }], { signal: controller.signal, onProgress: async receipt => { if (receipt.applied.length === 1) controller.abort(); } })).rejects.toThrow();
    expect(await readFile(join(root, "first.json"))).toEqual(original); expect(await readFile(join(root, "second.json"), "utf8")).toBe("old second");
    const directories = await readdir(join(root, "state", "artifact-transactions")); expect(JSON.parse(await readFile(join(root, "state", "artifact-transactions", directories[0]!, "receipt.json"), "utf8")).status).toBe("rolled-back");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("killed real transaction owner is rolled back on restart and competing changes are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-kill-")); await writeFile(join(root, "one"), "original one"); await writeFile(join(root, "two"), "original two");
  const module = new URL("../src/shared/artifact_transaction.ts", import.meta.url).href;
  const code = `const {replaceArtifacts}=await import(${JSON.stringify(module)});await replaceArtifacts(${JSON.stringify(root)},[{path:'one',text:'new one'},{path:'two',text:'new two'}],{onProgress:async r=>{if(r.applied.length===1){console.log('READY');await new Promise(()=>{});}}});`;
  const child = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(); const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("READY"); child.kill("SIGKILL"); await child.exited; reader.releaseLock();
    expect(await readFile(join(root, "one"), "utf8")).toBe("new one");
    await new Promise(resolve => setTimeout(resolve, 5)); const recovered = await recoverArtifactTransactions(root); expect(recovered).toHaveLength(1); expect(await readFile(join(root, "one"), "utf8")).toBe("original one"); expect(await readFile(join(root, "two"), "utf8")).toBe("original two");
    await expect(replaceArtifacts(root, [{ path: "../escape", text: "bad" }])).rejects.toThrow("escaped");
    const directories = await readdir(join(root, "state", "artifact-transactions")); const receiptPath = join(root, "state", "artifact-transactions", directories[0]!, "receipt.json"); const receipt = JSON.parse(await readFile(receiptPath, "utf8")); receipt.status = "applying"; await writeFile(receiptPath, JSON.stringify(receipt)); await writeFile(join(root, "one"), "independently changed");
    await expect(recoverArtifactTransactions(root)).rejects.toThrow("outside transaction"); expect(await readFile(join(root, "one"), "utf8")).toBe("independently changed");
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
}, 5000);
test("physical aliases and symlink roots fail before any artifact or lease write", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-alias-")); const alias = `${root}-alias`; await writeFile(join(root, "x.json"), "A");
  try {
    await expect(replaceArtifacts(root, [{ path: "x.json", text: "B" }, { path: "./x.json", text: "C" }])).rejects.toThrow("canonical");
    expect(await readFile(join(root, "x.json"), "utf8")).toBe("A"); expect(await Bun.file(join(root, "state", "artifact-transactions.lock")).exists()).toBe(false);
    await (await import("node:fs/promises")).symlink(root, alias); await expect(replaceArtifacts(alias, [{ path: "x.json", text: "B" }])).rejects.toThrow("real directory"); expect(await readFile(join(root, "x.json"), "utf8")).toBe("A");
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }); }
});
test("a real second-directory write denial restores the first replacement and preserves untouched bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-denied-")); const fs = await import("node:fs/promises"); const second = join(root, "restricted"); await fs.mkdir(second); await writeFile(join(root, "one"), "first original"); await writeFile(join(second, "two"), "second original");
  try {
    await expect(replaceArtifacts(root, [{ path: "one", text: "first new" }, { path: "restricted/two", text: "second new" }], { onProgress: async receipt => { if (receipt.applied.length === 1) await fs.chmod(second, 0o555); } })).rejects.toThrow();
    expect(await readFile(join(root, "one"), "utf8")).toBe("first original"); expect(await readFile(join(second, "two"), "utf8")).toBe("second original");
    const [id] = await readdir(join(root, "state", "artifact-transactions")); expect(JSON.parse(await readFile(join(root, "state", "artifact-transactions", id!, "receipt.json"), "utf8")).status).toBe("rolled-back");
  } finally { await fs.chmod(second, 0o755); await rm(root, { recursive: true, force: true }); }
});
test("bounded originals and mutated receipt custody are refused without replacing source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cci-transaction-bounds-")); const fs = await import("node:fs/promises"); const large = join(root, "large"); const fd = await fs.open(large, "wx"); await fd.truncate(18_000_001); await fd.close();
  try {
    await expect(replaceArtifacts(root, [{ path: "large", text: "new" }])).rejects.toThrow("bounded"); expect((await fs.stat(large)).size).toBe(18_000_001);
    const receipt = await replaceArtifacts(root, [{ path: "small", text: "valid" }]); const path = join(root, "state", "artifact-transactions", receipt.id, "receipt.json"); const changed = { ...receipt, status: "applying", files: receipt.files.map(file => ({ ...file, before: Buffer.from("invented original").toString("base64"), beforeSha256: createHash("sha256").update("invented original").digest("hex") })) }; await writeFile(path, JSON.stringify(changed));
    await expect(recoverArtifactTransactions(root)).rejects.toThrow("immutable"); expect(await readFile(join(root, "small"), "utf8")).toBe("valid");
  } finally { await rm(root, { recursive: true, force: true }); }
});
