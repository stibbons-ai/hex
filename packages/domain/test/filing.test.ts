import { describe, expect, test } from "bun:test";
import { FILING_TIME_ZONE, calendarDateIn, planFiling } from "../src";
import type { CalendarDate } from "../src";

const received: CalendarDate = { year: 2026, month: 10, day: 30 };

describe("planFiling", () => {
  // [Document date, expected folder, fell back?]
  test.each([
    ["absent", undefined, "2026-10/ER", true],
    ["valid", { year: 2026, month: 3, day: 14 }, "2026-03/ER", false],
    ["December", { year: 2025, month: 12, day: 31 }, "2025-12/ER", false],
    ["29 Feb in a leap year", { year: 2028, month: 2, day: 29 }, "2028-02/ER", false],
    ["29 Feb in a common year", { year: 2026, month: 2, day: 29 }, "2026-10/ER", true],
    ["29 Feb 1900 (not leap)", { year: 1900, month: 2, day: 29 }, "2026-10/ER", true],
    ["29 Feb 2000 (leap)", { year: 2000, month: 2, day: 29 }, "2000-02/ER", false],
    ["31 April", { year: 2026, month: 4, day: 31 }, "2026-10/ER", true],
    ["month 13", { year: 2026, month: 13, day: 1 }, "2026-10/ER", true],
    ["month 0", { year: 2026, month: 0, day: 1 }, "2026-10/ER", true],
    ["day 0", { year: 2026, month: 5, day: 0 }, "2026-10/ER", true],
    ["a two-digit year", { year: 26, month: 5, day: 1 }, "2026-10/ER", true],
    ["a non-integer day", { year: 2026, month: 5, day: 1.5 }, "2026-10/ER", true],
    ["NaN (unparsable)", { year: Number.NaN, month: 5, day: 1 }, "2026-10/ER", true],
  ] as const)("Document date %s", (_case, documentDate, folder, fellBack) => {
    const plan = planFiling(documentDate, received, "ER");
    expect(plan).toEqual({ folder, date: fellBack ? received : documentDate!, fellBack });
  });

  test("an invalid fallback date is a RangeError, even when the Document date is valid", () => {
    const invalid = { year: 2026, month: 2, day: 30 };
    expect(() => planFiling(undefined, invalid, "ER")).toThrow(RangeError);
    expect(() => planFiling({ year: 2026, month: 3, day: 1 }, invalid, "ER")).toThrow(RangeError);
  });
});

describe("calendarDateIn Europe/Berlin", () => {
  test.each([
    ["00:30 on 1 Nov local (CET) is November", "2026-10-31T23:30:00Z", { month: 11, day: 1 }],
    ["23:30 on 31 Oct local (CET) is October", "2026-10-31T22:30:00Z", { month: 10, day: 31 }],
    ["00:30 on 1 Aug local (CEST) is August", "2026-07-31T22:30:00Z", { month: 8, day: 1 }],
    ["New Year in Berlin, still 31 Dec in UTC", "2026-12-31T23:15:00Z", { month: 1, day: 1 }],
  ])("%s", (_case, instant, expected) => {
    const date = calendarDateIn(new Date(instant), FILING_TIME_ZONE);
    expect({ month: date.month, day: date.day }).toEqual(expected);
  });

  test("an invalid instant is a RangeError", () => {
    expect(() => calendarDateIn(new Date("nope"), FILING_TIME_ZONE)).toThrow(RangeError);
  });
});
