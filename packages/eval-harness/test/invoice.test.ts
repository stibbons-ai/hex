import { describe, expect, test } from "bun:test";
import { documentDate, type DateLine, type Invoice } from "../src/synthetic/invoice.ts";

const invoice = (dates: DateLine[]): Invoice => ({
  language: "de",
  title: "Rechnung",
  seller: { name: "Muster GmbH", address: "Musterweg 1", iban: "DE00", taxId: "DE0" },
  buyer: [],
  dateStyle: "dot",
  dates,
  items: [],
  vat: 0,
  notes: [],
});

describe("Document date of a synthetic invoice", () => {
  test("is the one flagged date, or null when none is flagged", () => {
    const due = { label: "Fälligkeitsdatum", date: "2026-11-16" };
    expect(
      documentDate(
        invoice([due, { label: "Rechnungsdatum", date: "2026-11-02", document: true }]),
        "a.pdf",
      ),
    ).toBe("2026-11-02");
    expect(documentDate(invoice([due]), "a.pdf")).toBeNull();
  });

  test("refuses two flagged dates, naming the file", () => {
    const flagged = { label: "Datum", date: "2026-11-02", document: true } as const;
    expect(() => documentDate(invoice([flagged, flagged]), "a.pdf")).toThrow("a.pdf");
  });

  test("refuses a flagged period, naming the file", () => {
    const period = {
      label: "Zeitraum",
      from: "2026-10-01",
      to: "2026-10-31",
      document: true,
    } as unknown as DateLine;
    expect(() => documentDate(invoice([period]), "a.pdf")).toThrow("a.pdf");
  });
});
