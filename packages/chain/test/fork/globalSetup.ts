import { startForkEnv, stopForkEnv } from "./forkEnv";

/**
 * Vitest global setup: with `RUN_FORK_TESTS=1`, start (or reuse) Anvil and Alto once for all fork
 * test files, and stop what was started at the end. Without it, nothing happens.
 */
export async function setup(): Promise<void> {
  if (process.env.RUN_FORK_TESTS === "1") await startForkEnv();
}

export async function teardown(): Promise<void> {
  if (process.env.RUN_FORK_TESTS === "1") stopForkEnv();
}
