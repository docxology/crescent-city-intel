/** Runtime request contracts compiled from the shipped OpenAPI document. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateArtifact, ARTIFACT_SCHEMAS, type ArtifactFamily } from "../artifact_contracts.js";
import { validateSchema } from "../schema_validation.js";

type Schema = Record<string, any>;
type Operation = Record<string, any>;
type Spec = { paths: Record<string, Record<string, any>>; components?: Record<string, any>; security?: unknown[] };
export interface ApiContract {
  path: string;
  methods: string[];
  operation: Operation;
  pathParameters: Record<string, string>;
  public: boolean;
}

const spec = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", "openapi.yaml"), "utf8")) as Spec;
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const routes = Object.entries(spec.paths).map(([path, definition]) => {
  const names: string[] = [];
  const pattern = path.split("/").map(part => {
    if (/^\{[^}]+\}$/.test(part)) { names.push(part.slice(1, -1)); return "([^/]+)"; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { path, definition, names, pattern: new RegExp(`^${pattern}/?$`) };
}).sort((a, b) => a.names.length - b.names.length || b.path.length - a.path.length);

export function apiContract(path: string, method = "GET"): ApiContract | null {
  const route = routes.find(item => item.pattern.test(path));
  if (!route) return null;
  const methods = Object.keys(route.definition).filter(key => HTTP_METHODS.has(key)).map(key => key.toUpperCase());
  if (methods.includes("GET")) methods.push("HEAD");
  const operation = route.definition[(method === "HEAD" ? "GET" : method).toLowerCase()] ?? {};
  const match = route.pattern.exec(path)!;
  const pathParameters: Record<string, string> = {};
  route.names.forEach((name, index) => { pathParameters[name] = decodeURIComponent(match[index + 1]!); });
  const security = operation.security ?? spec.security ?? [];
  return { path: route.path, methods, operation, pathParameters, public: methods.includes(method) && security.length === 0 };
}

function resolveSchema(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  const parts = String(schema.$ref).split("/").slice(1);
  if (!String(schema.$ref).startsWith("#/")) throw new Error("External API schema references are unsupported");
  let value: any = spec;
  for (const part of parts) value = value?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (!value) throw new Error(`Unresolved API schema: ${schema.$ref}`);
  return value;
}

/** HTTP requests and artifacts use one bounded non-coercing schema engine. */
export function validateApiValue(value: unknown, rawSchema: Schema, at = "value", depth = 0): string[] {
  if (depth > 32) return [`${at}: nesting is too deep`];
  return validateSchema(value, rawSchema, at, { resolve: resolveSchema });
}

function failure(error: string, status = 400, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}

