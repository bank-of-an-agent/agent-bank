/**
 * In-process metrics.
 *
 * - Prometheus text exposition at `GET /metrics` (the ALB blocks it from the internet):
 *   verification and settlement counters by outcome and reason, failures, and a request
 *   latency histogram.
 * - CloudWatch Embedded Metric Format (the infra contract): when `METRICS_NAMESPACE` is set
 *   (`AgentBank/Facilitator`), one JSON log line per verify or settle request carrying
 *   `Verifications`, `Settlements` and `Failures` (counts, no dimensions). `Failures` counts
 *   settlements that did not complete after being accepted (reverted, unconfirmed) and
 *   requests the facilitator could not decide (fail-closed 5xx). Refused payments are not
 *   failures: they are the facilitator doing its job.
 */

export const LATENCY_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

export type VerifyOutcome = "valid" | "invalid" | "error";
/**
 * - `settled`: this request settled the payment on-chain.
 * - `replayed`: an identical, already-settled request answered from the authorization log.
 * - `rejected`: refused before anything was submitted.
 * - `failed`: submitted (or attempted) and reverted.
 * - `pending`: submitted, not confirmed in time; the row stays `settling`.
 * - `error`: the facilitator could not decide (fail closed).
 */
export type SettleOutcome = "settled" | "replayed" | "rejected" | "failed" | "pending" | "error";

export interface MetricsOptions {
  /** CloudWatch namespace; EMF lines are written only when set. */
  emfNamespace?: string | undefined;
  /** Where EMF lines go (default: stdout, one JSON document per line). */
  emfSink?: ((line: string) => void) | undefined;
  /** Clock for EMF timestamps (ms). */
  now?: () => number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelString(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

interface Histogram {
  counts: number[];
  sum: number;
  count: number;
}

export class Metrics {
  readonly #counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();
  readonly #help = new Map<string, string>();
  readonly #latency = new Map<string, Histogram>();
  readonly #emfNamespace: string | undefined;
  readonly #emfSink: (line: string) => void;
  readonly #now: () => number;

  constructor(options: MetricsOptions = {}) {
    this.#emfNamespace = options.emfNamespace?.trim() || undefined;
    this.#emfSink = options.emfSink ?? ((line) => void process.stdout.write(`${line}\n`));
    this.#now = options.now ?? Date.now;
  }

  observeVerify(outcome: VerifyOutcome, reason: string | undefined, seconds: number): void {
    const failure = outcome === "error";
    this.inc(
      "facilitator_verifications_total",
      { outcome, reason: reason ?? "none" },
      "Verifications by outcome and reason",
    );
    if (failure)
      this.inc(
        "facilitator_failures_total",
        { route: "verify", reason: reason ?? "unknown" },
        "Facilitator failures",
      );
    this.#observeLatency("verify", seconds);
    this.#emf(
      [
        { Name: "Verifications", Unit: "Count" },
        { Name: "Failures", Unit: "Count" },
      ],
      { Verifications: 1, Failures: failure ? 1 : 0 },
      { route: "verify", outcome, ...(reason ? { reason } : {}), latencyMs: Math.round(seconds * 1000) },
    );
  }

  observeSettle(outcome: SettleOutcome, reason: string | undefined, seconds: number): void {
    const failure = outcome === "failed" || outcome === "pending" || outcome === "error";
    this.inc(
      "facilitator_settlements_total",
      { outcome, reason: reason ?? "none" },
      "Settle requests by outcome and reason",
    );
    if (failure)
      this.inc(
        "facilitator_failures_total",
        { route: "settle", reason: reason ?? "unknown" },
        "Facilitator failures",
      );
    this.#observeLatency("settle", seconds);
    this.#emf(
      [
        { Name: "Settlements", Unit: "Count" },
        { Name: "Failures", Unit: "Count" },
      ],
      { Settlements: outcome === "settled" ? 1 : 0, Failures: failure ? 1 : 0 },
      { route: "settle", outcome, ...(reason ? { reason } : {}), latencyMs: Math.round(seconds * 1000) },
    );
  }

  /** Increment a counter. */
  inc(name: string, labels: Record<string, string> = {}, help = ""): void {
    const key = `${name}${labelString(labels)}`;
    const entry = this.#counters.get(key);
    if (entry) entry.value += 1;
    else this.#counters.set(key, { name, labels, value: 1 });
    if (help && !this.#help.has(name)) this.#help.set(name, help);
  }

  /** Current value of a counter series (tests, dashboards). */
  counter(name: string, labels: Record<string, string> = {}): number {
    return this.#counters.get(`${name}${labelString(labels)}`)?.value ?? 0;
  }

  #observeLatency(route: string, seconds: number): void {
    let series = this.#latency.get(route);
    if (!series) {
      series = { counts: LATENCY_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 };
      this.#latency.set(route, series);
    }
    for (let i = 0; i < LATENCY_BUCKETS_SECONDS.length; i++) {
      if (seconds <= (LATENCY_BUCKETS_SECONDS[i] as number))
        series.counts[i] = (series.counts[i] as number) + 1;
    }
    series.sum += seconds;
    series.count += 1;
  }

  #emf(
    metrics: { Name: string; Unit: string }[],
    values: Record<string, number>,
    properties: Record<string, unknown>,
  ): void {
    if (!this.#emfNamespace) return;
    const line = {
      _aws: {
        Timestamp: this.#now(),
        CloudWatchMetrics: [{ Namespace: this.#emfNamespace, Dimensions: [[]], Metrics: metrics }],
      },
      ...properties,
      ...values,
    };
    try {
      this.#emfSink(JSON.stringify(line));
    } catch {
      // Metrics never break a request.
    }
  }

  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    const lines: string[] = [];
    const byName = new Map<string, string[]>();
    for (const { name, labels, value } of this.#counters.values()) {
      const list = byName.get(name) ?? [];
      list.push(`${name}${labelString(labels)} ${value}`);
      byName.set(name, list);
    }
    for (const [name, series] of byName) {
      lines.push(`# HELP ${name} ${this.#help.get(name) ?? name}`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(...series);
    }
    lines.push("# HELP facilitator_request_duration_seconds Verify and settle latency.");
    lines.push("# TYPE facilitator_request_duration_seconds histogram");
    for (const [route, series] of this.#latency) {
      LATENCY_BUCKETS_SECONDS.forEach((le, i) => {
        lines.push(
          `facilitator_request_duration_seconds_bucket${labelString({ route, le: String(le) })} ${series.counts[i]}`,
        );
      });
      lines.push(
        `facilitator_request_duration_seconds_bucket${labelString({ route, le: "+Inf" })} ${series.count}`,
      );
      lines.push(`facilitator_request_duration_seconds_sum${labelString({ route })} ${series.sum}`);
      lines.push(`facilitator_request_duration_seconds_count${labelString({ route })} ${series.count}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
