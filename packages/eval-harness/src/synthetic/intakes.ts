/**
 * The synthetic Intakes: every company, address, number, IBAN and tax ID is fictitious. Each Intake
 * is the single source of truth for both its `.eml` and its `expected.json` entry.
 */
import type { Invoice, Language } from "./invoice.ts";

export type Attachment =
  /** Documents: a text PDF, a scanned PNG, an image-only PDF. */
  | { kind: "pdf" | "scan-png" | "scan-pdf"; fileName: string; invoice: Invoice }
  /** HTML decoration referenced as `cid:`: `inline` logo, Outlook-style signature marked `attachment`, tracking pixel. */
  | { kind: "logo" | "signature"; fileName: string; contentId: string; text: string }
  | { kind: "pixel"; fileName: string; contentId: string }
  /** Neither PDF nor image. */
  | { kind: "file"; fileName: string; contentType: string; content: string };

export interface SyntheticIntake {
  slug: string;
  description: string;
  language: Language;
  from: string;
  subject: string;
  /** Mail `Date:` as `YYYY-MM-DDTHH:MM:SS±HH:MM`. */
  sent: string;
  text: string;
  /** HTML alternative; it references every `cid:` attachment. */
  html?: string;
  attachments: readonly Attachment[];
}

/** The `To:` of every Intake. */
export const recipient = "Erika Mustermann <erika.mustermann@hex.example>";
const buyerDe = ["Erika Mustermann", "Beispielallee 42", "12345 Musterstadt"];
const buyerEn = ["Erika Mustermann", "42 Sample Lane", "Testville TV1 0AA"];

const buerobedarf = {
  name: "Beispiel Bürobedarf GmbH",
  address: "Musterstraße 1, 12345 Musterstadt",
  iban: "DE00 0000 0000 0000 0000 00",
  taxId: "DE000000000",
};
const cloudHosting = {
  name: "Example Cloud Hosting Ltd",
  address: "1 Example Road, Sampletown AB1 2CD, UK",
  iban: "GB00 TEST 0000 0000 0000 00",
  taxId: "GB000000000",
};
const werkstatt = {
  name: "Musterwerkstatt Beispiel",
  address: "Beispielweg 7, 54321 Beispielstadt",
  iban: "DE00 1111 1111 1111 1111 11",
  taxId: "DE111111111",
};
const stadtwerke = {
  name: "Stadtwerke Beispielstadt",
  address: "Am Fiktivpark 3, 54321 Beispielstadt",
  iban: "DE00 2222 2222 2222 2222 22",
  taxId: "DE222222222",
};
const printCo = {
  name: "Placeholder Print Co.",
  address: "99 Sample Street, Testville TV9 9ZZ, UK",
  iban: "GB00 TEST 1111 1111 1111 11",
  taxId: "GB111111111",
};
const software = {
  name: "Muster Software UG",
  address: "Testgasse 5, 10115 Beispielhausen",
  iban: "DE00 3333 3333 3333 3333 33",
  taxId: "DE333333333",
};
const consulting = {
  name: "Demo Consulting LLC",
  address: "123 Fake Avenue, Example City, EX 00000",
  iban: "US00 TEST 0000 0000 0000",
  taxId: "00-0000000",
};

const signatureDe = "Mit freundlichen Grüßen\nIhr Team";
const signatureEn = "Kind regards\nThe team";

