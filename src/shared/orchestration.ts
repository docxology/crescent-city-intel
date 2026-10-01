/** Shared durable orchestration and build metadata helpers. */
import type { PipelineRunReport, PipelineStepReport, SourceHealth, SourceHealthSummary } from "../types.js";
import { errorMessage, summarizeSourceHealth, writeJsonAtomic } from "./source_health.js";
import { readFileSync } from "fs";
import { join } from "path";
import { withRunSignal } from "./run_scope.js";
import { withTransportScope } from "./transport.js";
import { withinDeadline } from "./transport.js";

export interface StepExecution<T> {
  value?: T;
  report: PipelineStepReport;
}

export interface StepOptions<T> {
  classify?: (value: T) => PipelineStepReport["status"];
  itemCount?: (value: T) => number | undefined;
  outputPaths?: string[];
  metadata?: Record<string, unknown>;
  receiptPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Execute one pipeline stage and retain a structured failure instead of losing the stage boundary. */
export async function executePipelineStep<T>(
  name: string,
  task: (signal: AbortSignal) => Promise<T>,
  options: StepOptions<T> = {},
): Promise<StepExecution<T>> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    options.signal?.throwIfAborted();
    if (options.receiptPath) await writeJsonAtomic(options.receiptPath, { name, status: "running", startedAt }, { signal: options.signal });
    const scopedTask = (signal: AbortSignal) => withRunSignal(signal, () => withTransportScope({ signal }, () => task(signal)), options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs);
    const value = options.timeoutMs !== undefined
      ? await withinDeadline(scopedTask, options.timeoutMs, options.signal)
      : await scopedTask(options.signal ?? new AbortController().signal);
    options.signal?.throwIfAborted();
    const completedAt = new Date().toISOString();
    const execution: StepExecution<T> = {
      value,
      report: {
        name,
        status: options.classify?.(value) ?? "ok",
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        ...(options.itemCount ? { itemCount: options.itemCount(value) } : {}),
        ...(options.outputPaths ? { outputPaths: options.outputPaths } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    };
    if (options.receiptPath) await writeJsonAtomic(options.receiptPath, execution.report, { signal: options.signal });
    return execution;
  } catch (error: unknown) {
    const completedAt = new Date().toISOString();
    const execution: StepExecution<T> = {
      report: {
        name,
        status: "failed",
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
        ...(options.outputPaths ? { outputPaths: options.outputPaths } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        error: errorMessage(error),
      },
    };
    if (options.receiptPath) await writeJsonAtomic(options.receiptPath, execution.report, { signal: null });
    return execution;
  }
}

export function createRunId(pipeline: string, startedAt = new Date().toISOString()): string {
  const stamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${pipeline.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${stamp}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
}

function gitCommit(): string | null {
  const fromEnvironment = process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? process.env.CI_COMMIT_SHA;
  if (fromEnvironment) return fromEnvironment;
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode === 0) {
      const value = new TextDecoder().decode(result.stdout).trim();
      return value || null;
    }
  } catch {
    // Build metadata is diagnostic; a missing git binary must not break a run.
  }
  return null;
}

/**
 * Read the shipped package version without running Git. An unreadable manifest
 * yields an explicit unknown version; caller-specific overrides stay with the
 * caller.
 */
export function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8")) as { version?: string };
    if (typeof manifest.version === "string" && manifest.version.length > 0) return manifest.version;
  } catch { /* fall through: an unreadable manifest must not break a run */ }
  return "unknown";
}

export function runtimeMetadata(): PipelineRunReport["metadata"] {
  return {
    appVersion: process.env.APP_VERSION ?? packageVersion(),
    commit: gitCommit(),
    runtime: `bun/${process.versions.bun ?? "unknown"}`,
    ci: Boolean(process.env.CI || process.env.GITHUB_ACTIONS),
  };
}

export function pipelineStatus(steps: PipelineStepReport[], health: SourceHealthSummary, exitCode = 0): PipelineRunReport["status"] {
  if (exitCode >= 2) return "failed";
  if (exitCode === 1) return "degraded";
  if (steps.some(step => step.status === "failed")) return "failed";
  // Source availability is coverage metadata, not pipeline health. A run that
  // completed its checks successfully remains operational even when one or
  // more upstream sources are missing; the summary exposes those gaps.
  if (steps.some(step => step.status === "degraded")) return "degraded";
  return "ok";
}

export function buildPipelineRun(
  pipeline: string,
  runId: string,
  startedAt: string,
  steps: PipelineStepReport[],
  sources: SourceHealth[],
  exitCode: number,
  completedAt = new Date().toISOString(),
): PipelineRunReport {
  const health = summarizeSourceHealth(sources, completedAt);
  return {
    schemaVersion: "1.0.0",
    runId,
    pipeline,
    status: pipelineStatus(steps, health, exitCode),
    exitCode,
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    steps,
    sourceHealth: health,
    metadata: runtimeMetadata(),
  };
}

export async function writePipelineRun(path: string, report: PipelineRunReport): Promise<void> {
  await writeJsonAtomic(path, report);
}
/** CLI signal handling is cooperative; durable cleanup runs before process exit. */
export async function withTerminationSignal<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const terminate = () => controller.abort(new Error("CLI termination requested"));
  process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  try { return await task(controller.signal); }
  finally { process.removeListener("SIGTERM", terminate); process.removeListener("SIGINT", terminate); }
}
