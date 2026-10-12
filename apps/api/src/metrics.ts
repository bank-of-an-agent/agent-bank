import type { Logger } from "./logger";

/**
 * CloudWatch Embedded Metric Format: when `METRICS_NAMESPACE` is set, metrics are written as
 * structured log lines that CloudWatch Logs turns into metrics (no extra permissions). Metrics
 * have no dimensions, as the infra alarms expect.
 */
export function emitMetric(
  logger: Logger,
  enabled: boolean,
  namespace: string,
  name: string,
  value: number,
  unit: "Count" | "Milliseconds" = "Count",
): void {
  if (!enabled) return;
  logger.info(
    {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          { Namespace: namespace, Dimensions: [[]], Metrics: [{ Name: name, Unit: unit }] },
        ],
      },
      [name]: value,
    },
    `metric ${namespace}/${name}`,
  );
}
