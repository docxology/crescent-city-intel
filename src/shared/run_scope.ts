/** One finite parent budget, with explicit listener/timer disposal. */
import { AsyncLocalStorage } from "node:async_hooks";
import { outputRoot, withOutputRoot, paths } from "./paths.js";
import { withTransportScope } from "./transport.js";
import { withFileLease } from "./storage.js";
import { join } from "node:path";
import { assertCivicProducerSupported, bindCivicOutputRoot, currentCivicProfile, withCivicProfile } from "../civic_profile.js";
const signalContext = new AsyncLocalStorage<{ signal: AbortSignal; deadlineAt?: number }>();
export function currentRunSignal(): AbortSignal | undefined { return signalContext.getStore()?.signal; }
export function remainingRunMs(): number | undefined { const deadline = signalContext.getStore()?.deadlineAt; return deadline === undefined ? undefined : Math.max(1, deadline - Date.now()); }
export function withRunSignal<T>(signal: AbortSignal, task: () => T, deadlineAt?: number): T { signal.throwIfAborted(); return signalContext.run({ signal, deadlineAt: deadlineAt ?? signalContext.getStore()?.deadlineAt }, task); }
export interface RunScope { signal: AbortSignal; deadlineAt: number; remainingMs(): number; dispose(): void }
export function createRunScope(options: { signal?: AbortSignal; deadlineMs?: number } = {}, defaultMs = 3_600_000): RunScope {
  const duration = options.deadlineMs ?? defaultMs;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400_000) throw new Error("Invalid run deadline");
  const controller = new AbortController(); const deadlineAt = Date.now() + duration;
  const abort = () => controller.abort(options.signal?.reason ?? new Error("Parent run cancelled"));
  const timer = setTimeout(() => controller.abort(new Error(`Run exceeded ${duration}ms parent deadline`)), duration);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return { signal: controller.signal, deadlineAt, remainingMs: () => Math.max(1, deadlineAt - Date.now()), dispose: () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); } };
}
export interface ProducerOptions {
  signal?: AbortSignal; outputDir?: string; deadlineMs?: number;
  /** Bounded contention admission, capped by the remaining parent deadline. */
  leaseWaitMs?: number;
}
/** A direct producer captures its root and serializes its own publication cycle. */
export async function withProducerScope<T>(name: string, options: ProducerOptions, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid producer identity");
  const leaseWaitMs = options.leaseWaitMs ?? 5000;
  if (!Number.isSafeInteger(leaseWaitMs) || leaseWaitMs < 0 || leaseWaitMs > 60_000) throw new Error("Invalid producer lease wait; expected an integer from 0 to 60000 ms");
  assertCivicProducerSupported(name);
  const ambient = currentRunSignal(); const parent = ambient && options.signal ? AbortSignal.any([ambient, options.signal]) : options.signal ?? ambient;
  const scope = createRunScope({ signal: parent, deadlineMs: Math.min(options.deadlineMs ?? 3_600_000, remainingRunMs() ?? 3_600_000) });
  const profile = currentCivicProfile();
  try { return await withCivicProfile(profile, () => withOutputRoot(options.outputDir ?? outputRoot(), () => withRunSignal(scope.signal, () => withTransportScope({ signal: scope.signal }, () => withFileLease(join(paths.state, "producers", `${name}.lock`), async () => { scope.signal.throwIfAborted(); await bindCivicOutputRoot(outputRoot()); const result = await task(scope.signal); scope.signal.throwIfAborted(); return result; }, { signal: scope.signal, waitMs: Math.min(leaseWaitMs, scope.remainingMs()), staleMs: 0 })), scope.deadlineAt))); }
  finally { scope.dispose(); }
}