export async function validateApiRequest(url: URL, request?: Request): Promise<Response | null> {
  let contract: ApiContract | null;
  const method = request?.method ?? "GET";
  try { contract = apiContract(url.pathname, method); } catch { return failure("Invalid encoded path"); }
  if (!contract) return null;
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: [...contract.methods, "OPTIONS"].join(", ") } });
  if (!contract.methods.includes(method)) return failure("Method not allowed", 405, { Allow: contract.methods.join(", ") });
  const parameters = [...(spec.paths[contract.path]?.parameters ?? []), ...(contract.operation.parameters ?? [])];
  const allowedQuery = new Set(parameters.map(resolveSchema).filter(parameter => parameter.in === "query").map(parameter => parameter.name));
  for (const key of url.searchParams.keys()) if (!allowedQuery.has(key)) return failure(`${key}: unsupported query parameter`);
  for (const raw of parameters) {
    const parameter = resolveSchema(raw);
    const schema = resolveSchema(parameter.schema ?? {});
    const values = parameter.in === "query" ? url.searchParams.getAll(parameter.name)
      : parameter.in === "path" ? [contract.pathParameters[parameter.name]].filter(value => value !== undefined)
        : parameter.in === "header" ? [request?.headers.get(parameter.name)].filter(value => value != null) : [];
    if (!values.length) { if (parameter.required) return failure(`${parameter.name}: required`); continue; }
    if (values.length > 1 && schema.type !== "array") return failure(`${parameter.name}: must occur once`);
    let value: unknown = values[0];
    if (schema.type === "integer" || schema.type === "number") {
      if (!/^-?\d+(?:\.\d+)?$/.test(String(value)) || (schema.type === "integer" && !/^-?\d+$/.test(String(value)))) return failure(`${parameter.name}: expected ${schema.type}`);
      value = Number(value);
    } else if (schema.type === "boolean") {
      if (value !== "true" && value !== "false") return failure(`${parameter.name}: expected true or false`);
      value = value === "true";
    }
    const errors = validateApiValue(value, schema, parameter.name);
    if (errors.length) return failure(errors.join("; "));
  }
  if (request && contract.operation.requestBody) {
    const bodyContract = resolveSchema(contract.operation.requestBody);
    if (!request.body) return bodyContract.required ? failure("JSON body required") : null;
    const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim();
    if (contentType !== "application/json") return failure("Content-Type must be application/json", 415);
    const reader = request.clone().body!.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    let rejectDeadline: (error: Error) => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { void reader.cancel(); rejectDeadline(new Error("body-timeout")); }, 10_000);
    const cancelled = () => { void reader.cancel(); rejectDeadline(new Error("body-cancelled")); };
    request.signal.addEventListener("abort", cancelled, { once: true });
    try {
      while (true) {
        const next = await Promise.race([reader.read(), deadline]);
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 65_536) { void reader.cancel(); return failure("Request body exceeds 64 KiB", 413); }
        parts.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const schema = bodyContract.content?.["application/json"]?.schema;
      const errors = schema ? validateApiValue(body, schema, "body") : [];
      if (errors.length) return failure(errors.join("; "));
    } catch (error) { return error instanceof Error && error.message === "body-timeout" ? failure("Request body timed out", 408) : failure("Invalid JSON body"); }
    finally { clearTimeout(timer); request.signal.removeEventListener("abort", cancelled); reader.releaseLock(); }
  }
  return null;
}

export function apiInventory(): Array<{ path: string; methods: string[]; publicMethods: string[] }> {
  return routes.map(route => {
    const methods = Object.keys(route.definition).filter(key => HTTP_METHODS.has(key)).map(key => key.toUpperCase());
    return { path: route.path, methods, publicMethods: methods.filter(method => apiContract(route.path.replace(/\{[^}]+\}/g, "example"), method)?.public) };
  });
}

/** Validate successful JSON responses against the same declared schema. */
export async function validateApiResponse(url: URL, method: string, response: Response): Promise<string[]> {
  const contract = apiContract(url.pathname, method);
  if (!contract || response.status < 200 || response.status >= 300 || !response.headers.get("Content-Type")?.startsWith("application/json")) return [];
  const responseContract = contract.operation.responses?.[String(response.status)];
  const schema = responseContract?.content?.["application/json"]?.schema;
  if (!schema) return [];
  try {
    const value = await response.clone().json();
    const errors = validateApiValue(value, schema, "response");
    const family = contract.operation["x-artifact-family"];
    if (family !== undefined) {
      if (typeof family !== "string" || !Object.hasOwn(ARTIFACT_SCHEMAS, family)) errors.push("response: unsupported artifact family authority");
      else errors.push(...validateArtifact(family as ArtifactFamily, value, { audience: contract.public ? "public" : "internal" }));
    }
    return errors;
  }
  catch { return ["response: invalid JSON"]; }
}

/** Public liveness diagnostics expose state, never retained source errors/URLs. */
export function publicSourceHealthRows(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).filter(item => item !== null && typeof item === "object").map(item => {
    const source = item as Record<string, unknown>;
    return Object.fromEntries(["id", "sourceId", "source", "sourceName", "status", "checkedAt", "fetchedAt", "observedAt", "productDate", "validUntil", "timestampBasis", "observationAgeMs", "observationFreshness", "itemCount", "freshness", "freshnessWindowMs", "ageMs", "collectionMode"].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  });
}
