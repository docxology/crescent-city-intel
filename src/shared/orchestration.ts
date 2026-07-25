/** Shared durable orchestration and build metadata helpers. */
import type { PipelineRunReport, PipelineStepReport, SourceHealth, SourceHealthSummary } from "../types.js";
import { errorMessage, summarizeSourceHealth, writeJsonAtomic } from "./source_health.js";

export interface StepExecution<T> {
  value?: T;
  report: PipelineStepReport;
}

export interface StepOptions<T> {
  classify?: (value: T) => PipelineStepReport["status"];
  itemCount?: (value: T) => number | undefined;
  outputPaths?: string[];
  metadata?: Record<string, unknown>;
}

/** Execute one pipeline stage and retain a structured failure instead of losing the stage boundary. */
export async function executePipelineStep<T>(
  name: string,
  task: () => Promise<T>,
  options: StepOptions<T> = {},
): Promise<StepExecution<T>> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  try {
    const value = await task();
    const completedAt = new Date().toISOString();
    return {
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
  } catch (error: unknown) {
    const completedAt = new Date().toISOString();
    return {
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
  }
}

export function createRunId(pipeline: string, startedAt = new Date().toISOString()): string {
  const stamp = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${pipeline.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${stamp}-${process.pid}`;
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

export function runtimeMetadata(): PipelineRunReport["metadata"] {
  return {
    appVersion: process.env.APP_VERSION ?? "2.5.0",
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
