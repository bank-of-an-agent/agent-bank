/** Injectable clock so policy windows, expiries and holds are testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Manually advanced clock for deterministic tests and simulations. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = "2026-10-11T12:00:00Z") {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(time: Date | string | number): void {
    this.current = new Date(time).getTime();
  }

  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  advanceSeconds(seconds: number): Date {
    return this.advance(seconds * 1000);
  }
}

export function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
