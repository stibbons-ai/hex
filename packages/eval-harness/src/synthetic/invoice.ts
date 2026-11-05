/**
 * The fake invoices: one model, rendered either as a text PDF or as a scan (PNG raster or an
 * image-only PDF wrapping the same raster).
 */
import { glyphHeight, textWidth } from "./font.ts";
import { encodePng } from "./png.ts";
import { showText, writePdf } from "./pdf.ts";
import { Bitmap } from "./raster.ts";

export type Language = "de" | "en";

/**
 * How dates print: `dot` 02.11.2026, `short` 2 Nov 2026, `iso` 2026-11-02,
 * `long` 2. November 2026 (de) or November 2, 2026 (en).
 */
export type DateStyle = "dot" | "short" | "iso" | "long";

/**
 * One labelled date line; `document` marks the Document date (at most one line per invoice),
 * every other line is a distractor.
 */
export type DateLine =
  | { label: string; date: string; document?: true }
  /** A period is never the Document date. */
  | { label: string; from: string; to: string; document?: never };

export interface Invoice {
  language: Language;
  /** Heading, e.g. "Rechnung", "Gutschrift", "Invoice". */
  title: string;
  seller: { name: string; address: string; iban: string; taxId: string };
  buyer: readonly string[];
  /** e.g. "Rechnungsnummer: RE-2026-1042"; omitted when the Document has none. */
  reference?: string;
  dateStyle: DateStyle;
  dates: readonly DateLine[];
  items: ReadonlyArray<{ description: string; cents: number }>;
  /** VAT rate in percent; 0 prints neither a net nor a VAT line, only the total. */
  vat: number;
  /** Closing lines below the totals (payment terms, notes). */
  notes: readonly string[];
}

/**
 * The Document date (ISO) from the one line flagged `document`, or `null` when no line is flagged
 * (the invoice may still print distractor dates). Throws, naming `fileName`, when several lines
 * are flagged or the flagged line is not a single date.
 */
export function documentDate(invoice: Invoice, fileName: string): string | null {
  const lines = invoice.dates.filter((date) => date.document === true);
  if (lines.length > 1) throw new Error(`${fileName}: more than one Document date line`);
  const line = lines[0];
  if (line === undefined) return null;
  if (!("date" in line)) throw new Error(`${fileName}: the Document date line is a period`);
  return line.date;
}

const months = {
  de: [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};

/** Formats an ISO date without Intl, so the output never depends on the machine's locale. */
function formatDate(iso: string, style: DateStyle, language: Language): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  const name = months[language][month - 1]!;
  switch (style) {
    case "dot":
      return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
    case "short":
      return `${day} ${name.slice(0, 3)} ${year}`;
    case "iso":
      return iso;
    case "long":
      return language === "de" ? `${day}. ${name} ${year}` : `${name} ${day}, ${year}`;
  }
}

function formatMoney(cents: number, language: Language): string {
  const whole = String(Math.trunc(cents / 100)).replace(
    /\B(?=(\d{3})+$)/g,
    language === "de" ? "." : ",",
  );
  const fraction = String(cents % 100).padStart(2, "0");
  return language === "de" ? `${whole},${fraction} €` : `EUR ${whole}.${fraction}`;
}

const labels = {
  de: {
    item: "Beschreibung",
    amount: "Betrag",
    net: "Nettobetrag",
    vat: "USt.",
    total: "Gesamtbetrag",
    taxId: "USt-IdNr.",
    fake: ["Fiktives Unternehmen, synthetische Testdaten.", "Keine echte Rechnung."],
  },
  en: {
    item: "Description",
    amount: "Amount",
    net: "Net amount",
    vat: "VAT",
    total: "Total",
    taxId: "VAT no.",
    fake: ["Fictitious company, synthetic test data.", "Not a real invoice."],
  },
};

type Style = "title" | "heading" | "bold" | "body";

/** A printed line: `left` text, optional right-hand amount column, and its weight. */
interface Row {
  left: string;
  right?: string;
  style?: Style;
}

/** PDF font and size, scan glyph scale per row style. */
const pdfFont: Record<Style, readonly ["F1" | "F2", number]> = {
  title: ["F2", 16],
  heading: ["F2", 14],
  bold: ["F2", 10],
  body: ["F1", 10],
};
const scanScale: Record<Style, number> = { title: 5, heading: 4, bold: 3, body: 3 };

