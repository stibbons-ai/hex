/**
 * A zero-dependency PDF writer for the synthetic Documents: standard Type 1 fonts (Helvetica) in
 * WinAnsiEncoding and uncompressed streams, so the bytes depend only on the input.
 */
import type { GrayImage } from "./raster.ts";

export interface PdfPage {
  /** Content stream operators (ASCII; text via {@link showText}). */
  content: string;
  /** Image XObjects the content draws with `/<name> Do`. */
  images: Readonly<Record<string, GrayImage>>;
}

/** The non-ASCII characters of German and English invoices, mapped to WinAnsiEncoding. */
const winAnsi: Record<string, number> = {
  "€": 0x80,
  "–": 0x96,
  Ä: 0xc4,
  Ö: 0xd6,
  Ü: 0xdc,
  ß: 0xdf,
  ä: 0xe4,
  ö: 0xf6,
  ü: 0xfc,
};

/** A PDF literal string `( … )` in WinAnsiEncoding, non-ASCII bytes as octal escapes. */
function pdfString(text: string): string {
  let out = "(";
  for (const char of text) {
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (char >= " " && char <= "~") out += char;
    else {
      const code = winAnsi[char];
      if (code === undefined) throw new Error(`no WinAnsi code for ${JSON.stringify(char)}`);
      out += `\\${code.toString(8)}`;
    }
  }
  return `${out})`;
}

/** Operators that draw `text` at (x, y) in `/F1` (Helvetica) or `/F2` (Helvetica-Bold). */
export function showText(
  font: "F1" | "F2",
  size: number,
  x: number,
  y: number,
  text: string,
): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET`;
}

function ascii(text: string): Uint8Array {
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error("PDF syntax must be printable ASCII");
  return Buffer.from(text, "latin1");
}

function stream(dictionary: string, data: Uint8Array): Uint8Array {
  return Buffer.concat([
    ascii(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
    data,
    ascii("\nendstream"),
  ]);
}

/** Writes a one-page A4 PDF, with Helvetica as `/F1` and Helvetica-Bold as `/F2`. */
export function writePdf(page: PdfPage): Uint8Array {
  const objects: Uint8Array[] = [];
  const add = (body: Uint8Array | string): number => {
    objects.push(typeof body === "string" ? ascii(body) : body);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pages = add(""); // filled in once the page's id is known
  const regular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const images = Object.entries(page.images).map(([name, image]) => {
    const id = add(
      stream(
        `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent ${image.bitDepth}`,
        Buffer.concat(image.rows),
      ),
    );
    return `/${name} ${id} 0 R`;
  });
  const content = add(stream("", ascii(page.content)));
  const pageId = add(
    `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> /XObject << ${images.join(" ")} >> >> >>`,
  );
  objects[pages - 1] = ascii(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);

  // Header with a binary comment line, so transports treat the file as binary.
  const parts: Uint8Array[] = [
    Buffer.concat([ascii("%PDF-1.4\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")]),
  ];
  let offset = parts[0]!.length;
  const offsets = objects.map((body, index) => {
    const start = offset;
    const object = Buffer.concat([ascii(`${index + 1} 0 obj\n`), body, ascii("\nendobj\n")]);
    parts.push(object);
    offset += object.length;
    return start;
  });
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((start) => `${String(start).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
  ].join("");
  parts.push(ascii(xref));
  return Buffer.concat(parts);
}
