/**
 * Indexer metrics: a Prometheus text exposition on `GET /metrics`, and CloudWatch Embedded
 * Metric Format lines on stdout when `METRICS_NAMESPACE` / `RECONCILIATION_METRICS_NS` are set
 * (no dimensions, no extra permissions; infra/README.md "Application contract"):
 *
 * - `AgentBank/Indexer` `BlockLag` (blocks): chain head minus the indexer's cursor;
 * - `AgentBank/Reconciliation` `UnmatchedEvents` (count): events posted to suspense plus
 *   on-chain balance mismatches found by the balance check.
 */

export interface MetricsOptions {
  indexerNamespace?: string | undefined;
  reconciliationNamespace?: string | undefined;
  /** Where EMF lines go (default: stdout). */
  write?: (line: string) => void;
  now?: () => number;
}

export class IndexerMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: MetricsOptions = {}) {
    this.write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => Date.now());
  }

  private emf(namespace: string | undefined, name: string, value: number): void {
    if (!namespace) return;
    this.write(
      JSON.stringify({
        _aws: {
          Timestamp: this.now(),
          CloudWatchMetrics: [
            { Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: "Count" }] },
          ],
        },
        [name]: value,
      }),
    );
  }

  /** Blocks between the chain head and the cursor (emitted every tick). */
  blockLag(blocks: bigint): void {
    const value = Number(blocks < 0n ? 0n : blocks);
    this.gauges.set("indexer_block_lag", value);
    this.emf(this.options.indexerNamespace, "BlockLag", value);
  }

  /** Events posted to suspense or balance mismatches (emitted, even when 0, after every push). */
  unmatchedEvents(count: number): void {
    this.counters.set(
      "reconciliation_unmatched_events_total",
      (this.counters.get("reconciliation_unmatched_events_total") ?? 0) + count,
    );
    this.emf(this.options.reconciliationNamespace, "UnmatchedEvents", count);
  }

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  value(name: string): number {
    return this.counters.get(name) ?? this.gauges.get(name) ?? 0;
  }

  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    for (const [name, value] of this.gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    return `${lines.join("\n")}\n`;
  }
}
