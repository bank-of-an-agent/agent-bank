import { describe, expect, it } from "vitest";
import {
  compareTimeWindows,
  compileTimeWindows,
  isWithinTimeWindows,
  localMinuteOfWeek,
  nextTimeWindowOpening,
  utcOffsetMinutes,
  type TimeWindowInput,
} from "../src";
import { canonicalTimeZone, MAX_OFFSET_COMBINATIONS, zoneOffsets } from "../src/time-windows";

const at = (iso: string): Date => new Date(iso);
const windows = (...list: TimeWindowInput[]) => compileTimeWindows(list);
const WEEKDAYS: TimeWindowInput["days"] = ["mon", "tue", "wed", "thu", "fri"];
const NY = "America/New_York";

describe("local time", () => {
  it("computes the local minute of the week and the UTC offset", () => {
    expect(localMinuteOfWeek("UTC", at("2026-10-12T00:00:00Z"))).toBe(0); // Monday
    expect(localMinuteOfWeek("UTC", at("2026-10-18T23:59:59Z"))).toBe(7 * 1440 - 1); // Sunday
    expect(localMinuteOfWeek(NY, at("2026-10-12T00:00:00Z"))).toBe(6 * 1440 + 20 * 60); // Sunday 20:00 EDT
    expect(utcOffsetMinutes(NY, at("2026-01-15T12:00:00Z"))).toBe(-300);
    expect(utcOffsetMinutes(NY, Date.parse("2026-07-15T12:00:00Z"))).toBe(-240);
    expect(utcOffsetMinutes("Asia/Kathmandu", at("2026-07-15T12:00:00Z"))).toBe(345);
  });

  it("canonicalizes zone aliases and rejects unknown zones", () => {
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    expect(() => canonicalTimeZone("Not/AZone")).toThrow(/Unknown time zone/);
  });

  it("lists the offsets a zone takes", () => {
    expect(zoneOffsets("UTC")).toEqual([0]);
    expect(zoneOffsets(NY)).toEqual([-300, -240]);
    expect(zoneOffsets("Australia/Lord_Howe")).toEqual([630, 660]);
  });
});

describe("compileTimeWindows / isWithinTimeWindows", () => {
  it("covers [start, end) on listed days", () => {
    const w = windows({ days: ["mon"], start: "09:00", end: "17:00" });
    expect(isWithinTimeWindows(w, at("2026-10-12T09:00:00Z"))).toBe(true);
    expect(isWithinTimeWindows(w, at("2026-10-12T16:59:59.999Z"))).toBe(true);
    expect(isWithinTimeWindows(w, at("2026-10-12T17:00:00Z"))).toBe(false);
    expect(isWithinTimeWindows(w, at("2026-10-12T08:59:59.999Z"))).toBe(false);
    expect(isWithinTimeWindows(w, at("2026-10-13T10:00:00Z"))).toBe(false);
  });

  it("supports 24:00 as an end and overnight windows", () => {
    const late = windows({ days: ["mon"], start: "20:00", end: "24:00" });
    expect(isWithinTimeWindows(late, at("2026-10-12T23:59:00Z"))).toBe(true);
    expect(isWithinTimeWindows(late, at("2026-10-13T00:00:00Z"))).toBe(false);
    const overnight = windows({ days: ["fri", "sun"], start: "22:00", end: "02:00" });
    expect(isWithinTimeWindows(overnight, at("2026-10-16T22:00:00Z"))).toBe(true); // Fri
    expect(isWithinTimeWindows(overnight, at("2026-10-17T01:59:00Z"))).toBe(true); // Sat early
    expect(isWithinTimeWindows(overnight, at("2026-10-17T02:00:00Z"))).toBe(false);
    expect(isWithinTimeWindows(overnight, at("2026-10-17T22:30:00Z"))).toBe(false); // Sat night
    expect(isWithinTimeWindows(overnight, at("2026-10-19T01:00:00Z"))).toBe(true); // Sun night → Mon
  });

  it("is allowed when any zone allows", () => {
    const w = windows(
      { days: ["mon"], start: "09:00", end: "10:00", timezone: "Asia/Tokyo" },
      { days: ["mon"], start: "09:00", end: "10:00", timezone: "Europe/London" },
    );
    expect(isWithinTimeWindows(w, at("2026-10-12T00:30:00Z"))).toBe(true); // 09:30 Tokyo
    expect(isWithinTimeWindows(w, at("2026-10-12T08:30:00Z"))).toBe(true); // 09:30 BST
    expect(isWithinTimeWindows(w, at("2026-10-12T04:30:00Z"))).toBe(false);
  });

  it("never allows a local time skipped by spring-forward", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT in New York.
    const w = windows({ days: ["sun"], start: "02:00", end: "03:00", timezone: NY });
    for (let minute = 0; minute < 24 * 60; minute += 15) {
      const t = new Date(Date.parse("2026-03-08T00:00:00Z") + minute * 60_000);
      expect(isWithinTimeWindows(w, t), t.toISOString()).toBe(false);
    }
    expect(isWithinTimeWindows(w, at("2026-03-15T06:30:00Z"))).toBe(true); // a week later, 02:30 EDT
  });

  it("allows a repeated fall-back hour twice", () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST in New York.
    const w = windows({ days: ["sun"], start: "01:00", end: "02:00", timezone: NY });
    expect(isWithinTimeWindows(w, at("2026-11-01T04:59:00Z"))).toBe(false); // 00:59 EDT
    expect(isWithinTimeWindows(w, at("2026-11-01T05:00:00Z"))).toBe(true); // 01:00 EDT
    expect(isWithinTimeWindows(w, at("2026-11-01T06:30:00Z"))).toBe(true); // 01:30 EST
    expect(isWithinTimeWindows(w, at("2026-11-01T07:00:00Z"))).toBe(false); // 02:00 EST
  });

  it("follows business hours across the DST change in UTC terms", () => {
    const w = windows({ days: WEEKDAYS, start: "09:00", end: "17:00", timezone: NY });
    expect(isWithinTimeWindows(w, at("2026-03-02T13:30:00Z"))).toBe(false); // 08:30 EST
    expect(isWithinTimeWindows(w, at("2026-03-02T14:00:00Z"))).toBe(true);
    expect(isWithinTimeWindows(w, at("2026-03-09T13:00:00Z"))).toBe(true); // 09:00 EDT
    expect(isWithinTimeWindows(w, at("2026-03-09T21:00:00Z"))).toBe(false); // 17:00 EDT
  });

  it("handles Lord Howe's 30-minute DST shift", () => {
    // 2026-10-04 02:00 +10:30 jumps to 02:30 +11:00.
    const w = windows({ days: ["sun"], start: "02:00", end: "02:30", timezone: "Australia/Lord_Howe" });
    expect(isWithinTimeWindows(w, at("2026-10-03T15:29:00Z"))).toBe(false); // 01:59 +10:30
    expect(isWithinTimeWindows(w, at("2026-10-03T15:30:00Z"))).toBe(false); // 02:30 +11:00
    expect(isWithinTimeWindows(w, at("2026-10-10T15:15:00Z"))).toBe(true); // next Sunday 02:15 +11:00
  });

  it("rejects malformed windows", () => {
    expect(() => windows({ days: ["mon"], start: "24:00", end: "24:00" })).toThrow(/start/);
    expect(() => windows({ days: ["mon"], start: "9:00", end: "17:00" })).toThrow(/HH:MM/);
    expect(() => windows({ days: ["mon"], start: "09:00", end: "24:01" })).toThrow(/24:00/);
    expect(() => windows({ days: ["mon"], start: "10:00", end: "10:00" })).toThrow(/ambiguous/);
    expect(() => windows({ days: ["funday" as "mon"], start: "09:00", end: "10:00" })).toThrow(/unknown day/);
    expect(() => windows({ days: ["mon"], start: "09:00", end: "10:00", timezone: "Nowhere/Land" })).toThrow(
      /Unknown time zone/,
    );
  });
});

