/**
 * In-process metrics.
 *
 * - Prometheus text exposition at `GET /metrics`: the decision latency
 *   histogram (`cosigner_decision_duration_seconds`, by route and outcome;
 *   the service objective is p99 < 300 ms), decision and request counters.
 * - CloudWatch Embedded Metric Format (the infra contract): when a namespace
 *   is configured (`METRICS_NAMESPACE`, e.g. `AgentBank/Cosigner`), one JSON
 *   log line per decision (`DecisionLatency`, ms) and per internal request
 *   (`Requests`, `Errors` = responses with status >= 500), without dimensions.
 */

/** Histogram bucket upper bounds in seconds (the 0.3 s bucket is the SLO line). */
export const LATENCY_BUCKETS_SECONDS = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5,
] as const;

export type DecisionRoute = "evaluate" | "cosign" | "x402";
export type DecisionResult = "allow" | "deny" | "require_approval" | "require_owner" | "error";

export interface MetricsOptions {
  /** CloudWatch namespace; EMF lines are written only when set. */
  emfNamespace?: string | undefined;
  /** Where EMF lines go (default: stdout, one JSON document per line). */
  emfSink?: ((line: string) => void) | undefined;
  /** Clock for EMF timestamps (ms). */
  now?: () => number;
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelString(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

export class Metrics {
  readonly #latency = new Map<string, { labels: Record<string, string>; series: HistogramSeries }>();
  readonly #counters = new Map<string, { name: string; labels: Record<string, string>; value: number }>();
  readonly #gauges = new Map<string, { value: () => number; help: string }>();
  readonly #help = new Map<string, string>();
  readonly #emfNamespace: string | undefined;
  readonly #emfSink: (line: string) => void;
  readonly #now: () => number;

  constructor(options: MetricsOptions = {}) {
    this.#emfNamespace = options.emfNamespace?.trim() || undefined;
    this.#emfSink = options.emfSink ?? ((line) => void process.stdout.write(`${line}\n`));
    this.#now = options.now ?? Date.now;
  }

  /** Observe one decision (evaluate, cosign, x402). */
  observeDecision(route: DecisionRoute, outcome: DecisionResult, seconds: number): void {
    const labels = { route, outcome };
    const key = labelString(labels);
    let entry = this.#latency.get(key);
    if (!entry) {
      entry = { labels, series: { counts: LATENCY_BUCKETS_SECONDS.map(() => 0), sum: 0, count: 0 } };
      this.#latency.set(key, entry);
    }
    const { series } = entry;
    for (let i = 0; i < LATENCY_BUCKETS_SECONDS.length; i++) {
      if (seconds <= (LATENCY_BUCKETS_SECONDS[i] as number))
        series.counts[i] = (series.counts[i] as number) + 1;
    }
    series.sum += seconds;
    series.count += 1;
    this.inc("cosigner_decisions_total", { route, outcome }, "Decisions by route and outcome");
    this.#emf(
      [{ Name: "DecisionLatency", Unit: "Milliseconds" }],
      { DecisionLatency: seconds * 1000 },
      { route, outcome },
    );
  }

  /** Observe one internal API request (for availability: Requests and Errors). */
  observeRequest(route: string, status: number): void {
    const error = status >= 500;
    this.inc(
      "cosigner_requests_total",
      { route, status: String(status) },
      "Internal API requests by route and status",
    );
    this.#emf(
      [
        { Name: "Requests", Unit: "Count" },
        { Name: "Errors", Unit: "Count" },
      ],
      { Requests: 1, Errors: error ? 1 : 0 },
      { route, status },
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

  /** Register a gauge read at scrape time. */
  gauge(name: string, help: string, value: () => number): void {
    this.#gauges.set(name, { value, help });
  }

  /** Latency samples for a route summed over outcomes. */
  latencySnapshot(route: DecisionRoute): { count: number; buckets: number[] } {
    const buckets = LATENCY_BUCKETS_SECONDS.map(() => 0);
    let count = 0;
    for (const { labels, series } of this.#latency.values()) {
      if (labels.route !== route) continue;
      count += series.count;
      series.counts.forEach((c, i) => (buckets[i] = (buckets[i] as number) + c));
    }
    return { count, buckets };
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
    lines.push("# HELP cosigner_decision_duration_seconds Policy decision latency (evaluate, cosign, x402).");
    lines.push("# TYPE cosigner_decision_duration_seconds histogram");
    for (const { labels, series } of this.#latency.values()) {
      LATENCY_BUCKETS_SECONDS.forEach((le, i) => {
        lines.push(
          `cosigner_decision_duration_seconds_bucket${labelString({ ...labels, le: String(le) })} ${series.counts[i]}`,
        );
      });
      lines.push(
        `cosigner_decision_duration_seconds_bucket${labelString({ ...labels, le: "+Inf" })} ${series.count}`,
      );
      lines.push(`cosigner_decision_duration_seconds_sum${labelString(labels)} ${series.sum}`);
      lines.push(`cosigner_decision_duration_seconds_count${labelString(labels)} ${series.count}`);
    }
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
    for (const [name, { value, help }] of this.#gauges) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${value()}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
