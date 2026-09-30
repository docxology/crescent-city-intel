/**
 * Structured logging module.
 *
 * Provides configurable, timestamped, module-tagged log output.
 * Controlled via the LOG_LEVEL environment variable.
 *
 * Usage:
 *   import { createLogger } from "./logger.js";
 *   const log = createLogger("scraper");
 *   log.info("Scraping article", { guid: "abc123" });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m",  // green
  warn: "\x1b[33m",  // yellow
  error: "\x1b[31m", // red
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/** Parse LOG_LEVEL env var (default: "info") */
function parseLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

let currentLevel: LogLevel = parseLevel();

/** Get the current global log level */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Set the global log level at runtime */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Check if a level is enabled given the current threshold */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/** Logs retain diagnostics without credentials, provider queries, or chat text. */
export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[bounded]";
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s"'<>]+/g, raw => {
    try { const url = new URL(raw); url.username = ""; url.password = ""; if (url.search) url.search = "?redacted"; url.hash = ""; return url.toString(); } catch { return "[redacted-url]"; }
  }).replace(/(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "[redacted-auth]").slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 30).map(item => redactLogValue(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, /key|token|password|secret|authorization|cookie|prompt|question|query|content/i.test(key) ? "[redacted]" : redactLogValue(item, depth + 1)]));
  return value;
}

/** Format a log line with timestamp, level, and module tag */
function formatLine(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const color = LEVEL_COLORS[level];
  const levelTag = level.toUpperCase().padEnd(5);
  const dataStr = data ? ` ${JSON.stringify(redactLogValue(data))}` : "";
  return `${DIM}${ts}${RESET} ${color}${levelTag}${RESET} [${module}] ${redactLogValue(message)}${dataStr}`;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  /** Current module name */
  readonly module: string;
}

/**
 * Create a logger scoped to a module.
 *
 * @param module - Tag for the module (e.g., "scraper", "gui", "llm")
 * @returns Logger instance with debug/info/warn/error methods
 */
export function createLogger(module: string): Logger {
  return {
    module,
    debug(message: string, data?: Record<string, unknown>) {
      if (isLevelEnabled("debug")) console.debug(formatLine("debug", module, message, data));
    },
    info(message: string, data?: Record<string, unknown>) {
      if (isLevelEnabled("info")) console.log(formatLine("info", module, message, data));
    },
    warn(message: string, data?: Record<string, unknown>) {
      if (isLevelEnabled("warn")) console.warn(formatLine("warn", module, message, data));
    },
    error(message: string, data?: Record<string, unknown>) {
      if (isLevelEnabled("error")) console.error(formatLine("error", module, message, data));
    },
  };
}
