import type { Clock } from "@agentbank/core";

/**
 * One clock for the whole test process.
 *
 * The SDKs read `Date.now()` (RFC 9421 `created`, owner authorizations, session expiries, x402
 * validity checks) while the services read an injected `Clock`. For a real-HTTP stack whose
 * time can be moved (approvals expire after 15 minutes, loosening waits an hour), both must
 * agree, so `installWorldClock()` replaces `globalThis.Date` with a constructor whose "now" is
 * `max(real now + offset, floor)`:
 *
 * - time keeps flowing at wall-clock speed (pollers, signature lifetimes and rate limits behave
 *   as in production);
 * - `advance(ms)` jumps the whole world forward (SDKs, API, co-signer, facilitator, indexer and
 *   the simulated chain's next block);
 * - `raiseTo(ms)` never lets the clock fall behind the chain: the simulated chain gives every
 *   block a timestamp at least one second after its parent, so a burst of blocks runs ahead of
 *   wall-clock time and the world follows it (otherwise operation deadlines computed from the
 *   clock would already be behind the chain).
 *
 * Instances are plain `Date`s (the replacement shares `Date.prototype`), so `instanceof Date`
 * holds both ways. Node's own timers are monotonic and unaffected.
 */

interface WorldState {
  realDate: DateConstructor;
  offsetMs: number;
  floorMs: number;
  installed: boolean;
}

const STATE_KEY = Symbol.for("agentbank.e2e.world-clock");

function state(): WorldState {
  const holder = globalThis as unknown as Record<symbol, WorldState | undefined>;
  let current = holder[STATE_KEY];
  if (!current) {
    current = { realDate: globalThis.Date, offsetMs: 0, floorMs: 0, installed: false };
    holder[STATE_KEY] = current;
  }
  return current;
}

function worldNowMs(): number {
  const s = state();
  return Math.max(s.realDate.now() + s.offsetMs, s.floorMs);
}

/** Replace `globalThis.Date` (idempotent). */
export function installWorldClock(): void {
  const s = state();
  if (s.installed) return;
  const RealDate = s.realDate;
  function WorldDate(this: unknown, ...args: unknown[]): unknown {
    if (new.target === undefined) return new RealDate(worldNowMs()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [worldNowMs()] : args, new.target);
  }
  WorldDate.prototype = RealDate.prototype;
  Object.defineProperties(WorldDate, {
    now: { value: () => worldNowMs(), writable: true, configurable: true },
    parse: { value: RealDate.parse, writable: true, configurable: true },
    UTC: { value: RealDate.UTC, writable: true, configurable: true },
  });
  (globalThis as unknown as { Date: DateConstructor }).Date = WorldDate as unknown as DateConstructor;
  s.installed = true;
}

/** The `Clock` every service of the stack shares (and `Date.now()` follows). */
export class WorldClock implements Clock {
  constructor() {
    installWorldClock();
  }

  now(): Date {
    return new (state().realDate)(worldNowMs());
  }

  nowMs(): number {
    return worldNowMs();
  }

  nowSeconds(): number {
    return Math.floor(worldNowMs() / 1000);
  }

  /** Start the world at `time` (only when no stack depends on the current time). */
  set(time: Date | string | number): Date {
    const s = state();
    s.offsetMs = new s.realDate(time).getTime() - s.realDate.now();
    s.floorMs = 0;
    return this.now();
  }

  /** Move the whole world forward by `ms`. */
  advance(ms: number): Date {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError("the world clock only moves forward");
    const s = state();
    s.offsetMs = worldNowMs() + ms - s.realDate.now();
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advance(seconds * 1000);
  }

  /** Never fall behind `ms` (the simulated chain's newest block). */
  raiseTo(ms: number): void {
    const s = state();
    if (ms > s.floorMs) s.floorMs = ms;
  }
}
