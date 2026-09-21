import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA pixels (width*height*4 bytes) → PNG. Dependency-free, so icons can be generated at build time. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1)); // each row: filter byte 0 + pixels
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type RGB = readonly [number, number, number];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sdRoundRect = (x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdSegment = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
};

export interface PhoneIconOptions {
  /** Glyph color: light on a dark menu bar, dark on a light one. */
  fg: RGB;
  /** Status dot in the bottom-right corner; the glyph is cut away around it so it reads on any background. */
  badge?: RGB;
  /** Glyph opacity (0..1), e.g. dimmed when the server is stopped. */
  alpha?: number;
}

/**
 * The tray icon: an outlined phone (the second screen) plus an optional status badge, drawn on a 22-unit grid and
 * rasterised with anti-aliasing. Generated in code so there are no image assets to keep in sync.
 */
export function phoneRgba(size: number, { fg, badge, alpha = 1 }: PhoneIconOptions): Uint8Array {
  const k = size / 22; // grid units → pixels
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x + 0.5) / k;
      const gy = (y + 0.5) / k;
      const outline = Math.abs(sdRoundRect(gx, gy, 10, 10.5, 5, 8.3, 2.4)) - 0.9; // 1.8-unit stroke on the phone edge
      const homeBar = sdSegment(gx, gy, 8.4, 15.4, 11.6, 15.4) - 0.8;
      let glyph = clamp01(0.5 - Math.min(outline, homeBar) * k);
      let badgeA = 0;
      if (badge) {
        const d = Math.hypot(gx - 18.2, gy - 18.2);
        badgeA = clamp01(0.5 - (d - 3.1) * k);
        glyph *= 1 - clamp01(0.5 - (d - 3.9) * k); // knock a thin ring out of the glyph around the badge
      }
      glyph *= alpha;
      const a = badgeA + glyph * (1 - badgeA);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        px[i + c] = a ? Math.round(((badge?.[c] ?? 0) * badgeA + fg[c] * glyph * (1 - badgeA)) / a) : 0;
      }
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

export const phonePng = (size: number, opts: PhoneIconOptions): Buffer => encodePng(size, size, phoneRgba(size, opts));

export const TRAY_COLORS = {
  approval: [239, 68, 68],
  turn: [34, 197, 94],
  working: [245, 165, 36],
  idle: [148, 163, 184],
} as const satisfies Record<string, [number, number, number]>;