describe("nextTimeWindowOpening", () => {
  const business = windows({ days: WEEKDAYS, start: "09:00", end: "17:00", timezone: NY });

  it("returns the instant itself inside a window", () => {
    const t = at("2026-10-12T15:00:30.500Z");
    expect(nextTimeWindowOpening(business, t)).toEqual(t);
  });

  it("finds the next opening", () => {
    expect(nextTimeWindowOpening(business, at("2026-10-12T21:00:00Z"))).toEqual(at("2026-10-13T13:00:00Z"));
    expect(nextTimeWindowOpening(business, at("2026-10-12T12:59:59.999Z"))).toEqual(
      at("2026-10-12T13:00:00Z"),
    );
    expect(nextTimeWindowOpening(business, at("2026-10-17T12:00:00Z"))).toEqual(at("2026-10-19T13:00:00Z"));
  });

  it("is exact across spring-forward and fall-back", () => {
    // Saturday evening before the US spring-forward: Monday 09:00 EDT is 13:00Z.
    expect(nextTimeWindowOpening(business, at("2026-03-08T01:00:00Z"))).toEqual(at("2026-03-09T13:00:00Z"));
    // Saturday evening before the fall-back: Monday 09:00 EST is 14:00Z.
    expect(nextTimeWindowOpening(business, at("2026-11-01T00:00:00Z"))).toEqual(at("2026-11-02T14:00:00Z"));
  });

  it("picks the earliest zone and returns null when nothing is allowed", () => {
    const two = windows(
      { days: ["tue"], start: "09:00", end: "10:00", timezone: "Asia/Tokyo" },
      { days: ["mon"], start: "23:00", end: "23:30", timezone: "UTC" },
    );
    // Monday 22:00Z: Tokyo Tuesday 09:00 is Monday 00:00Z next week... Monday 23:00Z comes first.
    expect(nextTimeWindowOpening(two, at("2026-10-12T22:00:00Z"))).toEqual(at("2026-10-12T23:00:00Z"));
    expect(nextTimeWindowOpening(two, at("2026-10-12T23:45:00Z"))).toEqual(at("2026-10-13T00:00:00Z"));
    expect(nextTimeWindowOpening(compileTimeWindows([]), at("2026-10-12T00:00:00Z"))).toBeNull();
  });

  it("handles a window that spans the week boundary", () => {
    const w = windows({ days: ["sun"], start: "23:00", end: "01:00" });
    expect(nextTimeWindowOpening(w, at("2026-10-13T12:00:00Z"))).toEqual(at("2026-10-18T23:00:00Z"));
    expect(nextTimeWindowOpening(w, at("2026-10-19T00:30:00Z"))).toEqual(at("2026-10-19T00:30:00Z"));
    const always = windows({
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "00:00",
      end: "24:00",
    });
    expect(nextTimeWindowOpening(always, at("2026-10-13T12:00:00Z"))).toEqual(at("2026-10-13T12:00:00Z"));
  });
});

