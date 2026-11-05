/**
 * A zero-dependency PNG writer. Image data goes into stored (uncompressed) deflate blocks, so the
 * bytes never depend on a compression library's version.
 */

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** A zlib stream of stored deflate blocks (at most 65535 bytes each). */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let offset = 0; offset < data.length || offset === 0; offset += 0xffff) {
    const chunk = data.subarray(offset, offset + 0xffff);
    const header = new Uint8Array(5);
    const view = new DataView(header.buffer);
    header[0] = offset + 0xffff >= data.length ? 1 : 0; // BFINAL on the last block
    view.setUint16(1, chunk.length, true);
    view.setUint16(3, ~chunk.length & 0xffff, true);
    blocks.push(header, chunk);
  }
  blocks.push(u32(Bun.hash.adler32(data)));
  return Buffer.concat(blocks);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32(data.length), typed, u32(Bun.hash.crc32(typed))]);
}

export interface PngImage {
  width: number;
  height: number;
  bitDepth: 1 | 8;
  /** 0 grey, 6 RGBA. */
  colorType: 0 | 6;
  /** Unfiltered scanlines, already packed for the bit depth and colour type. */
  rows: readonly Uint8Array[];
}

export function encodePng(image: PngImage): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header[8] = image.bitDepth;
  header[9] = image.colorType;
  // Bytes 10–12: deflate, adaptive filtering, no interlace.
  const scanlines = Buffer.concat(image.rows.flatMap((row) => [new Uint8Array([0]), row]));
  return Buffer.concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlibStored(scanlines)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
