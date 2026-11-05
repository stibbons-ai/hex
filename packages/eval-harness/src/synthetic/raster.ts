import { advance, glyph, glyphHeight, glyphText, glyphWidth } from "./font.ts";

/** Grey raster samples, rows padded to whole bytes, as both the PNG and the PDF writer take them. */
export interface GrayImage {
  width: number;
  height: number;
  bitDepth: 1 | 8;
  rows: readonly Uint8Array[];
}

/** A black-and-white page: one byte per pixel, 1 = ink. */
export class Bitmap {
  readonly ink: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.ink = new Uint8Array(width * height);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      this.ink.fill(
        1,
        row * this.width + Math.max(0, x),
        row * this.width + Math.min(this.width, x + width),
      );
    }
  }

  /** Draws `text` with its top-left corner at (x, y), each font pixel `scale` pixels square. */
  drawText(x: number, y: number, text: string, scale: number): void {
    let left = x;
    for (const char of glyphText(text)) {
      const bitmap = glyph(char);
      const accentRows = bitmap.length - glyphHeight;
      bitmap.forEach((bits, row) => {
        for (let column = 0; column < glyphWidth; column++) {
          if (bits[column] === "1")
            this.fillRect(left + column * scale, y + (row - accentRows) * scale, scale, scale);
        }
      });
      left += advance * scale;
    }
  }

  /**
   * The page as grey samples; 0 is black in both PNG and PDF. 1-bit rows pack pixels most
   * significant bit first; 8-bit rows hold 0 for ink, 255 for paper.
   */
  gray(bitDepth: 1 | 8): GrayImage {
    const rows = Array.from({ length: this.height }, (_, row) => {
      const ink = this.ink.subarray(row * this.width, (row + 1) * this.width);
      if (bitDepth === 8) return ink.map((pixel) => (pixel === 1 ? 0 : 255));
      const out = new Uint8Array(Math.ceil(this.width / 8)).fill(0xff);
      ink.forEach((pixel, column) => {
        if (pixel === 1) out[column >> 3]! &= ~(0x80 >> (column & 7));
      });
      return out;
    });
    return { width: this.width, height: this.height, bitDepth, rows };
  }
}