describe("compareTimeWindows", () => {
  const nineToFive = windows({ days: WEEKDAYS, start: "09:00", end: "17:00", timezone: NY });

  it("compares windows in one zone exactly", () => {
    const tenToFour = windows({ days: WEEKDAYS, start: "10:00", end: "16:00", timezone: NY });
    const weekend = windows({ days: ["sat"], start: "09:00", end: "17:00", timezone: NY });
    expect(compareTimeWindows(nineToFive, tenToFour)).toEqual({ narrower: true, wider: false });
    expect(compareTimeWindows(tenToFour, nineToFive)).toEqual({ narrower: false, wider: true });
    expect(compareTimeWindows(nineToFive, weekend)).toEqual({ narrower: true, wider: true });
    expect(compareTimeWindows(nineToFive, nineToFive)).toEqual({ narrower: false, wider: false });
  });

  it("treats split or reordered windows with the same minutes as equal", () => {
    const split = windows(
      { days: WEEKDAYS, start: "13:00", end: "17:00", timezone: NY },
      { days: WEEKDAYS, start: "09:00", end: "13:00", timezone: "America/New_York" },
    );
    expect(compareTimeWindows(nineToFive, split)).toEqual({ narrower: false, wider: false });
  });

  it("compares against no restriction and against no time at all", () => {
    const all = windows({
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "00:00",
      end: "24:00",
    });
    const none = compileTimeWindows([]);
    expect(compareTimeWindows(null, nineToFive)).toEqual({ narrower: true, wider: false });
    expect(compareTimeWindows(nineToFive, null)).toEqual({ narrower: false, wider: true });
    expect(compareTimeWindows(null, all)).toEqual({ narrower: false, wider: false });
    expect(compareTimeWindows(null, null)).toEqual({ narrower: false, wider: false });
    expect(compareTimeWindows(null, none)).toEqual({ narrower: true, wider: false });
    expect(compareTimeWindows(none, nineToFive)).toEqual({ narrower: false, wider: true });
  });

  it("compares across zones for every combination of offsets", () => {
    // 09:00-17:00 New York is 13:00-21:00Z in summer and 14:00-22:00Z in winter.
    const utcWide = windows({ days: WEEKDAYS, start: "13:00", end: "22:00" });
    const utcSummer = windows({ days: WEEKDAYS, start: "13:00", end: "21:00" });
    expect(compareTimeWindows(utcWide, nineToFive)).toEqual({ narrower: true, wider: false });
    expect(compareTimeWindows(nineToFive, utcWide)).toEqual({ narrower: false, wider: true });
    // Equal to New York only in summer: in winter 21:00-22:00Z is new and 13:00-14:00Z is gone.
    expect(compareTimeWindows(utcSummer, nineToFive)).toEqual({ narrower: true, wider: true });
    // Equal to New York only in winter: the summer offset must be checked too.
    const utcWinter = windows({ days: WEEKDAYS, start: "14:00", end: "22:00" });
    expect(compareTimeWindows(utcWinter, nineToFive)).toEqual({ narrower: true, wider: true });
    expect(compareTimeWindows(nineToFive, utcWinter)).toEqual({ narrower: true, wider: true });
    const mixed = windows(
      { days: ["mon"], start: "09:00", end: "10:00", timezone: NY },
      { days: ["mon"], start: "09:00", end: "10:00", timezone: "Europe/London" },
    );
    expect(compareTimeWindows(mixed, mixed)).toEqual({ narrower: false, wider: false });
  });

  it("gives up conservatively beyond the combination limit", () => {
    const zones = [
      NY,
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Anchorage",
      "Pacific/Honolulu",
      "Europe/London",
      "Europe/Paris",
      "Europe/Athens",
      "Australia/Sydney",
      "Australia/Lord_Howe",
      "Pacific/Auckland",
      "America/Santiago",
      "America/Halifax",
    ];
    const many = compileTimeWindows(
      zones.map((timezone) => ({ days: ["mon"], start: "09:00", end: "10:00", timezone })),
    );
    const combos = zones.reduce((n, z) => n * zoneOffsets(canonicalTimeZone(z)).length, 1);
    expect(combos).toBeGreaterThan(MAX_OFFSET_COMBINATIONS);
    expect(compareTimeWindows(many, many)).toEqual({ narrower: true, wider: true });
  });
});
