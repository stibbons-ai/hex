/**
 * A zero-dependency PDF writer for the synthetic Documents: standard Type 1 fonts (Helvetica) in
 * WinAnsiEncoding and uncompressed streams, so the bytes depend only on the input.
 */

/** Raw image samples, rows padded to whole bytes; grey only. */
export interface PdfImage {
  width: number;
  height: number;
  bitsPerComponent: 1 | 8;
  rows: readonly Uint8Array[];
}

export interface PdfPage {
  /** Content stream operators (ASCII; build strings with {@link pdfString}). */
  content: string;
  /** Image XObjects the content draws with `/<name> Do`. */
  images?: Readonly<Record<string, PdfImage>>;
}

/** The characters beyond ASCII the synthetic invoices use, mapped to WinAnsiEncoding. */
const winAnsi: Record<string, number> = {
  "€": 0x80,
  "–": 0x96,
  "·": 0xb7,
  Ä: 0xc4,
  Ö: 0xd6,
  Ü: 0xdc,
  ß: 0xdf,
  ä: 0xe4,
  ö: 0xf6,
  ü: 0xfc,
  é: 0xe9,
};

/** A PDF literal string `( … )` in WinAnsiEncoding, non-ASCII bytes as octal escapes. */
export function pdfString(text: string): string {
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

/** Writes a PDF of `pages` (A4 portrait), with Helvetica as `/F1` and Helvetica-Bold as `/F2`. */
export function writePdf(pages: readonly PdfPage[]): Uint8Array {
  const objects: Uint8Array[] = [];
  const add = (body: Uint8Array | string): number => {
    objects.push(typeof body === "string" ? ascii(body) : body);
    return objects.length;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = add(""); // filled in once the page ids are known
  const regular = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const bold = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  const pageIds = pages.map((page) => {
    const images = Object.entries(page.images ?? {}).map(([name, image]) => {
      const id = add(
        stream(
          `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceGray /BitsPerComponent ${image.bitsPerComponent}`,
          Buffer.concat(image.rows),
        ),
      );
      return `/${name} ${id} 0 R`;
    });
    const content = add(stream("", ascii(page.content)));
    return add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> /XObject << ${images.join(" ")} >> >> >>`,
    );
  });
  objects[pagesId - 1] = ascii(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
  );

  // Header with a binary comment line, so transports treat the file as binary.
  const parts: Uint8Array[] = [
    ascii("%PDF-1.4\n%"),
    new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]),
    ascii("\n"),
  ];
  let offset = parts.reduce((sum, part) => sum + part.length, 0);
  const offsets = objects.map((body, index) => {
    const start = offset;
    const object = [ascii(`${index + 1} 0 obj\n`), body, ascii("\nendobj\n")];
    parts.push(...object);
    offset += object.reduce((sum, part) => sum + part.length, 0);
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
