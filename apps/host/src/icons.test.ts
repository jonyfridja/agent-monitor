import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { phonePng, TRAY_COLORS } from './icons.ts';

/** Minimal decoder for the PNGs our own encoder writes (8-bit RGBA, filter 0). */
function decode(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') [width, height] = [data.readUInt32BE(0), data.readUInt32BE(4)];
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const px = (x: number, y: number) => [0, 1, 2, 3].map((c) => raw[y * stride + 1 + x * 4 + c]);
  return { width, height, px };
}

const S = 36;
const at = (gx: number, gy: number) => [Math.floor((gx * S) / 22), Math.floor((gy * S) / 22)] as const; // grid → pixel

test('phone glyph is a valid PNG of the requested size', () => {
  const { width, height } = decode(phonePng(S, { fg: [255, 255, 255] }));
  assert.equal(width, S);
  assert.equal(height, S);
});

test('the glyph uses the given foreground color and leaves the screen and outside transparent', () => {
  const img = decode(phonePng(S, { fg: [10, 20, 30] }));
  const edge = img.px(...at(5, 10.5)); // on the phone's left edge
  assert.deepEqual(edge.slice(0, 3), [10, 20, 30]);
  assert.ok(edge[3] > 200, 'edge is opaque');
  assert.equal(img.px(...at(10, 8))[3], 0, 'inside the screen is transparent');
  assert.equal(img.px(...at(1, 1))[3], 0, 'outside is transparent');
});

test('the status badge is drawn in its color, with the glyph cut away around it', () => {
  const badge = TRAY_COLORS.approval;
  const withBadge = decode(phonePng(S, { fg: [255, 255, 255], badge }));
  const dot = withBadge.px(...at(18.2, 18.2));
  assert.deepEqual(dot.slice(0, 3), [...badge]);
  assert.equal(dot[3], 255);
  // The phone's bottom-right tip sits under the badge ring: it must be knocked out, not overlapping it.
  const ring = withBadge.px(...at(15, 17));
  assert.ok(ring[3] < 40, `expected a gap around the badge, got alpha ${ring[3]}`);
  // Without a badge that same corner is part of the outline.
  const plain = decode(phonePng(S, { fg: [255, 255, 255] }));
  assert.ok(plain.px(...at(15, 17))[3] > 200);
});

test('alpha dims the glyph (stopped server) and each status color is distinct', () => {
  const dim = decode(phonePng(S, { fg: [255, 255, 255], alpha: 0.5 })).px(...at(5, 10.5));
  assert.ok(dim[3] > 100 && dim[3] < 140, `alpha ${dim[3]}`);
  const colors = new Set(Object.values(TRAY_COLORS).map((c) => c.join(',')));
  assert.equal(colors.size, 4);
});
