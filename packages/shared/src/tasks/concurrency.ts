/**
 * Concurrency governor — how many workers may run at once.
 *
 * The ceiling comes from two places that already know the answer, in this order:
 *
 *  1. **The model.** A channel declares `concurrency`: how many in-flight
 *     requests one key allows. Multiply by the keys the strategy can use and you
 *     have the provider's own limit. Running more workers than the provider
 *     accepts does not make the work go faster; it makes every worker wait on a
 *     queue it cannot see.
 *  2. **The machine.** Each worker is a subprocess running tools. Past a few per
 *     core they interleave and everything slows down.
 *
 * When neither is configured the answer is **unlimited**. That is deliberate: a
 * local single-user app should not invent a cap and then make the user wonder why
 * their work is queued. The cap exists to protect a real limit, not to express an
 * opinion about how much a person can follow.
 */

/** Where a ceiling came from, for the log line and the UI. */
export type ConcurrencySource = 'model' | 'machine' | 'none';

export interface ConcurrencyInput {
  /**
   * Provider-side ceiling: in-flight requests per key.
   * `undefined` or `0` means the channel declares no limit.
   */
  modelConcurrency?: number;
  /** How many keys the strategy can draw from. Defaults to 1. */
  usableKeys?: number;
  /** Logical CPU count (`os.cpus().length`). */
  cpuCount?: number;
  /** 1-minute load average (`os.loadavg()[0]`). Absent on some platforms. */
  loadAverage?: number;
  /** Explicit override from settings. `0`/absent = no override. */
  configured?: number;
}

export interface ConcurrencyVerdict {
  /** `Number.POSITIVE_INFINITY` when nothing is configured. */
  limit: number;
  source: ConcurrencySource;
  /** One line explaining the number, for the log and the task board. */
  reason: string;
}

/** Workers per core before the machine, not the provider, is the bottleneck. */
export const WORKERS_PER_CORE = 2;

/** Machine capacity from core count, reduced while the box is already busy. */
export function machineConcurrency(cpuCount: number, loadAverage?: number): number {
  if (!Number.isFinite(cpuCount) || cpuCount < 1) return 1;
  const base = Math.max(1, Math.floor(cpuCount * WORKERS_PER_CORE));
  if (!Number.isFinite(loadAverage ?? Number.NaN)) return base;

  const load = loadAverage as number;
  // Load is already above the core count: the box is saturated, so allow only
  // the workers that are effectively free (one per core at most).
  if (load >= cpuCount) return Math.max(1, Math.floor(cpuCount / 2));
  // Half-loaded: back off to one per core rather than two.
  if (load >= cpuCount / 2) return Math.max(1, cpuCount);
  return base;
}

/**
 * Resolve the effective cap.
 *
 * Precedence: an explicit setting wins; otherwise the tighter of the provider
 * and machine ceilings applies; otherwise unlimited.
 */
export function resolveConcurrency(input: ConcurrencyInput): ConcurrencyVerdict {
  const configured = Number.isFinite(input.configured) && (input.configured ?? 0) > 0
    ? Math.floor(input.configured as number)
    : 0;
  if (configured > 0) {
    return { limit: configured, source: 'model', reason: `手动设置 ${configured}` };
  }

  const perKey = Number.isFinite(input.modelConcurrency) && (input.modelConcurrency ?? 0) > 0
    ? Math.floor(input.modelConcurrency as number)
    : 0;
  const keys = Number.isFinite(input.usableKeys) && (input.usableKeys ?? 0) > 0
    ? Math.floor(input.usableKeys as number)
    : 1;

  const providerLimit = perKey > 0 ? perKey * keys : 0;
  const machineLimit = machineConcurrency(input.cpuCount ?? 1, input.loadAverage);

  if (providerLimit > 0) {
    const limit = Math.min(providerLimit, machineLimit);
    const source: ConcurrencySource = providerLimit <= machineLimit ? 'model' : 'machine';
    return {
      limit,
      source,
      reason:
        source === 'model'
          ? `模型上限 ${perKey}×${keys} 个 key`
          : `机器负载上限（${input.cpuCount ?? 1} 核，load ${input.loadAverage?.toFixed(2) ?? 'n/a'}）`,
    };
  }

  // Nothing configured: the caller decides how to interpret "unlimited". We
  // still report the machine number so a runaway is explainable.
  return {
    limit: Number.POSITIVE_INFINITY,
    source: 'none',
    reason: `未配置并发上限（机器可承载 ${machineLimit}）`,
  };
}

/**
 * Whether one more worker may start.
 *
 * Kept separate from the resolver so the scheduler can ask exactly one question.
 */
export function canStartAnother(active: number, verdict: ConcurrencyVerdict): boolean {
  if (!Number.isFinite(verdict.limit)) return true;
  return active < verdict.limit;
}
