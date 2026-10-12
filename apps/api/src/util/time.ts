import { AgentBankError } from "@agentbank/core";

/** A half-open UTC interval [start, end). */
export interface Window {
  start: Date;
  end: Date;
}

/** The calendar month (UTC) containing `at`. */
export function monthWindow(at: Date): Window {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Parse a `YYYY-MM` period into its UTC month window. */
export function periodWindow(period: string): Window {
  const match = /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new AgentBankError("invalid_request", 'period must be "YYYY-MM"');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

/** `YYYY-MM` of a date (UTC). */
export function periodOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addSeconds(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}
