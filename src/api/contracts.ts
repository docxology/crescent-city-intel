/** Runtime request contracts compiled from the shipped OpenAPI document. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Civil components are checked before parsing, which otherwise normalizes invalid dates. */
function validTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]! && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && Number(offsetHour ?? 0) < 24 && Number(offsetMinute ?? 0) < 60 && Number.isFinite(Date.parse(value));
}

/** Validate the supported OpenAPI 3 schema keywords without coercing JSON values. */
export function validateApiValue(value: unknown, rawSchema: Schema, at = "value", depth = 0): string[] {
  if (depth > 32) return [`${at}: nesting is too deep`];
  const schema = resolveSchema(rawSchema);
  if (value === null && (schema.nullable || schema.type === "null" || schema.type?.includes?.("null"))) return [];
  if (schema.allOf) {
    const { allOf, ...outer } = schema;
    return [...validateApiValue(value, outer, at, depth + 1), ...allOf.flatMap((item: Schema) => validateApiValue(value, item, at, depth + 1))].slice(0, 20);
  }
  if (schema.oneOf || schema.anyOf) {
    const alternatives: Schema[] = schema.oneOf ?? schema.anyOf;
    const passes = alternatives.filter(item => validateApiValue(value, item, at, depth + 1).length === 0).length;
    if (passes < 1 || schema.oneOf && passes !== 1) return [`${at}: does not match the declared alternatives`];
    const { oneOf, anyOf, ...outer } = schema;
    return validateApiValue(value, outer, at, depth + 1);
  }
  const errors: string[] = [];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = (type: string) => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value) : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === type;
  if (types.length && !types.some(matches)) return [`${at}: expected ${types.join(" or ")}`];
  if (schema.enum && !schema.enum.some((item: unknown) => Object.is(item, value))) errors.push(`${at}: unsupported value`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) errors.push(`${at}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: invalid format`);
    if (schema.format === "date-time" && !validTimestamp(value)) errors.push(`${at}: invalid timestamp`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${at}: must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${at}: invalid array length`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) errors.push(`${at}: duplicate items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateApiValue(item, schema.items, `${at}[${index}]`, depth + 1)));
  } else if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!Object.hasOwn(object, key)) errors.push(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...validateApiValue(item, schema.properties[key], `${at}.${key}`, depth + 1));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unsupported field`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validateApiValue(item, schema.additionalProperties, `${at}.${key}`, depth + 1));
    }
  }
  return errors.slice(0, 20);
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
  try { return validateApiValue(await response.clone().json(), schema, "response"); }
  catch { return ["response: invalid JSON"]; }
}

/** Public liveness diagnostics expose state, never retained source errors/URLs. */
export function publicSourceHealthRows(rows: unknown): unknown[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).filter(item => item !== null && typeof item === "object").map(item => {
    const source = item as Record<string, unknown>;
    return Object.fromEntries(["id", "sourceId", "source", "sourceName", "status", "checkedAt", "fetchedAt", "observedAt", "itemCount", "freshness", "freshnessWindowMs", "ageMs", "collectionMode"].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  });
}