function rows(invoice: Invoice): Row[] {
  const { language: lang } = invoice;
  const label = labels[lang];
  const format = (iso: string) => formatDate(iso, invoice.dateStyle, lang);
  const net = invoice.items.reduce((sum, item) => sum + item.cents, 0);
  const tax = Math.round((net * invoice.vat) / 100);
  return [
    { left: invoice.seller.name, style: "title" },
    { left: invoice.seller.address },
    { left: "" },
    ...invoice.buyer.map((left) => ({ left })),
    { left: "" },
    { left: invoice.title, style: "heading" },
    ...(invoice.reference === undefined ? [] : [{ left: invoice.reference }]),
    ...invoice.dates.map((line) => ({
      left: `${line.label}: ${"date" in line ? format(line.date) : `${format(line.from)} – ${format(line.to)}`}`,
    })),
    { left: "" },
    { left: label.item, right: label.amount, style: "bold" },
    ...invoice.items.map((item) => ({
      left: item.description,
      right: formatMoney(item.cents, lang),
    })),
    { left: "" },
    ...(invoice.vat === 0
      ? []
      : [
          { left: label.net, right: formatMoney(net, lang) },
          { left: `${label.vat} ${invoice.vat} %`, right: formatMoney(tax, lang) },
        ]),
    { left: label.total, right: formatMoney(net + tax, lang), style: "bold" },
    { left: "" },
    ...invoice.notes.map((left) => ({ left })),
    { left: "" },
    { left: `IBAN: ${invoice.seller.iban}` },
    { left: `${label.taxId}: ${invoice.seller.taxId}` },
    ...label.fake.map((left) => ({ left })),
  ];
}

/**
 * The invoice's printed text, one string per row (`left` and amount). Scans draw these rows in the
 * bitmap font, i.e. upper case with `ß` → `SS` and `€` → `EUR` (see `glyphText`).
 */
export function printedLines(invoice: Invoice): string[] {
  return rows(invoice).map((row) =>
    row.right === undefined ? row.left : `${row.left} ${row.right}`,
  );
}

/** Draws the seller's name as a banner; 8-bit grey keeps every text PDF above the 20 KB floor. */
function letterhead(name: string): Bitmap {
  const banner = new Bitmap(640, 96);
  banner.fillRect(0, 88, 640, 4);
  banner.drawText(8, 24, name, 4);
  return banner;
}

/** A text PDF: real text in Helvetica under a raster letterhead. */
export function invoicePdf(invoice: Invoice): Uint8Array {
  const banner = letterhead(invoice.seller.name);
  const ops = ["q 320 0 0 48 56 770 cm /Logo Do Q"];
  let y = 730;
  for (const row of rows(invoice)) {
    if (row.left.length > 95) throw new Error(`row too long for the PDF: ${row.left}`);
    const [font, size] = pdfFont[row.style ?? "body"];
    if (row.left !== "") ops.push(showText(font, size, 56, y, row.left));
    if (row.right !== undefined) ops.push(showText(font, size, 430, y, row.right));
    y -= size + 6;
  }
  return writePdf({ content: ops.join("\n"), images: { Logo: banner.gray(8) } });
}

/** The invoice as a 1000 × 1414 black-and-white scan; body glyphs are 21 px tall. */
function scanBitmap(invoice: Invoice): Bitmap {
  const page = new Bitmap(1000, 1414);
  const margin = 70;
  const amountColumn = 690;
  let y = margin;
  for (const row of rows(invoice)) {
    const scale = scanScale[row.style ?? "body"];
    const limit = (row.right === undefined ? page.width - margin : amountColumn - 18) - margin;
    if (textWidth(row.left, scale) > limit)
      throw new Error(`row too wide for the scan: ${row.left}`);
    page.drawText(margin, y, row.left, scale);
    if (row.right !== undefined) page.drawText(amountColumn, y, row.right, scale);
    if (row.style === "bold")
      page.fillRect(margin, y + glyphHeight * scale + 4, page.width - 2 * margin, 2);
    y += glyphHeight * scale + (row.left === "" ? 4 : 14);
  }
  if (y > page.height - margin)
    throw new Error(`invoice too long for one scanned page: ${invoice.title}`);
  return page;
}

export function scanPng(invoice: Invoice): Uint8Array {
  return encodePng({ ...scanBitmap(invoice).gray(1), colorType: 0 });
}

/** An image-only PDF: the scan raster fills the A4 page, there is no text layer. */
export function scanPdf(invoice: Invoice): Uint8Array {
  return writePdf({
    content: "q 595 0 0 842 0 0 cm /Scan Do Q",
    images: { Scan: scanBitmap(invoice).gray(1) },
  });
}