export const intakes: readonly SyntheticIntake[] = [
  {
    slug: "de-pdf-invoice",
    description:
      "German mail, German text PDF invoice; Rechnungsdatum 02.11.2026 beside Leistungsdatum and Fälligkeitsdatum.",
    language: "de",
    from: "Beispiel Bürobedarf GmbH <rechnung@buerobedarf.example>",
    subject: "Ihre Rechnung RE-2026-1042",
    sent: "2026-11-02T09:14:00+01:00",
    text: `Guten Tag Frau Mustermann,\n\nanbei erhalten Sie Ihre Rechnung RE-2026-1042 zu Ihrer Bestellung vom 28.10.2026.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "Rechnung-RE-2026-1042.pdf",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: buerobedarf,
          buyer: buyerDe,
          reference: "Rechnungsnummer: RE-2026-1042",
          dateStyle: "dot",
          dates: [
            { label: "Rechnungsdatum", date: "2026-11-02", document: true },
            { label: "Leistungsdatum", date: "2026-10-30" },
            { label: "Fälligkeitsdatum", date: "2026-11-16" },
          ],
          items: [
            { description: "Kopierpapier A4, 10 Pakete", cents: 4990 },
            { description: "Kugelschreiber blau, 20 Stück", cents: 1580 },
          ],
          vat: 19,
          notes: ["Zahlbar ohne Abzug bis zum 16.11.2026."],
        },
      },
    ],
  },
  {
    slug: "en-pdf-invoice",
    description:
      "English mail, English text PDF invoice; Invoice date 2 Nov 2026 beside a Service period (October) and a Due date.",
    language: "en",
    from: "Example Cloud Hosting <billing@cloudhosting.example>",
    subject: "Your invoice INV-2026-0815",
    sent: "2026-11-03T07:30:00+00:00",
    text: `Hello Erika,\n\nyour invoice INV-2026-0815 for October is attached. It will be charged on 16 Nov 2026.\n\n${signatureEn}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "INV-2026-0815.pdf",
        invoice: {
          language: "en",
          title: "Invoice",
          seller: cloudHosting,
          buyer: buyerEn,
          reference: "Invoice no.: INV-2026-0815",
          dateStyle: "short",
          dates: [
            { label: "Invoice date", date: "2026-11-02", document: true },
            { label: "Service period", from: "2026-10-01", to: "2026-10-31" },
            { label: "Due date", date: "2026-11-16" },
          ],
          items: [
            { description: "Virtual server S, October", cents: 1200 },
            { description: "Backup storage 50 GB", cents: 250 },
          ],
          vat: 20,
          notes: ["Payment by card on the due date."],
        },
      },
    ],
  },
  {
    slug: "de-iso-date",
    description:
      "German text PDF with ISO dates: Rechnungsdatum 2026-10-14 beside Bestelldatum and Lieferdatum.",
    language: "de",
    from: "Muster Software UG <buchhaltung@muster-software.example>",
    subject: "Rechnung 2026-0457",
    sent: "2026-10-14T16:45:00+02:00",
    text: `Hallo,\n\ndie Rechnung 2026-0457 liegt bei.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "Rechnung_2026-0457.pdf",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: software,
          buyer: buyerDe,
          reference: "Rechnungsnummer: 2026-0457",
          dateStyle: "iso",
          dates: [
            { label: "Bestelldatum", date: "2026-10-05" },
            { label: "Lieferdatum", date: "2026-10-12" },
            { label: "Rechnungsdatum", date: "2026-10-14", document: true },
          ],
          items: [{ description: "Jahreslizenz Musterplaner", cents: 23900 }],
          vat: 19,
          notes: ["Zahlbar innerhalb von 14 Tagen."],
        },
      },
    ],
  },
  {
    slug: "de-long-date",
    description:
      "German text PDF with a written-out date: Rechnungsdatum 2. September 2026, printed after the Fälligkeitsdatum.",
    language: "de",
    from: "Stadtwerke Beispielstadt <service@stadtwerke-beispielstadt.example>",
    subject: "Abschlagsrechnung September 2026",
    sent: "2026-09-02T06:00:00+02:00",
    text: `Sehr geehrte Frau Mustermann,\n\nanbei Ihre Abschlagsrechnung für September.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "Abschlagsrechnung-2026-09.pdf",
        invoice: {
          language: "de",
          title: "Abschlagsrechnung",
          seller: stadtwerke,
          buyer: buyerDe,
          reference: "Vertragskonto: 000 000 000",
          dateStyle: "long",
          dates: [
            { label: "Fälligkeitsdatum", date: "2026-09-15" },
            { label: "Rechnungsdatum", date: "2026-09-02", document: true },
            { label: "Abrechnungszeitraum", from: "2026-09-01", to: "2026-09-30" },
          ],
          items: [
            { description: "Abschlag Strom", cents: 6500 },
            { description: "Abschlag Wasser", cents: 2500 },
          ],
          vat: 19,
          notes: ["Der Betrag wird am 15. September 2026 abgebucht."],
        },
      },
    ],
  },
  {
    slug: "en-month-boundary",
    description:
      "Month-boundary trap: mail Date 1 Oct 2026, Document date September 30, 2026 (long English format), Delivery date and Due date in October.",
    language: "en",
    from: "Placeholder Print Co. <accounts@placeholder-print.example>",
    subject: "Invoice PP-3301",
    sent: "2026-10-01T08:02:00+01:00",
    text: `Dear Erika,\n\nplease find invoice PP-3301 attached.\n\n${signatureEn}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "PP-3301.pdf",
        invoice: {
          language: "en",
          title: "Invoice",
          seller: printCo,
          buyer: buyerEn,
          reference: "Invoice no.: PP-3301",
          dateStyle: "long",
          dates: [
            { label: "Invoice date", date: "2026-09-30", document: true },
            { label: "Delivery date", date: "2026-10-02" },
            { label: "Due date", date: "2026-10-30" },
          ],
          items: [{ description: "Business cards, 500 pcs", cents: 4500 }],
          vat: 20,
          notes: ["Payment within 30 days."],
        },
      },
    ],
  },
  {
    slug: "de-scan-png",
    description:
      "Scanned German invoice as a PNG raster (no text layer); Rechnungsdatum 18.08.2026 beside Leistungsdatum and Fälligkeitsdatum.",
    language: "de",
    from: "Musterwerkstatt Beispiel <werkstatt@musterwerkstatt.example>",
    subject: "Scan Ihrer Rechnung",
    sent: "2026-08-21T11:20:00+02:00",
    text: `Hallo Frau Mustermann,\n\nwie besprochen der Scan der Rechnung.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "scan-png",
        fileName: "Scan-Rechnung-W-778.png",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: werkstatt,
          buyer: buyerDe,
          reference: "Rechnungsnummer: W-778",
          dateStyle: "dot",
          dates: [
            { label: "Rechnungsdatum", date: "2026-08-18", document: true },
            { label: "Leistungsdatum", date: "2026-08-14" },
            { label: "Fälligkeitsdatum", date: "2026-09-01" },
          ],
          items: [
            { description: "Inspektion", cents: 18900 },
            { description: "Ölwechsel", cents: 7450 },
          ],
          vat: 19,
          notes: ["Bitte überweisen bis 01.09.2026."],
        },
      },
    ],
  },
  {
    slug: "en-scan-pdf",
    description:
      "Scanned English invoice as an image-only PDF (no text layer); Invoice date 7 Aug 2026 beside Delivery date and Due date.",
    language: "en",
    from: "Demo Consulting <office@demo-consulting.example>",
    subject: "Scanned invoice DC-0092",
    sent: "2026-08-10T15:05:00-04:00",
    text: `Hi Erika,\n\nattached is the scanned invoice DC-0092.\n\n${signatureEn}`,
    attachments: [
      {
        kind: "scan-pdf",
        fileName: "scan-0001.pdf",
        invoice: {
          language: "en",
          title: "Invoice",
          seller: consulting,
          buyer: buyerEn,
          reference: "Invoice no.: DC-0092",
          dateStyle: "short",
          dates: [
            { label: "Invoice date", date: "2026-08-07", document: true },
            { label: "Delivery date", date: "2026-08-03" },
            { label: "Due date", date: "2026-09-06" },
          ],
          items: [{ description: "Workshop, 1 day", cents: 120000 }],
          vat: 0,
          notes: ["Net 30."],
        },
      },
    ],
  },
  {
    slug: "de-inline-logo",
    description:
      "HTML mail with an inline logo (cid:, Content-Disposition inline, over 20 KB) that is not a Document, plus a text PDF invoice dated 27.10.2026.",
    language: "de",
    from: "Beispiel Bürobedarf GmbH <rechnung@buerobedarf.example>",
    subject: "Rechnung RE-2026-1077",
    sent: "2026-10-27T10:00:00+01:00",
    text: `Guten Tag,\n\nanbei Ihre Rechnung RE-2026-1077.\n\n${signatureDe}`,
    html: `<html><body><p><img src="cid:logo.1077@buerobedarf.example" alt="Beispiel Bürobedarf"></p><p>Guten Tag,</p><p>anbei Ihre Rechnung RE-2026-1077.</p><p>Mit freundlichen Grüßen<br>Ihr Team</p></body></html>`,
    attachments: [
      {
        kind: "logo",
        fileName: "logo.png",
        contentId: "logo.1077@buerobedarf.example",
        text: "Bürobedarf",
      },
      {
        kind: "pdf",
        fileName: "Rechnung-RE-2026-1077.pdf",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: buerobedarf,
          buyer: buyerDe,
          reference: "Rechnungsnummer: RE-2026-1077",
          dateStyle: "dot",
          dates: [
            { label: "Rechnungsdatum", date: "2026-10-27", document: true },
            { label: "Lieferdatum", date: "2026-10-23" },
          ],
          items: [{ description: "Bürostuhl Modell Muster", cents: 18900 }],
          vat: 19,
          notes: ["Zahlbar bis 10.11.2026."],
        },
      },
    ],
  },
  {
    slug: "en-outlook-signature",
    description:
      "Outlook-style HTML mail: the signature image is referenced via cid: but marked Content-Disposition attachment (over 20 KB, not a Document); text PDF invoice dated 15 Sep 2026.",
    language: "en",
    from: "Demo Consulting <office@demo-consulting.example>",
    subject: "Invoice DC-0101",
    sent: "2026-09-15T17:40:00-04:00",
    text: `Hi Erika,\n\nplease see invoice DC-0101 attached.\n\n${signatureEn}`,
    html: `<html><body><p>Hi Erika,</p><p>please see invoice DC-0101 attached.</p><p>Kind regards</p><p><img src="cid:image001.png@01DC0000.00000000" alt="Demo Consulting"></p></body></html>`,
    attachments: [
      {
        kind: "signature",
        fileName: "image001.png",
        contentId: "image001.png@01DC0000.00000000",
        text: "Demo Consulting",
      },
      {
        kind: "pdf",
        fileName: "Invoice_DC-0101.pdf",
        invoice: {
          language: "en",
          title: "Invoice",
          seller: consulting,
          buyer: buyerEn,
          reference: "Invoice no.: DC-0101",
          dateStyle: "short",
          dates: [
            { label: "Invoice date", date: "2026-09-15", document: true },
            { label: "Service period", from: "2026-09-01", to: "2026-09-12" },
            { label: "Due date", date: "2026-10-15" },
          ],
          items: [{ description: "Advisory, 6 hours", cents: 90000 }],
          vat: 0,
          notes: ["Net 30."],
        },
      },
    ],
  },
  {
    slug: "de-tracking-pixel",
    description:
      "HTML mail with a 1×1 tracking pixel (cid:) that is not a Document, plus a text PDF invoice dated 06.07.2026.",
    language: "de",
    from: "Muster Software UG <buchhaltung@muster-software.example>",
    subject: "Ihre Rechnung 2026-0311 ist da",
    sent: "2026-07-06T09:00:00+02:00",
    text: `Hallo,\n\nIhre Rechnung 2026-0311 ist da.\n\n${signatureDe}`,
    html: `<html><body><p>Hallo,</p><p>Ihre Rechnung 2026-0311 ist da.</p><img src="cid:open.2026-0311@muster-software.example" width="1" height="1" alt=""></body></html>`,
    attachments: [
      { kind: "pixel", fileName: "pixel.png", contentId: "open.2026-0311@muster-software.example" },
      {
        kind: "pdf",
        fileName: "Rechnung_2026-0311.pdf",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: software,
          buyer: buyerDe,
          reference: "Rechnungsnummer: 2026-0311",
          dateStyle: "dot",
          dates: [
            { label: "Rechnungsdatum", date: "2026-07-06", document: true },
            { label: "Leistungszeitraum", from: "2026-06-01", to: "2026-06-30" },
          ],
          items: [{ description: "Support-Paket Juni", cents: 4900 }],
          vat: 19,
          notes: ["Zahlbar innerhalb von 14 Tagen."],
        },
      },
    ],
  },
  {
    slug: "en-zero-documents-ics",
    description:
      "Zero-Document Intake: only a calendar invite (.ics, neither PDF nor image); the body mentions a date.",
    language: "en",
    from: "Example Cloud Hosting <events@cloudhosting.example>",
    subject: "Maintenance window on 12 Nov 2026",
    sent: "2026-11-04T12:00:00+00:00",
    text: `Hello Erika,\n\nplanned maintenance on 12 Nov 2026, 02:00-04:00 UTC. The invite is attached.\n\n${signatureEn}`,
    attachments: [
      {
        kind: "file",
        fileName: "maintenance.ics",
        contentType: "text/calendar; method=PUBLISH",
        content: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//hex//synthetic fixtures//EN",
          "BEGIN:VEVENT",
          "UID:maintenance-2026-11-12@cloudhosting.example",
          "DTSTAMP:20261104T120000Z",
          "DTSTART:20261112T020000Z",
          "DTEND:20261112T040000Z",
          "SUMMARY:Planned maintenance",
          "END:VEVENT",
          "END:VCALENDAR",
          "",
        ].join("\r\n"),
      },
    ],
  },
  {
    slug: "de-zero-documents-plain",
    description:
      "Zero-Document Intake: a plain-text mail without attachments that mentions invoice dates.",
    language: "de",
    from: "Stadtwerke Beispielstadt <service@stadtwerke-beispielstadt.example>",
    subject: "Ihre Jahresabrechnung folgt",
    sent: "2026-10-20T08:30:00+02:00",
    text: `Sehr geehrte Frau Mustermann,\n\nIhre Jahresabrechnung vom 01.10.2026 senden wir Ihnen bis zum 15.11.2026 per Post.\n\n${signatureDe}`,
    attachments: [],
  },
  {
    slug: "de-multiple-documents",
    description:
      "Three Documents in one Intake (invoice PDF 12.06.2026, credit note PDF 10.06.2026, scanned receipt PNG 2026-06-09) plus a .txt note that is not a Document.",
    language: "de",
    from: "Beispiel Bürobedarf GmbH <rechnung@buerobedarf.example>",
    subject: "Rechnung, Gutschrift und Beleg",
    sent: "2026-06-12T13:15:00+02:00",
    text: `Guten Tag,\n\nanbei Rechnung, Gutschrift und der Kassenbeleg sowie unsere Hinweise.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "Rechnung-RE-2026-0612.pdf",
        invoice: {
          language: "de",
          title: "Rechnung",
          seller: buerobedarf,
          buyer: buyerDe,
          reference: "Rechnungsnummer: RE-2026-0612",
          dateStyle: "dot",
          dates: [
            { label: "Rechnungsdatum", date: "2026-06-12", document: true },
            { label: "Fälligkeitsdatum", date: "2026-06-26" },
          ],
          items: [{ description: "Aktenordner, 12 Stück", cents: 3588 }],
          vat: 19,
          notes: ["Zahlbar bis 26.06.2026."],
        },
      },
      {
        kind: "pdf",
        fileName: "Gutschrift-GS-2026-0031.pdf",
        invoice: {
          language: "de",
          title: "Gutschrift",
          seller: buerobedarf,
          buyer: buyerDe,
          reference: "Gutschriftsnummer: GS-2026-0031",
          dateStyle: "long",
          dates: [
            { label: "Datum", date: "2026-06-10", document: true },
            { label: "Zur Rechnung vom", date: "2026-05-28" },
          ],
          items: [{ description: "Rücksendung Locher", cents: 1290 }],
          vat: 19,
          notes: ["Der Betrag wird mit der nächsten Rechnung verrechnet."],
        },
      },
      {
        kind: "scan-png",
        fileName: "Kassenbeleg.png",
        invoice: {
          language: "de",
          title: "Kassenbeleg",
          seller: buerobedarf,
          buyer: ["Barverkauf"],
          reference: "Beleg-Nr.: K-55012",
          dateStyle: "iso",
          dates: [{ label: "Datum", date: "2026-06-09", document: true }],
          items: [{ description: "Tesafilm, 6 Rollen", cents: 899 }],
          vat: 19,
          notes: ["Bar bezahlt."],
        },
      },
      {
        kind: "file",
        fileName: "Hinweise.txt",
        contentType: "text/plain; charset=utf-8",
        content: "Hinweise zur Rücksendung: bitte Originalverpackung verwenden.\r\n",
      },
    ],
  },
  {
    slug: "de-undated-document",
    description:
      "A Document that carries no date at all (cost estimate PDF): documentDate is null, Filing must fall back to the received date.",
    language: "de",
    from: "Musterwerkstatt Beispiel <werkstatt@musterwerkstatt.example>",
    subject: "Kostenvoranschlag",
    sent: "2026-10-01T09:30:00+02:00",
    text: `Hallo Frau Mustermann,\n\nanbei der Kostenvoranschlag wie besprochen.\n\n${signatureDe}`,
    attachments: [
      {
        kind: "pdf",
        fileName: "Kostenvoranschlag.pdf",
        invoice: {
          language: "de",
          title: "Kostenvoranschlag",
          seller: werkstatt,
          buyer: buyerDe,
          dateStyle: "dot",
          dates: [],
          items: [
            { description: "Bremsbeläge vorne", cents: 14900 },
            { description: "Arbeitszeit, 1,5 Stunden", cents: 13500 },
          ],
          vat: 19,
          notes: ["Unverbindlich, gültig vier Wochen ab Erstellung."],
        },
      },
    ],
  },
];
