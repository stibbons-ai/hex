/** The bookkeeping buckets a Document can be filed under; ER is the only one today. */
export const CATEGORIES = ["ER"] as const;
export type Category = (typeof CATEGORIES)[number];
export const DEFAULT_CATEGORY: Category = "ER";

/**
 * The time zone a received instant becomes a calendar date in: Daniel's mailbox and bookkeeping
 * are German, so a mail received 00:30 on 1 November local time belongs to November.
 */
export const FILING_TIME_ZONE = "Europe/Berlin";

/** A day in the Gregorian calendar; `month` is 1–12. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Whether `date` is a real day with a four-digit year: integers only, month 1–12, the day within
 * that month (29 February only in leap years).
 */
export function isCalendarDate(date: CalendarDate): boolean {
  const { year, month, day } = date;
  return (
    [year, month, day].every(Number.isInteger) &&
    year >= 1000 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** The calendar date of `instant` in `timeZone`; a RangeError for an invalid instant or zone. */
export function calendarDateIn(instant: Date, timeZone: string): CalendarDate {
  if (Number.isNaN(instant.getTime())) throw new RangeError("invalid instant");
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** Where and by which date one Document is filed. */
export interface FilingPlan {
  /** Relative folder, `YYYY-MM/<Category>`. */
  readonly folder: string;
  /** The date the folder comes from. */
  readonly date: CalendarDate;
  /** True when the Document date was missing or invalid and the fallback date was used. */
  readonly fellBack: boolean;
}

/**
 * Plans the Filing of one Document: by its Document date when that is a valid
 * {@link CalendarDate}, else by `fallbackDate` (the Intake's received date). An invalid
 * `fallbackDate` is a RangeError, whether or not it is needed.
 */
export function planFiling(
  documentDate: CalendarDate | undefined,
  fallbackDate: CalendarDate,
  category: Category,
): FilingPlan {
  if (!isCalendarDate(fallbackDate)) {
    throw new RangeError(`invalid fallback date ${JSON.stringify(fallbackDate)}`);
  }
  const fellBack = documentDate === undefined || !isCalendarDate(documentDate);
  const date = fellBack ? fallbackDate : documentDate;
  const month = String(date.month).padStart(2, "0");
  return { folder: `${date.year}-${month}/${category}`, date, fellBack };
}
