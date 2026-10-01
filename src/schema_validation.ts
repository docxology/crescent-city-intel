/** Bounded, non-coercing JSON/OpenAPI schema validation shared by persisted and HTTP artifacts. */
import { isIP } from "node:net";
import { isPublicAddress, redactUrl } from "./shared/transport.js";

export type ValueSchema = Record<string, any>;
export interface SchemaValidationOptions { resolve?: (schema: ValueSchema) => ValueSchema; maxNodes?: number; maxErrors?: number }

export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function isStrictTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  return !!match && isCivilDate(match[1]!) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60 && Number(match[5] ?? 0) < 24 && Number(match[6] ?? 0) < 60 && Number.isFinite(Date.parse(value));
}
/** Literal host policy only; validation does not make DNS or HTTP requests. */
export function isPublicCitationUrl(value: string): boolean {
  if (value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && (isIP(host) ? isPublicAddress(host) : host.includes(".") && !/(?:^localhost$|\.(?:localhost|local|internal|lan)$)/i.test(host))
      && redactUrl(url.href) === url.href;
  } catch { return false; }
}

/** Unknown facts remain null; wrong types, invalid civil dates and nonfinite numbers never coerce. */
export function validateSchema(value: unknown, rawSchema: ValueSchema, at = "value", options: SchemaValidationOptions = {}): string[] {
  let nodes = 0;
  const maxNodes = options.maxNodes ?? 250_000, maxErrors = options.maxErrors ?? 20;
  const walk = (item: unknown, raw: ValueSchema, path: string, depth: number): string[] => {
    if (++nodes > maxNodes) return [`${path}: validation budget exceeded`];
    if (depth > 32) return [`${path}: nesting is too deep`];
    let schema: ValueSchema;
    try { schema = options.resolve ? options.resolve(raw) : raw; } catch { return [`${path}: unresolved schema`]; }
    if (!schema || typeof schema !== "object") return [`${path}: invalid schema`];
    if (schema.$ref) return [`${path}: unresolved schema`];
    const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (item === null && (schema.nullable || types.includes("null"))) return [];
    if (schema.allOf) {
      const { allOf, ...outer } = schema;
      return [walk(item, outer, path, depth + 1), ...allOf.map((part: ValueSchema) => walk(item, part, path, depth + 1))].flat().slice(0, maxErrors);
    }
    if (schema.oneOf || schema.anyOf) {
      const passes = (schema.oneOf ?? schema.anyOf).filter((part: ValueSchema) => walk(item, part, path, depth + 1).length === 0).length;
      if (!passes || schema.oneOf && passes !== 1) return [`${path}: does not match the declared alternatives`];
      const { oneOf, anyOf, ...outer } = schema;
      return walk(item, outer, path, depth + 1);
    }
    const matches = (type: string) => type === "null" ? item === null : type === "object" ? item !== null && typeof item === "object" && !Array.isArray(item)
      : type === "array" ? Array.isArray(item) : type === "integer" ? typeof item === "number" && Number.isSafeInteger(item)
        : type === "number" ? typeof item === "number" && Number.isFinite(item) : typeof item === type;
    if (types.length && !types.some(matches)) return [`${path}: expected ${types.join(" or ")}`];
    const errors: string[] = [];
    const add = (message: string) => { if (errors.length < maxErrors) errors.push(`${path}: ${message}`); };
    if (schema.enum && !schema.enum.some((allowed: unknown) => Object.is(allowed, item))) add("unsupported value");
    if (Object.hasOwn(schema, "const") && !Object.is(schema.const, item)) add("unsupported value");
    if (typeof item === "string") {
      if (schema.minLength !== undefined && item.trim().length < schema.minLength) add("too short");
      if (schema.maxLength !== undefined && item.length > schema.maxLength) add("too long");
      if (schema.pattern && !new RegExp(schema.pattern).test(item)) add("invalid format");
      if (schema.format === "date-time" && !isStrictTimestamp(item)) add("invalid timestamp");
      if (schema.format === "date" && !isCivilDate(item)) add("invalid civil date");
      if (schema.format === "public-url" && !isPublicCitationUrl(item)) add("invalid public citation URL");
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) add("must be finite");
      if (schema.minimum !== undefined && item < schema.minimum) add(`below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && item > schema.maximum) add(`above maximum ${schema.maximum}`);
    }
    if (Array.isArray(item)) {
      if (item.length < (schema.minItems ?? 0) || item.length > (schema.maxItems ?? Infinity)) add("invalid array length");
      if (schema.uniqueItems) {
        try { if (new Set(item.map(row => JSON.stringify(row))).size !== item.length) add("duplicate items"); } catch { add("invalid recursive value"); }
      }
      if (schema.items) for (let index = 0; index < item.length && errors.length < maxErrors && nodes <= maxNodes; index++) errors.push(...walk(item[index], schema.items, `${path}[${index}]`, depth + 1));
    } else if (item !== null && typeof item === "object") {
      const object = item as Record<string, unknown>, keys = Object.keys(object);
      if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) add("invalid object size");
      for (const key of schema.required ?? []) if (!Object.hasOwn(object, key) && errors.length < maxErrors) errors.push(`${path}.${key}: required`);
      for (const key of keys) {
        if (errors.length >= maxErrors || nodes > maxNodes) break;
        if (schema.propertyNames) errors.push(...walk(key, schema.propertyNames, `${path} key`, depth + 1));
        if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...walk(object[key], schema.properties[key], `${path}.${key}`, depth + 1));
        else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unsupported field`);
        else if (typeof schema.additionalProperties === "object") errors.push(...walk(object[key], schema.additionalProperties, `${path}.${key}`, depth + 1));
      }
    }
    return errors.slice(0, maxErrors);
  };
  const errors = walk(value, rawSchema, at, 0);
  return nodes > maxNodes ? [...errors, `${at}: validation budget exceeded`].slice(0, maxErrors) : errors;
}
