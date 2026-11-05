import { glyph, glyphHeight, glyphText, glyphWidth } from "./font.ts";

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
      glyph(char).forEach((bits, row) => {
        for (let column = 0; column < glyphWidth; column++) {
          if (bits[column] === "1")
            this.fillRect(left + column * scale, y + row * scale, scale, scale);
        }
      });
      left += (glyphWidth + 1) * scale;
    }
  }

  static textWidth(text: string, scale: number): number {
    return glyphText(text).length * (glyphWidth + 1) * scale;
  }

  static textHeight(scale: number): number {
    return glyphHeight * scale;
  }

  /** Rows of 1-bit grey, most significant bit first, padded to whole bytes; 0 = black (PNG and PDF agree). */
  toGray1(): Uint8Array[] {
    const rowBytes = Math.ceil(this.width / 8);
    return Array.from({ length: this.height }, (_, row) => {
      const out = new Uint8Array(rowBytes).fill(0xff);
      for (let column = 0; column < this.width; column++) {
        if (this.ink[row * this.width + column] === 1) out[column >> 3]! &= ~(0x80 >> (column & 7));
      }
      return out;
    });
  }

  /** Rows of 8-bit grey: 0 = ink, 255 = paper. */
  toGray8(): Uint8Array[] {
    return Array.from({ length: this.height }, (_, row) =>
      this.ink
        .subarray(row * this.width, (row + 1) * this.width)
        .map((ink) => (ink === 1 ? 0 : 255)),
    );
  }
}
