/**
 * The fake invoices: one model, rendered either as a text PDF or as a scan (PNG raster or an
 * image-only PDF wrapping the same raster).
 */
import { encodePng } from "./png.ts";
import { pdfString, writePdf } from "./pdf.ts";
import { Bitmap } from "./raster.ts";

export type Language = "de" | "en";

/**
 * How dates print: `dot` 02.11.2026, `short` 2 Nov 2026, `iso` 2026-11-02,
 * `long` 2. November 2026 (de) or November 2, 2026 (en).
 */
export type DateStyle = "dot" | "short" | "iso" | "long";

/** One labelled date line; `document` marks the Document date, every other line is a distractor. */
export type DateLine =
  | { label: string; date: string; document?: true }
  | { label: string; from: string; to: string };

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
  /** VAT rate in percent; 0 prints no VAT line. */
  vat: number;
  /** Closing lines below the totals (payment terms, notes). */
  notes: readonly string[];
}

/** The Document date (ISO), or `null` when the invoice prints none. */
export function documentDate(invoice: Invoice): string | null {
  const line = invoice.dates.find((date) => "document" in date && date.document);
  return line !== undefined && "date" in line ? line.date : null;
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
export function formatDate(iso: string, style: DateStyle, language: Language): string {
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

/** A printed line: `left` text, optional right-hand amount column, and its weight. */
interface Row {
  left: string;
  right?: string;
  style?: "title" | "heading" | "bold";
}

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
    { left: label.item, right: label.amount, style: "bold" as const },
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
    { left: label.total, right: formatMoney(net + tax, lang), style: "bold" as const },
    { left: "" },
    ...invoice.notes.map((left) => ({ left })),
    { left: "" },
    { left: `IBAN: ${invoice.seller.iban}` },
    { left: `${label.taxId}: ${invoice.seller.taxId}` },
    ...label.fake.map((left) => ({ left })),
  ];
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
    const [font, size] =
      row.style === "title"
        ? ["F2", 16]
        : row.style === "heading"
          ? ["F2", 14]
          : row.style === "bold"
            ? ["F2", 10]
            : ["F1", 10];
    if (row.left !== "") ops.push(`BT /${font} ${size} Tf 56 ${y} Td ${pdfString(row.left)} Tj ET`);
    if (row.right !== undefined)
      ops.push(`BT /${font} ${size} Tf 430 ${y} Td ${pdfString(row.right)} Tj ET`);
    y -= size + 6;
  }
  return writePdf([
    {
      content: ops.join("\n"),
      images: {
        Logo: {
          width: banner.width,
          height: banner.height,
          bitsPerComponent: 8,
          rows: banner.toGray8(),
        },
      },
    },
  ]);
}

/** The invoice as a 1000 × 1414 black-and-white scan; body glyphs are 21 px tall. */
function scanBitmap(invoice: Invoice): Bitmap {
  const page = new Bitmap(1000, 1414);
  const margin = 70;
  const amountColumn = 690;
  let y = margin;
  for (const row of rows(invoice)) {
    const scale = row.style === "title" ? 5 : row.style === "heading" ? 4 : 3;
    const limit = (row.right === undefined ? page.width - margin : amountColumn - 18) - margin;
    if (Bitmap.textWidth(row.left, scale) > limit)
      throw new Error(`row too wide for the scan: ${row.left}`);
    page.drawText(margin, y, row.left, scale);
    if (row.right !== undefined) page.drawText(amountColumn, y, row.right, scale);
    if (row.style === "bold")
      page.fillRect(margin, y + Bitmap.textHeight(scale) + 4, page.width - 2 * margin, 2);
    y += Bitmap.textHeight(scale) + (row.left === "" ? 4 : 14);
  }
  if (y > page.height - margin)
    throw new Error(`invoice too long for one scanned page: ${invoice.title}`);
  return page;
}

export function scanPng(invoice: Invoice): Uint8Array {
  const page = scanBitmap(invoice);
  return encodePng({
    width: page.width,
    height: page.height,
    bitDepth: 1,
    colorType: 0,
    rows: page.toGray1(),
  });
}

/** An image-only PDF: the scan raster fills the A4 page, there is no text layer. */
export function scanPdf(invoice: Invoice): Uint8Array {
  const page = scanBitmap(invoice);
  return writePdf([
    {
      content: "q 595 0 0 842 0 0 cm /Scan Do Q",
      images: {
        Scan: { width: page.width, height: page.height, bitsPerComponent: 1, rows: page.toGray1() },
      },
    },
  ]);
}
